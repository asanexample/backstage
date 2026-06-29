import {
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
  type KeyLike,
} from 'jose';

/**
 * Activate Power step-up verification (ADR-088).
 *
 * Borrowing a privileged role hands out real power (break-glass = AdministratorAccess), so a valid
 * Backstage session is NOT sufficient authorization. The frontend forces a FRESH OIDC re-authentication
 * against Keycloak (`max_age=0` + `acr_values` for the passkey) and sends the resulting id_token here; this
 * module independently verifies it against Keycloak's JWKS — proving a real human, physically present right
 * now, deliberately asked for this power (a hijacked session can't replay a passkey).
 *
 * It is deliberately a pure function over an injected key resolver so the security logic is exhaustively
 * unit-tested (fresh/stale/forged/wrong-authenticator) without a live Keycloak.
 */

export interface StepUpRequirements {
  /** Expected token issuer — the Keycloak realm issuer. */
  issuer: string;
  /** Expected audience — the OIDC client id the step-up ceremony used. */
  audience: string;
  /**
   * Required `acr` (authentication context class reference / LoA). When set, the token's acr MUST equal it —
   * this is what forces the passkey specifically, not just any re-auth.
   */
  requiredAcr?: string;
  /** The authentication must be fresh: `auth_time` within this many seconds of now. */
  maxAuthAgeSeconds: number;
}

export interface VerifiedStepUp {
  /** The Keycloak subject (stable id). */
  subject: string;
  /** `preferred_username` — matched against the calling Backstage user to bind the assertion to them. */
  username?: string;
  email?: string;
  acr?: string;
  /** Epoch seconds the user actually authenticated. */
  authTime: number;
}

/** A verification failure the route surfaces to the user as a 401 (re-authenticate), not a 500. */
export class StepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepUpError';
  }
}

/**
 * Verify a fresh passkey step-up id_token. `getKey` is jose's key resolver — `createRemoteJWKSet(...)` in
 * production, a local public key in tests. Throws {@link StepUpError} on any failure (never returns on a
 * stale/forged/insufficient assertion — fail closed).
 */
export async function verifyStepUp(
  idToken: string,
  getKey: JWTVerifyGetKey | KeyLike | Uint8Array,
  req: StepUpRequirements,
  nowMs: () => number = Date.now,
): Promise<VerifiedStepUp> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, getKey as JWTVerifyGetKey, {
      issuer: req.issuer,
      audience: req.audience,
      clockTolerance: 30, // seconds, for exp/nbf skew
    }));
  } catch (e) {
    // Bad signature, wrong issuer/audience, expired — all are an invalid step-up.
    throw new StepUpError(`step-up token invalid: ${(e as Error).message}`);
  }

  // Freshness: the whole point. `auth_time` is when the user actually authenticated (not when the token was
  // issued), so it can't be faked by re-minting a token from an old session.
  const authTime =
    typeof payload.auth_time === 'number'
      ? payload.auth_time
      : Number(payload.auth_time);
  if (!Number.isFinite(authTime) || authTime <= 0) {
    throw new StepUpError(
      'step-up token has no auth_time — cannot prove a fresh authentication',
    );
  }
  const ageSeconds = nowMs() / 1000 - authTime;
  if (ageSeconds > req.maxAuthAgeSeconds) {
    throw new StepUpError(
      `step-up authentication is stale (${Math.round(ageSeconds)}s old, max ${req.maxAuthAgeSeconds}s) — re-authenticate with your passkey`,
    );
  }
  if (ageSeconds < -req.maxAuthAgeSeconds) {
    throw new StepUpError(
      'step-up auth_time is in the future — clock skew or a forged token',
    );
  }

  // Assurance: force the passkey specifically (not just any re-auth) when an acr is required.
  const acr = typeof payload.acr === 'string' ? payload.acr : undefined;
  if (req.requiredAcr && acr !== req.requiredAcr) {
    throw new StepUpError(
      `step-up did not satisfy the required assurance level (needed acr "${req.requiredAcr}", got "${acr ?? 'none'}") — you must use your passkey`,
    );
  }

  if (!payload.sub) {
    throw new StepUpError('step-up token has no subject');
  }

  return {
    subject: String(payload.sub),
    username:
      typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    acr,
    authTime,
  };
}
