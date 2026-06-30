import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { randomUUID } from 'node:crypto';
import { Router, json } from 'express';
import { createRemoteJWKSet } from 'jose';
import { verifyStepUp, StepUpError } from './verifyStepUp';
import {
  isEligibleToBorrow,
  borrowableGrants,
  type Reach,
} from './eligibility';
import {
  buildActivationManifest,
  getPersonGrants,
  submitActivation,
  listActivations,
  getActivation,
  deleteActivation,
  requestExtend,
  AlreadyActiveError,
  type ProxyDeps,
} from './createActivation';
import { createAuditReader } from './auditHistory';

/**
 * Activate Power backend (ADR-088) — the SOLE creator of `Activation` CRs, the front door's security core.
 *
 * Flow of POST /activate { role, reach, duration?, reason, stepUpToken }:
 *   1. resolve the calling Backstage user;
 *   2. verify the FRESH passkey step-up id_token against Keycloak's JWKS (a hijacked session can't replay it);
 *   3. BIND the assertion to the caller (the step-up subject must be the same user);
 *   4. front-door eligibility (the operator re-checks at mint);
 *   5. create the Activation CR through the kubernetes proxy, stamping the verified step-up for audit.
 *
 * The cluster RBAC grants `create activations` to THIS backend's ServiceAccount only, so no borrow can skip
 * step-up.
 */

const reachFromInput = (input: unknown): Reach | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const r = input as { scope?: unknown; team?: unknown };
  const scope = typeof r.scope === 'string' && r.scope ? r.scope : undefined;
  const team = typeof r.team === 'string' && r.team ? r.team : undefined;
  if (!!scope === !!team) return undefined; // exactly one
  return scope ? { scope } : { team };
};

const usernameFromEntityRef = (ref: string): string =>
  ref.includes('/') ? ref.split('/').pop()! : ref;

