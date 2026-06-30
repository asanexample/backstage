import { SignJWT, generateKeyPair, type KeyLike } from 'jose';
import {
  verifyStepUp,
  StepUpError,
  type StepUpRequirements,
} from './verifyStepUp';

const REQ: StepUpRequirements = {
  issuer: 'https://keycloak.example/realms/platform',
  audience: 'activate-power',
  requiredAcr: 'passkey',
  maxAuthAgeSeconds: 120,
};

// Anchor everything to the real clock: jose's jwtVerify checks exp/nbf against the real time, while our
// freshness check uses the injected `now`. Keeping both on the same base avoids contrived skew.
const NOW_MS = Date.now();
const now = () => NOW_MS;
const nowSec = Math.floor(NOW_MS / 1000);

async function token(
  key: KeyLike,
  claims: Record<string, unknown> = {},
  opts: { iss?: string; aud?: string } = {},
): Promise<string> {
  const { acr, auth_time, ...rest } = {
    acr: 'passkey',
    auth_time: nowSec,
    preferred_username: 'josh',
    email: 'josh@example.com',
    ...claims,
  } as Record<string, unknown>;
  return new SignJWT({ acr, auth_time, ...rest })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.iss ?? REQ.issuer)
    .setAudience(opts.aud ?? REQ.audience)
    .setSubject((claims.sub as string) ?? 'josh-subject')
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(key);
}

describe('verifyStepUp', () => {
  let publicKey: KeyLike;
  let privateKey: KeyLike;
  let otherPublicKey: KeyLike;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('RS256'));
    ({ publicKey: otherPublicKey } = await generateKeyPair('RS256'));
  });

  it('accepts a fresh passkey assertion and returns the bound identity', async () => {
    const res = await verifyStepUp(
      await token(privateKey),
      publicKey,
      REQ,
      now,
    );
    expect(res).toMatchObject({
      subject: 'josh-subject',
      username: 'josh',
      acr: 'passkey',
      authTime: nowSec,
    });
  });

  it('rejects a stale authentication (auth_time older than the window)', async () => {
    const t = await token(privateKey, { auth_time: nowSec - 600 });
    await expect(verifyStepUp(t, publicKey, REQ, now)).rejects.toThrow(/stale/);
  });

  it('rejects the wrong authenticator (acr not the required passkey LoA)', async () => {
    const t = await token(privateKey, { acr: 'password' });
    await expect(verifyStepUp(t, publicKey, REQ, now)).rejects.toThrow(
      StepUpError,
    );
    await expect(verifyStepUp(t, publicKey, REQ, now)).rejects.toThrow(
      /passkey/,
    );
  });

  it('rejects a token with no auth_time (cannot prove freshness)', async () => {
    const t = await token(privateKey, { auth_time: undefined });
    await expect(verifyStepUp(t, publicKey, REQ, now)).rejects.toThrow(
      /auth_time/,
    );
  });

  it('rejects a forged token (signed by a different key)', async () => {
    const t = await token(privateKey);
    await expect(verifyStepUp(t, otherPublicKey, REQ, now)).rejects.toThrow(
      StepUpError,
    );
  });

  it('rejects the wrong audience (a token minted for another client)', async () => {
    const t = await token(privateKey, {}, { aud: 'some-other-client' });
    await expect(verifyStepUp(t, publicKey, REQ, now)).rejects.toThrow(
      StepUpError,
    );
  });

  it('rejects a future auth_time (clock skew / forgery)', async () => {
    const t = await token(privateKey, { auth_time: nowSec + 600 });
    await expect(verifyStepUp(t, publicKey, REQ, now)).rejects.toThrow(
      /future/,
    );
  });

  it('without a requiredAcr, still enforces freshness but not the authenticator', async () => {
    const t = await token(privateKey, { acr: 'password' });
    const res = await verifyStepUp(
      t,
      publicKey,
      { ...REQ, requiredAcr: undefined },
      now,
    );
    expect(res.acr).toBe('password');
  });
});
