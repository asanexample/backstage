import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResolveReleaseDigestAction } from './resolveReleaseDigest';

const DIGEST = `sha256:${'a'.repeat(64)}`;

const RELEASE = (digest = DIGEST, kind = 'Release') => `apiVersion: platform.refplat.org/v1beta1
kind: ${kind}
metadata:
  name: alpha-checkout-staging
spec:
  environmentRef: alpha-checkout-staging
  services:
    web:
      digest: ${digest}
`;

const setup = (content: string, relPath = 'src/staging.yaml') => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'resolve-'));
  mkdirSync(join(workspacePath, 'src'), { recursive: true });
  writeFileSync(join(workspacePath, relPath), content);
  return { workspacePath, relPath };
};

const run = (
  action: any,
  workspacePath: string,
  input: Record<string, unknown>,
) => {
  const outputs: Record<string, unknown> = {};
  return action
    .handler({
      workspacePath,
      input,
      output: (k: string, v: unknown) => {
        outputs[k] = v;
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    })
    .then(() => outputs);
};

describe('platform:resolve-release-digest', () => {
  const action = createResolveReleaseDigestAction();

  it('outputs the Service digest from the source Release', async () => {
    const { workspacePath, relPath } = setup(RELEASE());
    const out = await run(action, workspacePath, {
      releasePath: relPath,
      service: 'web',
    });
    expect(out.digest).toBe(DIGEST);
  });

  it('fails when the Service has no digest in the source Release', async () => {
    const { workspacePath, relPath } = setup(RELEASE());
    await expect(
      run(action, workspacePath, { releasePath: relPath, service: 'api' }),
    ).rejects.toThrow(/no signed digest/);
  });

  it('rejects a malformed digest', async () => {
    const { workspacePath, relPath } = setup(RELEASE('latest'));
    await expect(
      run(action, workspacePath, { releasePath: relPath, service: 'web' }),
    ).rejects.toThrow(/no signed digest/);
  });

  it('refuses a non-Release document', async () => {
    const { workspacePath, relPath } = setup(RELEASE(DIGEST, 'XEnvironment'));
    await expect(
      run(action, workspacePath, { releasePath: relPath, service: 'web' }),
    ).rejects.toThrow(/not a Release/);
  });

  it('fails when the source Release file is absent', async () => {
    const { workspacePath } = setup(RELEASE());
    await expect(
      run(action, workspacePath, {
        releasePath: 'src/missing.yaml',
        service: 'web',
      }),
    ).rejects.toThrow(/not found/);
  });
});