export const activatePowerPlugin = createBackendPlugin({
  pluginId: 'activate-power',
  register(env) {
    env.registerInit({
      deps: {
        http: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({
        http,
        httpAuth,
        userInfo,
        auth,
        discovery,
        config,
        logger,
      }) {
        const clusterName = config.getString('activatePower.clusterName');
        const issuer = config.getString('activatePower.issuer');
        const audience = config.getString('activatePower.audience');
        const jwksUri =
          config.getOptionalString('activatePower.jwksUri') ??
          `${issuer}/protocol/openid-connect/certs`;
        const requiredAcr = config.getOptionalString(
          'activatePower.requiredAcr',
        );
        const maxAuthAgeSeconds =
          config.getOptionalNumber('activatePower.maxAuthAgeSeconds') ?? 120;
        const defaultDuration =
          config.getOptionalString('activatePower.defaultDuration') ?? '1h';

        // Created once — caches the realm signing keys across requests.
        const jwks = createRemoteJWKSet(new URL(jwksUri));

        // Read side of the durable audit (ADR-088 §3.6) — borrow HISTORY for the Access view. The DSN is a
        // secret, so it comes from the env (AUDIT_DB_DSN); unset → the view degrades to standing + live only.
        const auditReader = createAuditReader(process.env.AUDIT_DB_DSN);
        if (process.env.AUDIT_DB_DSN) {
          logger.info('access view: audit history reader connected');
        } else {
          logger.info(
            'access view: AUDIT_DB_DSN unset — borrow history disabled',
          );
        }

        // Reach the cluster as THIS backend's service identity (the kubernetes proxy authenticates to EKS
        // via the pod's Pod Identity, independent of the calling user).
        const makeProxy = async (): Promise<ProxyDeps> => {
          const baseUrl = await discovery.getBaseUrl('kubernetes');
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'kubernetes',
          });
          return {
            baseUrl,
            token,
            clusterName,
            fetch: globalThis.fetch as ProxyDeps['fetch'],
          };
        };

        const router = Router();
        router.use(json());

        // What CAN the signed-in user borrow? (its on-demand grants) — populates the Activate Power page.
        // Listing is not sensitive, so no step-up here; borrowing (POST /activate) is the gated action.
        router.get('/eligible', async (req, res) => {
          const credentials = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const info = await userInfo.getUserInfo(credentials);
          const caller = usernameFromEntityRef(info.userEntityRef);
          const grants = await getPersonGrants(await makeProxy(), caller);
          res.json({ user: caller, roles: borrowableGrants(grants) });
        });

        router.post('/activate', async (req, res) => {
          // 1. The calling Backstage user.
          const credentials = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const info = await userInfo.getUserInfo(credentials);
          const caller = usernameFromEntityRef(info.userEntityRef);

          // Input.
          const role = typeof req.body?.role === 'string' ? req.body.role : '';
          const reach = reachFromInput(req.body?.reach);
          const reason =
            typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
          const duration =
            typeof req.body?.duration === 'string' && req.body.duration
              ? req.body.duration
              : defaultDuration;
          const stepUpToken =
            typeof req.body?.stepUpToken === 'string'
              ? req.body.stepUpToken
              : '';
          if (!role || !reach || !reason || !stepUpToken) {
            res.status(400).json({
              error:
                'role, reach (exactly one of scope/team), reason, and stepUpToken are required',
            });
            return;
          }

          // 2. Verify the fresh passkey step-up.
          let verified;
          try {
            verified = await verifyStepUp(stepUpToken, jwks, {
              issuer,
              audience,
              requiredAcr,
              maxAuthAgeSeconds,
            });
          } catch (e) {
            if (e instanceof StepUpError) {
              res.status(401).json({ error: e.message });
              return;
            }
            throw e;
          }

          // 3. Bind the assertion to the caller — you cannot borrow with someone else's passkey.
          if (verified.username !== caller) {
            logger.warn(
              `activate: step-up subject (${verified.username}) != caller (${caller}) — rejected`,
            );
            res.status(403).json({
              error: 'the step-up assertion does not match the signed-in user',
            });
            return;
          }

          // 4. Reach the cluster as this backend's service identity.
          const proxy = await makeProxy();

          // 5. Front-door eligibility (the operator re-checks at mint).
          const grants = await getPersonGrants(proxy, caller);
          if (!isEligibleToBorrow(grants, role, reach)) {
            res.status(403).json({
              error: `you are not eligible to borrow "${role}" at this reach`,
            });
            return;
          }

          // 6. Create the Activation.
          const manifest = buildActivationManifest({
            principal: caller,
            role,
            reach,
            duration,
            reason,
            stepUp: {
              authTime: new Date(verified.authTime * 1000).toISOString(),
              acr: verified.acr,
            },
          });
          try {
            const { name } = await submitActivation(proxy, manifest);
            logger.info(
              `activate: ${caller} borrowed ${role} (${name}) — step-up verified, acr=${verified.acr}`,
            );
            res.status(201).json({ name, role, reach, duration });
          } catch (e) {
            if (e instanceof AlreadyActiveError) {
              res.status(409).json({ error: e.message });
              return;
            }
            throw e;
          }
        });

        // Resolve the signed-in user once (used by the read/revoke routes below).
        const resolveCaller = async (
          req: Parameters<typeof httpAuth.credentials>[0],
        ) => {
          const credentials = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const info = await userInfo.getUserInfo(credentials);
          return usernameFromEntityRef(info.userEntityRef);
        };
        // access-admin (runs the access system) may see + revoke everyone's borrows; otherwise only your own.
        const isAccessAdmin = async (
          proxy: ProxyDeps,
          caller: string,
        ): Promise<boolean> =>
          (await getPersonGrants(proxy, caller)).some(
            g => g.role === 'access-admin',
          );

        // List live borrows. Your own by default; access-admin can pass ?all=true for the governance view.
        router.get('/activations', async (req, res) => {
          const caller = await resolveCaller(req);
          const proxy = await makeProxy();
          const wantAll = req.query?.all === 'true';
          const admin = wantAll && (await isAccessAdmin(proxy, caller));
          const all = await listActivations(proxy);
          res.json({
            user: caller,
            isAdmin: await isAccessAdmin(proxy, caller),
            scope: admin ? 'all' : 'mine',
            activations: admin ? all : all.filter(a => a.principal === caller),
          });
        });

        // A person's whole access picture, joined at read time (NOT stored on the Person): standing grants +
        // borrowable (on-demand) grants from the registry, live borrows from Activations, and durable HISTORY
        // from the audit DB. Yours by default; access-admin may pass ?user= to view anyone's.
        router.get('/access', async (req, res) => {
          const caller = await resolveCaller(req);
          const proxy = await makeProxy();
          const admin = await isAccessAdmin(proxy, caller);
          const target =
            typeof req.query?.user === 'string' && req.query.user
              ? req.query.user
              : caller;
          if (target !== caller && !admin) {
            res.status(403).json({
              error: "only access-admin can view another person's access",
            });
            return;
          }
          const grants = await getPersonGrants(proxy, target);
          const borrows = (await listActivations(proxy)).filter(
            a => a.principal === target,
          );
          const history = await auditReader.historyFor(target);
          res.json({
            user: target,
            isSelf: target === caller,
            isAdmin: admin,
            standingGrants: grants.filter(g => g.activation !== 'on-demand'),
            borrowableGrants: grants.filter(g => g.activation === 'on-demand'),
            liveBorrows: borrows,
            history,
          });
        });

        // Revoke a borrow (delete the CR → the operator pulls every grant back). You may revoke your own;
        // access-admin may revoke anyone's (emergency kill).
        router.delete('/activations/:name', async (req, res) => {
          const caller = await resolveCaller(req);
          const proxy = await makeProxy();
          const name = req.params.name;
          const activation = await getActivation(proxy, name);
          if (!activation) {
            res.status(404).json({ error: 'no such activation' });
            return;
          }
          if (
            activation.principal !== caller &&
            !(await isAccessAdmin(proxy, caller))
          ) {
            res
              .status(403)
              .json({ error: 'you can only revoke your own borrows' });
            return;
          }
          await deleteActivation(proxy, name);
          logger.info(`revoke: ${caller} revoked activation ${name}`);
          res.status(202).json({ name, revoked: true });
        });

        // Extend a live borrow — a fresh passkey re-proves you, and the operator pushes the expiry out
        // (capped at the role's ceiling). Only your OWN borrow, and the step-up must be yours.
        router.post('/activations/:name/extend', async (req, res) => {
          const caller = await resolveCaller(req);
          const name = req.params.name;
          const stepUpToken =
            typeof req.body?.stepUpToken === 'string'
              ? req.body.stepUpToken
              : '';
          if (!stepUpToken) {
            res.status(400).json({ error: 'stepUpToken is required' });
            return;
          }
          // Verify the FRESH passkey step-up (same bar as borrowing).
          let verified;
          try {
            verified = await verifyStepUp(stepUpToken, jwks, {
              issuer,
              audience,
              requiredAcr,
              maxAuthAgeSeconds,
            });
          } catch (e) {
            if (e instanceof StepUpError) {
              res.status(401).json({ error: e.message });
              return;
            }
            throw e;
          }
          if (verified.username !== caller) {
            res.status(403).json({
              error: 'the step-up assertion does not match the signed-in user',
            });
            return;
          }
          const proxy = await makeProxy();
          const activation = await getActivation(proxy, name);
          if (!activation) {
            res.status(404).json({ error: 'no such activation' });
            return;
          }
          if (activation.principal !== caller) {
            res
              .status(403)
              .json({ error: 'you can only extend your own borrows' });
            return;
          }
          const extended = await requestExtend(proxy, name, {
            nonce: randomUUID(),
            authTime: new Date(verified.authTime * 1000).toISOString(),
            acr: verified.acr,
          });
          if (!extended) {
            res.status(404).json({ error: 'no such activation' });
            return;
          }
          logger.info(
            `extend: ${caller} requested an extension of ${name} — step-up verified`,
          );
          res.status(202).json({ name, extended: true });
        });

        http.use(router);
        // The route does its own user-credential resolution; no unauthenticated access.
      },
    });
  },
});

export default activatePowerPlugin;
