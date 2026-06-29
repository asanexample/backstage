export interface Config {
  /**
   * Activate Power backend (ADR-088) — the front door for borrowing time-boxed privileged roles. The
   * /activate route verifies a fresh passkey step-up and creates the Activation CR (it is the sole creator).
   */
  activatePower?: {
    /** The EKS cluster (by Backstage kubernetes-plugin name) the Activation CRs are created in. */
    clusterName: string;
    /** The Keycloak realm issuer the step-up id_token must come from. */
    issuer: string;
    /** The OIDC client id the step-up ceremony used (the token audience). */
    audience: string;
    /** Realm JWKS URI. Default: `<issuer>/protocol/openid-connect/certs`. */
    jwksUri?: string;
    /**
     * Required `acr` (level of assurance) — forces the passkey specifically, not just any re-auth. Omit to
     * accept any fresh authentication (freshness is still enforced).
     */
    requiredAcr?: string;
    /** How fresh the step-up must be (auth_time within this many seconds). Default: 120. */
    maxAuthAgeSeconds?: number;
    /** Default borrow window (Go duration) when the request omits one. Default: "1h". */
    defaultDuration?: string;
  };
}
