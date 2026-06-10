/*
 * platform:set-lifecycle-phase (#283, ADR-062) — the deprovisioning edit step for the Deprovision template.
 * The template first `fetch:plain:file`s the tenant claim into the workspace; this action reads it (pure fs —
 * no octokit/creds), sets spec.lifecycle.phase (decommission → reversible suspend, or reactivate → active),
 * stamps the requesting user + a decommissioned-at timestamp, and writes it back. publish:github:pull-request
 * then opens the PR. Confirmation (the user must type the tenant name) is enforced HERE, server-side, not just
 * in the form — a client can't skip a server-stored step.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from 'yaml';

const DECOMMISSIONED_AT = 'platform.refplat.org/decommissioned-at';
const REQUESTED_BY = 'platform.refplat.org/requested-by';

export const createSetLifecyclePhaseAction = () =>
  createTemplateAction({
    id: 'platform:set-lifecycle-phase',
    description:
      'Sets spec.lifecycle.phase on a fetched tenant claim (deprovisioning: decommissioning or active) and writes it back to the workspace for publish:github:pull-request.',
    schema: {
      input: {
        claimPath: z =>
          z
            .string()
            .describe(
              'Path of the claim within the workspace (where fetch:plain:file placed it).',
            ),
        phase: z =>
          z
            .enum(['active', 'suspended', 'decommissioning'])
            .describe('The lifecycle phase to set.'),
        confirm: z =>
          z
            .string()
            .describe(
              'The user-typed confirmation; must equal the claim metadata.name.',
            ),
        requestedBy: z =>
          z
            .string()
            .describe('The requesting user entity ref (audit).')
            .optional(),
        timestamp: z =>
          z
            .string()
            .describe('ISO timestamp to stamp as decommissioned-at.')
            .optional(),
      },
    },
    async handler(ctx) {
      const abs = resolveSafeChildPath(ctx.workspacePath, ctx.input.claimPath);
      const doc = parse(readFileSync(abs, 'utf8'));
      if (!doc || doc.kind !== 'XTenant') {
        throw new Error(
          `${ctx.input.claimPath} is not an XTenant claim — refusing to edit.`,
        );
      }

      const name = doc.metadata?.name;
      // Server-side confirmation: the typed value must match the tenant being acted on.
      if (ctx.input.confirm !== name) {
        throw new Error(
          `confirmation "${ctx.input.confirm}" does not match the tenant "${name}" — aborting (type the exact tenant name to confirm).`,
        );
      }

      doc.spec = doc.spec ?? {};
      doc.spec.lifecycle = {
        ...(doc.spec.lifecycle ?? {}),
        phase: ctx.input.phase,
      };

      doc.metadata.annotations = doc.metadata.annotations ?? {};
      if (ctx.input.phase === 'active') {
        // Reactivation: clear the decommission marker so the claim looks live again.
        delete doc.metadata.annotations[DECOMMISSIONED_AT];
      } else {
        // Stamp when the grace window started (caller may override; default = now).
        doc.metadata.annotations[DECOMMISSIONED_AT] =
          ctx.input.timestamp ?? new Date().toISOString();
      }
      if (ctx.input.requestedBy) {
        doc.metadata.annotations[REQUESTED_BY] = ctx.input.requestedBy;
      }

      writeFileSync(abs, stringify(doc), 'utf8');
      ctx.logger.info(
        `set ${name} lifecycle.phase=${ctx.input.phase}${
          ctx.input.requestedBy ? ` (by ${ctx.input.requestedBy})` : ''
        }`,
      );
    },
  });
