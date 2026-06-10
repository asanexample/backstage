import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { createSetLifecyclePhaseAction } from './setLifecyclePhase';

const CLAIM = `apiVersion: platform.refplat.org/v1alpha2
kind: XTenant
metadata:
  name: charlie-web-dev
spec:
  team: charlie
  name: web
  environment: dev
  apps:
    web:
      repo: asanexample/app-charlie
      serviceAccount: app-charlie
`;

const setup = (content = CLAIM) => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  const claimPath = 'gitops/tenant-claims/preprod/charlie-web-dev.yaml';
  const dir = join(workspacePath, 'gitops/tenant-claims/preprod');
  require('fs').mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspacePath, claimPath), content);
  return { workspacePath, claimPath };
};

const run = (
  action: any,
  workspacePath: string,
  input: Record<string, unknown>,
) =>
  action.handler({
    workspacePath,
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });

const readClaim = (workspacePath: string, claimPath: string) =>
  parse(readFileSync(join(workspacePath, claimPath), 'utf8'));

describe('platform:set-lifecycle-phase', () => {
  it('decommissions: sets phase + stamps annotations', async () => {
    const action = createSetLifecyclePhaseAction();
    const { workspacePath, claimPath } = setup();
    await run(action, workspacePath, {
      claimPath,
      phase: 'decommissioning',
      confirm: 'charlie-web-dev',
      requestedBy: 'user:default/dev-charlie',
      timestamp: '2026-06-09T00:00:00Z',
    });
    const doc = readClaim(workspacePath, claimPath);
    expect(doc.spec.lifecycle.phase).toBe('decommissioning');
    expect(
      doc.metadata.annotations['platform.refplat.org/decommissioned-at'],
    ).toBe('2026-06-09T00:00:00Z');
    expect(doc.metadata.annotations['platform.refplat.org/requested-by']).toBe(
      'user:default/dev-charlie',
    );
    // spec is otherwise preserved
    expect(doc.spec.apps.web.repo).toBe('asanexample/app-charlie');
  });

  it('reactivates: phase active + clears the decommission marker', async () => {
    const action = createSetLifecyclePhaseAction();
    const decommissioned = CLAIM.replace(
      'metadata:\n  name: charlie-web-dev',
      'metadata:\n  name: charlie-web-dev\n  annotations:\n    platform.refplat.org/decommissioned-at: "2026-06-09T00:00:00Z"',
    );
    const { workspacePath, claimPath } = setup(decommissioned);
    await run(action, workspacePath, {
      claimPath,
      phase: 'active',
      confirm: 'charlie-web-dev',
    });
    const doc = readClaim(workspacePath, claimPath);
    expect(doc.spec.lifecycle.phase).toBe('active');
    expect(
      doc.metadata.annotations['platform.refplat.org/decommissioned-at'],
    ).toBeUndefined();
  });

  it('defaults the decommissioned-at timestamp when none is passed', async () => {
    const action = createSetLifecyclePhaseAction();
    const { workspacePath, claimPath } = setup();
    await run(action, workspacePath, {
      claimPath,
      phase: 'decommissioning',
      confirm: 'charlie-web-dev',
    });
    const doc = readClaim(workspacePath, claimPath);
    expect(
      doc.metadata.annotations['platform.refplat.org/decommissioned-at'],
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects a confirmation that does not match the tenant name', async () => {
    const action = createSetLifecyclePhaseAction();
    const { workspacePath, claimPath } = setup();
    await expect(
      run(action, workspacePath, {
        claimPath,
        phase: 'decommissioning',
        confirm: 'wrong-name',
      }),
    ).rejects.toThrow(/does not match the tenant/);
  });

  it('refuses a non-XTenant file', async () => {
    const action = createSetLifecyclePhaseAction();
    const { workspacePath, claimPath } = setup(
      'kind: ConfigMap\nmetadata:\n  name: x\n',
    );
    await expect(
      run(action, workspacePath, {
        claimPath,
        phase: 'decommissioning',
        confirm: 'x',
      }),
    ).rejects.toThrow(/not an XTenant/);
  });
});
