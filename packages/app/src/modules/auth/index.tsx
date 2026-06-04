/*
 * Sign-in for the new frontend system — via the oauth2-proxy that fronts the portal (#202).
 *
 * Why a proxy: production auth is Backstage → Dex → AWS Identity Center over SAML, and the SAML 2.0
 * protocol has no non-interactive re-query, so Dex's SAML connector never issues a refresh token
 * (https://dexidp.io/docs/connectors/saml/). Backstage's silent /refresh on page reload therefore always
 * 401'd → the user was logged out on every refresh. The fix is to put oauth2-proxy in front: it owns a
 * durable session cookie (24h) and injects identity headers, so the backend `oauth2Proxy` provider's
 * /refresh always succeeds and the session survives reloads. See docs/runbooks/dex-sso.md (platform repo).
 *
 * `ProxiedSignInPage` renders no UI — it just calls /api/auth/oauth2Proxy/refresh, which reads the
 * proxy-injected headers. The provider id must match the backend auth module (oauth2Proxy) and
 * app-config.production.yaml `auth.providers.oauth2Proxy`.
 */
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ProxiedSignInPage } from '@backstage/core-components';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      <ProxiedSignInPage {...props} provider="oauth2Proxy" />,
  },
});

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [signInPage],
});
