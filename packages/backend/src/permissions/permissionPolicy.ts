/*
 * Centric platform permission policy (#197, ADR-053).
 *
 * Group-based RBAC sourced from the Keycloak `groups` claim, which the sign-in resolver
 * (../authOidcModule) turns into the user's `ownershipEntityRefs`:
 *
 *   - platform-admins (group:default/platform-admins) -> full access (admin gate)
 *   - everyone        -> READ the whole catalog (discovery preserved)
 *   - team members    -> write/delete only entities OWNED BY their team (ownership-based); cross-team denied
 *   - anything else (non-catalog writes: scaffolder/techdocs, and catalog create/register which are
 *                    non-resource permissions with no owner to check) -> admin-only
 *
 * Catalog ingestion (GitHub discovery, the platform projection) does NOT flow through this policy — it
 * runs in the processing engine, not user-authorised API calls — so it is unaffected.
 */
import {
  AuthorizeResult,
  type PolicyDecision,
  isResourcePermission,
  isReadPermission,
} from '@backstage/plugin-permission-common';
import type {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';

/** Keycloak group whose members get unrestricted access. */
export const PLATFORM_ADMINS_REF = 'group:default/platform-admins';

const CATALOG_RESOURCE_TYPE = 'catalog-entity';

export class CentricPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    // `info` is the only path exposing ownership refs on PolicyQueryUser in plugin-permission-node@0.11.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ownershipRefs = user?.info.ownershipEntityRefs ?? [];

    // (1) Admin gate — platform-admins can do anything.
    if (ownershipRefs.includes(PLATFORM_ADMINS_REF)) {
      return { result: AuthorizeResult.ALLOW };
    }

    // (2) Reads are open to every signed-in user (catalog discovery, techdocs, etc.).
    if (isReadPermission(request.permission)) {
      return { result: AuthorizeResult.ALLOW };
    }

    // (3) No identity / no groups (unauthenticated, guest, service principal) — deny any write.
    if (ownershipRefs.length === 0) {
      return { result: AuthorizeResult.DENY };
    }

    // (4) Catalog writes (delete / unregister / refresh) — allow only on entities the user's team owns.
    if (isResourcePermission(request.permission, CATALOG_RESOURCE_TYPE)) {
      return createCatalogConditionalDecision(request.permission, {
        anyOf: [catalogConditions.isEntityOwner({ claims: ownershipRefs })],
      });
    }

    // (5) Everything else (non-catalog writes, and non-resource catalog create/register) — admin-only,
    // and admins already returned at (1).
    return { result: AuthorizeResult.DENY };
  }
}
