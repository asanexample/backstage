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
// `auto` makes the page initiate sign-in immediately instead of rendering a "Sign In" button. Because the
// Backstage session is in-memory and we get no refresh token from SAML/Dex (see the OAuth2 note above), the
// session is lost on every reload; `auto` transparently re-acquires it through the still-live Identity Center
// session (the popup completes without user interaction), so the user isn't bounced to a sign-in screen on
// each refresh. This uses the popup flow (the experimental redirect flow would loop: it depends on the same
// /refresh that SAML can't satisfy).
const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          auto
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
