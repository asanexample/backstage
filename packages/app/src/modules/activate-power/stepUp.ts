import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * Activate Power step-up ceremony (ADR-088).
 *
 * Borrowing a privileged role hands out real power, so a valid Backstage session isn't enough. This forces a
 * FRESH passkey: a popup OIDC re-authentication against the dedicated `activate-power` Keycloak client with
 * `max_age=0` (ignore the existing session) and `acr_values` (request the high assurance level). Because the
 * realm's only second factor IS the passkey, a fresh re-auth is a fresh passkey tap. The resulting id_token
 * is handed to the backend, which independently verifies it (signature, freshness, acr, and that it's you).
 */

export interface StepUpConfig {
  /** Keycloak realm issuer (the OIDC authority). */
  authority: string;
  /** The public step-up client id (`activate-power`). */
  clientId: string;
  /** Requested assurance level (acr_values), e.g. "gold". Optional. */
  acrValues?: string;
}

const redirectUri = () => `${window.location.origin}/activate-power/callback`;

const manager = (cfg: StepUpConfig): UserManager =>
  new UserManager({
    authority: cfg.authority,
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code', // code + PKCE (public client)
    scope: 'openid profile email',
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    // The step-up itself: ignore any live session and re-prompt the authenticator now.
    extraQueryParams: {
      max_age: 0,
      prompt: 'login',
      ...(cfg.acrValues ? { acr_values: cfg.acrValues } : {}),
    },
  });

/** Open the passkey popup; resolves with the fresh id_token (rejects if the user cancels or it fails). */
export async function stepUp(cfg: StepUpConfig): Promise<string> {
  const user = await manager(cfg).signinPopup();
  if (!user?.id_token) {
    throw new Error('step-up did not return an id_token');
  }
  return user.id_token;
}

/** Runs in the popup at the redirect_uri: completes the flow and signals the opener, then the popup closes. */
export async function completeStepUp(cfg: StepUpConfig): Promise<void> {
  await manager(cfg).signinPopupCallback();
}
