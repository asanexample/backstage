export interface Config {
  signOut?: {
    /**
     * Keycloak RP-initiated logout (end-session) endpoint for the realm, e.g.
     * `https://keycloak.aws.refplat.org/realms/platform/protocol/openid-connect/logout`.
     *
     * When set, the sidebar "Sign out" control redirects here (with `id_token_hint` and
     * `post_logout_redirect_uri`) after clearing the local Backstage session, so logging out also ends the
     * Keycloak SSO session. Without it, the SignInPage's `auto` silently re-authenticates against the live
     * Keycloak cookie. Unset in local dev (guest provider), where sign-out just returns to the app.
     *
     * @visibility frontend
     */
    keycloakLogoutUrl?: string;
  };
}
