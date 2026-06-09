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
import { SignInPage, SidebarItem } from '@backstage/core-components';
import { OAuth2 } from '@backstage/core-app-api';
import {
  OpenIdConnectApi,
  ProfileInfoApi,
  BackstageIdentityApi,
  SessionApi,
  useApi,
} from '@backstage/core-plugin-api';
import ExitToAppIcon from '@material-ui/icons/ExitToApp';

export const keycloakAuthApiRef = createApiRef<
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

/*
 * Sidebar "Sign out" control.
 *
 * Backstage's SignInPage above uses `auto`, so clearing only the local Backstage session isn't enough: the
 * page reloads and silently re-authenticates against the still-live Keycloak SSO cookie, and it looks like
 * logout did nothing. So we also fire Keycloak's RP-initiated logout (end-session) to end the SSO session.
 *
 * Order matters: read the id token BEFORE signOut() clears it — Keycloak takes it as `id_token_hint` to skip
 * the logout-confirmation prompt and end the right session. `signOut.keycloakLogoutUrl` is the realm's
 * end-session endpoint (frontend-visible config; see config.d.ts). When it's absent (e.g. local guest dev)
 * we just return to the app, which re-renders the sign-in page.
 */
export const SidebarSignOut = () => {
  const authApi = useApi(keycloakAuthApiRef);
  const configApi = useApi(configApiRef);

  const handleSignOut = async () => {
    let idToken: string | undefined;
    try {
      idToken = await authApi.getIdToken();
    } catch {
      // No live token — nothing to hint with; still clear the local session below.
    }

    await authApi.signOut();

    const baseUrl = configApi.getString('app.baseUrl');
    const logoutUrl = configApi.getOptionalString('signOut.keycloakLogoutUrl');
    if (logoutUrl) {
      const url = new URL(logoutUrl);
      url.searchParams.set('post_logout_redirect_uri', baseUrl);
      if (idToken) {
        url.searchParams.set('id_token_hint', idToken);
      }
      window.location.href = url.toString();
    } else {
      window.location.href = baseUrl;
    }
  };

  return (
    <SidebarItem icon={ExitToAppIcon} text="Sign out" onClick={handleSignOut} />
  );
};

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [keycloakAuthApi, signInPage],
});
