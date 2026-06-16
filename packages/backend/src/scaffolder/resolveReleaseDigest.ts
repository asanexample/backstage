/*
 * platform:resolve-release-digest (#377 Phase 3b) — the digest-resolution step for the Request Promotion
 * template. The template first `fetch:plain:file`s the SOURCE stage's control-plane Release (ADR-071,
 * gitops/releases/<team>/<product>/<from-stem>.yaml) into the workspace; this action reads it (pure fs — no
 * octokit/creds), pulls the deployed image digest for the chosen Service, and outputs it so the next step
 * renders the TARGET stage's Release with the SAME signed artifact. Fails closed if the source Release, Service,
 * or digest is missing (you can only promote what the lower stage actually deployed).
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { readFileSync } from 'fs';
import { parse } from 'yaml';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export const createResolveReleaseDigestAction = () =>
  createTemplateAction({
    id: 'platform:resolve-release-digest',
    description:
      'Reads the deployed image digest of a Service from a fetched lower-stage Release record (ADR-071), so a promotion moves the SAME signed artifact up the ladder. Fails if the source Release/Service/digest is missing.',
    schema: {
      input: {
        releasePath: z =>
          z
            .string()
            .describe(
              'Path of the source-stage Release within the workspace (where fetch:plain:file placed it).',
            ),
        service: z =>
          z.string().describe('Service whose deployed digest to resolve.'),
      },
      output: {
        digest: z =>
          z
            .string()
            .describe(
              'The sha256:<64 hex> manifest digest the Service is running at the source stage.',
            ),
      },
    },
    async handler(ctx) {
      const abs = resolveSafeChildPath(ctx.workspacePath, ctx.input.releasePath);
      let doc: any;
      try {
        doc = parse(readFileSync(abs, 'utf8'));
      } catch {
        throw new Error(
          `source Release ${ctx.input.releasePath} not found — is the lower stage deployed for this Service?`,
        );
      }
      if (!doc || doc.kind !== 'Release') {
        throw new Error(
          `${ctx.input.releasePath} is not a Release record — refusing to resolve a digest from it.`,
        );
      }
      const digest = doc.spec?.services?.[ctx.input.service]?.digest;
      if (!DIGEST_RE.test(digest ?? '')) {
        throw new Error(
          `no signed digest for Service '${ctx.input.service}' in ${ctx.input.releasePath} — the source stage has not deployed it.`,
        );
      }
      ctx.output('digest', digest);
      ctx.logger.info(
        `resolved ${ctx.input.service}@${doc.metadata?.name ?? '?'} -> ${digest}`,
      );
    },
  });
