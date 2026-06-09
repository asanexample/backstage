/*
 * Custom OIDC sign-in for Backstage — attaches Keycloak group membership to the Backstage identity.
 *
 * The stock `@backstage/plugin-auth-backend-module-oidc-provider` registers provider `oidc` with the
 * built-in declarative resolvers. The built-in `emailLocalPartMatchingUserEntityName` issues an identity
 * from the email claim but carries NO group membership, so there's nothing for a permission policy to gate
 * on. This module re-registers provider `oidc` with a custom resolver that reads Keycloak's `groups` claim
 * (bare names, e.g. ["alpha","platform-admins"], emitted as a default client scope by keycloak-config) and
 * turns it into `ownershipEntityRefs` (`group:default/<name>`). The permission policy then uses those refs
 * for the admin gate (`group:default/platform-admins`) and team-scoped ownership checks (ADR-053, #197).
 *
 * Supplying a non-factory `signInResolver` makes it authoritative — the declarative `signIn.resolvers`
 * block in app-config is ignored (and has been removed from app-config.production.yaml). `issueToken` does
 * NOT require a matching catalog User entity, preserving the prior login-only behaviour until catalog Users
 * are projected (ADR-049).
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  type SignInResolver,
  type OAuthAuthenticatorResult,
} from '@backstage/plugin-auth-node';
import {
  oidcAuthenticator,
  type OidcAuthResult,
} from '@backstage/plugin-auth-backend-module-oidc-provider';
import { DEFAULT_NAMESPACE, stringifyEntityRef } from '@backstage/catalog-model';

/**
 * Reads the Keycloak `groups` claim and issues a Backstage identity whose ownershipEntityRefs include the
 * user's own ref plus a `group:default/<name>` ref per claimed group.
 */
export const keycloakGroupsSignInResolver: SignInResolver<
  OAuthAuthenticatorResult<OidcAuthResult>
> = async (info, ctx) => {
  const { profile, result } = info;

  if (!profile.email) {
    throw new Error(
      'Login failed: Keycloak profile contains no email (needed for the Backstage user ref)',
    );
  }
  const [localPart] = profile.email.split('@');
  const userEntityRef = stringifyEntityRef({
    kind: 'User',
    namespace: DEFAULT_NAMESPACE,
    name: localPart,
  });

  // Keycloak's group-membership mapper adds `groups` to the userinfo response (and the id token). Prefer
  // userinfo; fall back to the decoded id token in case a future mapper config only emits it there.
  const userinfo = result.fullProfile.userinfo as { groups?: unknown };
  let groups: unknown = userinfo.groups;
  if (!Array.isArray(groups)) {
    groups = result.fullProfile.tokenset.claims?.().groups;
  }

  const groupRefs = (Array.isArray(groups) ? groups : [])
    .filter((g): g is string => typeof g === 'string' && g.length > 0)
    // full_path=false in keycloak-config, but strip a leading slash defensively if that ever changes.
    .map(name => name.replace(/^\//, ''))
    .map(name =>
      stringifyEntityRef({
        kind: 'Group',
        namespace: DEFAULT_NAMESPACE,
        name,
      }),
    );

  return ctx.issueToken({
    claims: {
      sub: userEntityRef,
      ent: [userEntityRef, ...groupRefs],
    },
  });
};

/**
 * Backend module that registers the `oidc` provider with the Keycloak-groups resolver. Replaces the stock
 * oidc-provider module in packages/backend/src/index.ts (both register providerId `oidc`).
 */
export const authModuleOidcKeycloakGroups = createBackendModule({
  pluginId: 'auth',
  moduleId: 'oidc-keycloak-groups',
  register(reg) {
    reg.registerInit({
      deps: { providers: authProvidersExtensionPoint },
      async init({ providers }) {
        providers.registerProvider({
          providerId: 'oidc',
          factory: createOAuthProviderFactory({
            authenticator: oidcAuthenticator,
            signInResolver: keycloakGroupsSignInResolver,
          }),
        });
      },
    });
  },
});

export default authModuleOidcKeycloakGroups;
