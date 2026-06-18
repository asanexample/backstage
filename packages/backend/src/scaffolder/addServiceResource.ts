/*
 * platform:add-service-resource (#553, ADR-073) — the "New Resource" form's edit step. The template
 * fetch:plain:file's the Environment claim into the workspace; this action reads it (pure fs — no octokit/creds),
 * adds spec.services.<service>.resources.<name> = {kind, engine, access}, and writes it back for
 * publish:github:pull-request. Validation (name shape, duplicate, unknown service) is enforced HERE server-side
 * so a client can't skip it. `kind` is DERIVED from `engine` (cloud-neutral, ADR-067 §7) so the form only asks
 * for engine. The Team envelope (allowedEngines / per-env count) is enforced by the gitops Gate at PR time —
 * defense in depth, not duplicated here.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from 'yaml';

const REQUESTED_BY = 'platform.refplat.org/requested-by';
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

// Cloud-neutral kind per engine (ADR-067 §7 / ADR-073). Keep in sync with the XRD `kind` enum.
const ENGINE_KIND: Record<string, string> = {
  s3: 'objectstore',
  sqs: 'stream',
  sns: 'stream',
  dynamodb: 'keyvalue',
};

export const createAddServiceResourceAction = () =>
  createTemplateAction({
    id: 'platform:add-service-resource',
    description:
      'Adds spec.services.<service>.resources.<name> to a fetched XEnvironment claim and writes it back for publish:github:pull-request (ADR-073 self-service resources).',
    schema: {
      input: {
        claimPath: z =>
          z
            .string()
            .describe(
              'Path of the Environment claim within the workspace (where fetch:plain:file placed it).',
            ),
        service: z =>
          z
            .string()
            .describe(
              'The Service to attach the resource to (must already be declared on the claim).',
            ),
        resourceName: z =>
          z.string().describe('The resource name (must match ^[a-z][a-z0-9-]{0,30}$).'),
        engine: z =>
          z
            .enum(['s3', 'sqs', 'sns', 'dynamodb'])
            .describe('The cloud engine; the cloud-neutral kind is derived from it.'),
        access: z =>
          z
            .enum(['read', 'readwrite'])
            .describe('Least-privilege access intent the platform derives IAM from.'),
        requestedBy: z =>
          z.string().describe('The requesting user entity ref (audit).').optional(),
      },
    },
    async handler(ctx) {
      const { service, resourceName, engine, access } = ctx.input;

      if (!NAME_RE.test(resourceName)) {
        throw new Error(
          `resourceName "${resourceName}" must match ^[a-z][a-z0-9-]{0,30}$`,
        );
      }
      const kind = ENGINE_KIND[engine];
      if (!kind) {
        throw new Error(`unsupported engine "${engine}"`);
      }

      const abs = resolveSafeChildPath(ctx.workspacePath, ctx.input.claimPath);
      const doc = parse(readFileSync(abs, 'utf8'));
      if (!doc || doc.kind !== 'XEnvironment') {
        throw new Error(
          `${ctx.input.claimPath} is not an XEnvironment claim — refusing to edit.`,
        );
      }

      const svc = doc.spec?.services?.[service];
      if (!svc) {
        throw new Error(
          `service "${service}" is not declared on ${doc.metadata?.name} — add the Service first.`,
        );
      }
      svc.resources = svc.resources ?? {};
      if (svc.resources[resourceName]) {
        throw new Error(
          `resource "${resourceName}" already exists on service "${service}" — choose a different name.`,
        );
      }
      svc.resources[resourceName] = { kind, engine, access };

      if (ctx.input.requestedBy) {
        doc.metadata.annotations = doc.metadata.annotations ?? {};
        doc.metadata.annotations[REQUESTED_BY] = ctx.input.requestedBy;
      }

      writeFileSync(abs, stringify(doc), 'utf8');
      ctx.logger.info(
        `added resource ${service}/${resourceName} (${engine}/${access}, kind=${kind}) to ${doc.metadata?.name}${
          ctx.input.requestedBy ? ` (by ${ctx.input.requestedBy})` : ''
        }`,
      );
    },
  });
