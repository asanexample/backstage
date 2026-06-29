import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { Router, json } from 'express';
import { createRemoteJWKSet } from 'jose';
import { verifyStepUp, StepUpError } from './verifyStepUp';
import { isEligibleToBorrow, type Reach } from './eligibility';
import {
  buildActivationManifest,
  getPersonGrants,
  submitActivation,
  AlreadyActiveError,
  type ProxyDeps,
} from './createActivation';

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
      async init({ http, httpAuth, userInfo, auth, discovery, config, logger }) {
        const clusterName = config.getString('activatePower.clusterName');
        const issuer = config.getString('activatePower.issuer');
        const audience = config.getString('activatePower.audience');
        const jwksUri =
          config.getOptionalString('activatePower.jwksUri') ??
          `${issuer}/protocol/openid-connect/certs`;
        const requiredAcr = config.getOptionalString('activatePower.requiredAcr');
        const maxAuthAgeSeconds =
          config.getOptionalNumber('activatePower.maxAuthAgeSeconds') ?? 120;
        const defaultDuration =
          config.getOptionalString('activatePower.defaultDuration') ?? '1h';

        // Created once — caches the realm signing keys across requests.
        const jwks = createRemoteJWKSet(new URL(jwksUri));

        const router = Router();
        router.use(json());

        router.post('/activate', async (req, res) => {
          // 1. The calling Backstage user.
          const credentials = await httpAuth.credentials(req, { allow: ['user'] });
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
            typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : '';
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
          const baseUrl = await discovery.getBaseUrl('kubernetes');
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'kubernetes',
          });
          const proxy: ProxyDeps = {
            baseUrl,
            token,
            clusterName,
            fetch: globalThis.fetch as ProxyDeps['fetch'],
          };

          // 5. Front-door eligibility (the operator re-checks at mint).
          const grants = await getPersonGrants(proxy, caller);
          if (!isEligibleToBorrow(grants as any, role, reach)) {
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

        http.use(router);
        // The route does its own user-credential resolution; no unauthenticated access.
      },
    });
  },
});

export default activatePowerPlugin;
