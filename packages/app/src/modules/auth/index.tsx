/*
 * Sign-in for the new frontend system — direct OIDC against Keycloak.
 *
 * Production auth is Backstage → Keycloak (the platform IdP of record). Keycloak is an OIDC provider, so it
 * issues refresh tokens and Backstage's silent /refresh on reload succeeds — the session survives reloads
 * without a fronting proxy. (Historically this went Backstage → Dex → Identity Center over SAML, which has no
 * refresh token, so an oauth2-proxy held a durable cookie instead — #202. The move to Keycloak removed that
 * need; Dex and oauth2-proxy are retired. See docs/architecture/identity-and-sso.md in the platform repo.)
 *
 * This registers a custom OAuth2 auth API for the generic `oidc` provider and a real SignInPage that uses it.
 * The provider id must be `oidc` to match the backend's generic OIDC strategy and
 * app-config.production.yaml `auth.providers.oidc`.
 */
import {
  ApiBlueprint,
  createApiRef,
  configApiRef,
  discoveryApiRef,
  oauthRequestApiRef,
  createFrontendModule,
} from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { SignInPage } from '@backstage/core-components';
import { OAuth2 } from '@backstage/core-app-api';
import {
  OpenIdConnectApi,
  ProfileInfoApi,
  BackstageIdentityApi,
  SessionApi,
} from '@backstage/core-plugin-api';

const keycloakAuthApiRef = createApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
>().with({
  id: 'auth.keycloak',
});

const keycloakAuthApi = ApiBlueprint.make({
  name: 'keycloak',
  params: defineParams =>
    defineParams({
      api: keycloakAuthApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        oauthRequestApi: oauthRequestApiRef,
        configApi: configApiRef,
      },
      factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
        OAuth2.create({
          configApi,
          discoveryApi,
          oauthRequestApi,
          environment: configApi.getOptionalString('auth.environment'),
          provider: {
            id: 'oidc',
            title: 'Keycloak',
            icon: () => null,
          },
          defaultScopes: ['openid', 'profile', 'email'],
        }),
    }),
});

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          auto
          provider={{
            id: 'keycloak-auth-provider',
            title: 'Keycloak',
            message: 'Sign in with Keycloak',
            apiRef: keycloakAuthApiRef,
          }}
        />
      ),
  },
});

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [keycloakAuthApi, signInPage],
});
