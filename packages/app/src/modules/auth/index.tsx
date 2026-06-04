/*
 * OIDC sign-in for the new frontend system.
 *
 * Backstage's new frontend system has no `app.signInPage` config key and ships no generic
 * `oidcAuthApiRef`; the default sign-in page only offers `guest`. This module therefore:
 *   1. defines an OIDC auth API (OAuth2 against the Dex broker, configured in
 *      app-config.production.yaml `auth.providers.oidc`), and
 *   2. overrides the default sign-in page extension to use it.
 *
 * Pattern follows the official guide: https://backstage.io/docs/frontend-system/building-apps/migrating/
 * Production auth flow: Backstage → Dex (sso.aws.refplat.org) → AWS Identity Center → back.
 * See docs/runbooks/dex-sso.md in the platform repo.
 */
import {
  ApiBlueprint,
  configApiRef,
  createApiRef,
  createFrontendModule,
  discoveryApiRef,
  oauthRequestApiRef,
} from '@backstage/frontend-plugin-api';
import {
  BackstageIdentityApi,
  OAuthApi,
  OpenIdConnectApi,
  ProfileInfoApi,
  SessionApi,
} from '@backstage/core-plugin-api';
import { OAuth2 } from '@backstage/core-app-api';
import { SignInPage } from '@backstage/core-components';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';

// Backstage ships no generic OIDC auth API ref — define our own.
export const oidcAuthApiRef = createApiRef<
  OAuthApi &
    OpenIdConnectApi &
    ProfileInfoApi &
    BackstageIdentityApi &
    SessionApi
>({ id: 'auth.oidc' });

// Register the OIDC auth API, backed by OAuth2 talking to the backend `oidc` provider.
const oidcAuthApi = ApiBlueprint.make({
  name: 'oidc',
  params: defineParams =>
    defineParams({
      api: oidcAuthApiRef,
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
          provider: {
            id: 'oidc',
            title: 'AWS SSO',
            icon: () => null,
          },
          environment: configApi.getOptionalString('auth.environment'),
          // NB: there is deliberately no `offline_access` here. Our upstream IdP is AWS Identity Center
          // via Dex's SAML connector, and the SAML 2.0 protocol has no non-interactive re-query — so Dex
          // *ignores* offline_access and never issues a refresh token (https://dexidp.io/docs/connectors/saml/).
          // That means Backstage's silent /refresh can never succeed, so we cannot persist the in-memory
          // session across reloads. Instead the SignInPage below uses `auto` to transparently re-auth on
          // load via the live Identity Center session (no click). See docs/runbooks/dex-sso.md.
          defaultScopes: ['openid', 'profile', 'email'],
        }),
    }),
});

// Replace the default sign-in page (which only offers `guest`) with the OIDC provider.
//
// NB: this is plain click-to-sign-in, NOT `auto`. Because SAML/Dex issues no refresh token (see the OAuth2
// note above), Backstage's background /refresh always 401s and the SessionManager discards the session — so
// `auto` produces an infinite re-auth loop (sign-in succeeds, then the next /refresh kills it, then it
// re-fires). The session therefore can't survive a page reload with this auth chain. Seamless sessions
// require fronting the portal with an auth proxy (oauth2-proxy) that owns its own session cookie and injects
// identity headers, so Backstage's /refresh always succeeds — tracked separately. See docs/runbooks/dex-sso.md.
const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          provider={{
            id: 'oidc',
            title: 'AWS SSO',
            message: 'Sign in with your organization account',
            apiRef: oidcAuthApiRef,
          }}
        />
      ),
  },
});

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [oidcAuthApi, signInPage],
});
