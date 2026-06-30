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
  /**
   * Tenant Status card (#285, ADR-064 §2).
   */
  tenantStatus?: {
    /**
     * The Kubernetes cluster (as named in kubernetes.clusterLocatorMethods) the Tenant Status card proxies
     * XTenant GETs to. Defaults to `preprod-use1-eks` — the workload cluster hosting tenants.
     *
     * @visibility frontend
     */
    clusterName?: string;
  };
  /**
   * Activate Power (ADR-088) — the temporary-power front door. The whole activatePower schema lives here
   * (not in the backend package): the frontend keys (the step-up popup, `@visibility frontend`) and the
   * backend keys (the /activate + /eligible routes, default backend visibility) together.
   */
  activatePower?: {
    /**
     * Keycloak realm issuer (the OIDC authority) the step-up popup re-authenticates against.
     * @visibility frontend
     */
    authority?: string;
    /**
     * The public step-up client id (no secret — it runs in the browser).
     * @visibility frontend
     */
    clientId?: string;
    /**
     * Optional requested assurance level (acr_values), e.g. "gold". Omit to rely on max_age=0 freshness alone
     * (the realm's only second factor is the passkey, so a fresh re-auth is already a fresh passkey).
     * @visibility frontend
     */
    acrValues?: string;
    /** The cluster (kubernetes-plugin name) the backend creates Activation CRs in (the hub). */
    clusterName?: string;
    /** The Keycloak realm issuer the backend requires the step-up id_token to come from. */
    issuer?: string;
    /** The OIDC client id (token audience) the step-up ceremony used. */
    audience?: string;
    /** Realm JWKS URI. Default: `<issuer>/protocol/openid-connect/certs`. */
    jwksUri?: string;
    /** Required `acr` — omit to accept any fresh authentication (freshness is still enforced). */
    requiredAcr?: string;
    /** How fresh the step-up must be (auth_time within this many seconds). Default: 120. */
    maxAuthAgeSeconds?: number;
    /** Default borrow window (Go duration) when the request omits one. Default: "1h". */
    defaultDuration?: string;
  };

  /**
   * Cost (ADR-091 A3) — the backend Cost tab queries the hub Mimir for per-team spend vs budget. Backend keys
   * only (the frontend reads via the cost backend, not config).
   */
  cost?: {
    /** In-cluster Mimir gateway query API base, e.g. http://mimir-gateway.observability.svc/prometheus. */
    mimirUrl?: string;
    /** X-Scope-OrgID tenant for the query — the federated "platform|preprod" so spend spans both clusters. */
    mimirTenant?: string;
  };
}
