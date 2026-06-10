/*
 * platform:verify-team-membership (#281, ADR-062 §1) — the server-side authorization step for the
 * self-service templates. The permission policy can only gate scaffolder task creation as a whole
 * (taskCreate carries no templateRef), so per-template scoping lives here, as the FIRST step of each
 * template: New Tenant passes { team } (the user must own that team's group), New Team passes
 * { requireAdmin: true }. Template steps are server-stored — a task request only carries
 * templateRef + parameter values — so this step cannot be stripped by a client.
 *
 * Identity comes from the task's initiator credentials via the UserInfoService: the same
 * Keycloak-groups → ownershipEntityRefs chain the permission policy uses (#197). Fails closed: a
 * non-user principal (service token) has no user info and is rejected.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { UserInfoService } from '@backstage/backend-plugin-api';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { PLATFORM_ADMINS_REF } from '../permissions/permissionPolicy';

export { PLATFORM_ADMINS_REF };

export const createVerifyTeamMembershipAction = (options: {
  userInfo: UserInfoService;
}) =>
  createTemplateAction({
    id: 'platform:verify-team-membership',
    description:
      'Fails the task unless the initiating user is a member of the target team (ownership group) — or a platform admin. With requireAdmin, only platform admins pass.',
    schema: {
      input: {
        team: z =>
          z
            .string()
            .describe(
              'Team to verify membership of — a bare team name ("charlie") or an entity ref ("group:default/charlie").',
            )
            .optional(),
        requireAdmin: z =>
          z
            .boolean()
            .describe('Require platform-admins membership (New Team flow).')
            .optional(),
      },
    },
    async handler(ctx) {
      const credentials = await ctx.getInitiatorCredentials();
      // Throws for non-user principals — exactly the fail-closed behavior we want.
      const info = await options.userInfo.getUserInfo(credentials);
      const refs = info.ownershipEntityRefs ?? [];
      const isAdmin = refs.includes(PLATFORM_ADMINS_REF);

      if (ctx.input.requireAdmin && !isAdmin) {
        throw new Error(
          `${info.userEntityRef} is not a platform admin — this template is restricted to ${PLATFORM_ADMINS_REF} (ADR-062 §1).`,
        );
      }

      if (ctx.input.team) {
        const teamRef = stringifyEntityRef(
          parseEntityRef(ctx.input.team, {
            defaultKind: 'group',
            defaultNamespace: 'default',
          }),
        );
        if (!isAdmin && !refs.includes(teamRef)) {
          throw new Error(
            `${info.userEntityRef} is not a member of ${teamRef} — you can only provision tenants for your own team (ADR-062 §1).`,
          );
        }
        ctx.logger.info(
          `verified: ${info.userEntityRef} may act for ${teamRef}${
            isAdmin ? ' (platform admin)' : ''
          }`,
        );
      } else if (!ctx.input.requireAdmin) {
        throw new Error(
          'platform:verify-team-membership needs `team` and/or `requireAdmin` — refusing to verify nothing.',
        );
      }
    },
  });
