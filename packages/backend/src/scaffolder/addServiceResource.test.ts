import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { parse } from 'yaml';
import { createAddServiceResourceAction } from './addServiceResource';

const CLAIM = `apiVersion: platform.refplat.org/v1beta1
kind: XEnvironment
metadata:
  name: alpha-shop-dev
spec:
  team: alpha
  product: shop
  stage: dev
  services:
    web:
      serviceAccount: app-alpha
`;

const setup = (content = CLAIM) => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'addres-'));
  const claimPath = 'gitops/environments/alpha/shop/dev.yaml';
  mkdirSync(dirname(join(workspacePath, claimPath)), { recursive: true });
  writeFileSync(join(workspacePath, claimPath), content);
  return { workspacePath, claimPath };
};

const run = (action: any, workspacePath: string, input: Record<string, unknown>) =>
  action.handler({
    workspacePath,
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });

const base = {
  service: 'web',
  resourceName: 'uploads',
  engine: 's3',
  access: 'readwrite',
  requestedBy: 'user:default/dev-alpha',
};

describe('platform:add-service-resource', () => {
  it('adds the resource with the engine-derived kind + audit annotation', async () => {
    const action = createAddServiceResourceAction();
    const { workspacePath, claimPath } = setup();
    await run(action, workspacePath, { claimPath, ...base });

    const doc = parse(readFileSync(join(workspacePath, claimPath), 'utf8'));
    expect(doc.spec.services.web.resources.uploads).toEqual({
      kind: 'objectstore',
      engine: 's3',
      access: 'readwrite',
    });
    expect(doc.metadata.annotations['platform.refplat.org/requested-by']).toBe(
      'user:default/dev-alpha',
    );
  });

  it.each([
    ['sqs', 'stream'],
    ['sns', 'stream'],
    ['dynamodb', 'keyvalue'],
  ])('derives kind for engine %s -> %s', async (engine, kind) => {
    const action = createAddServiceResourceAction();
    const { workspacePath, claimPath } = setup();
    await run(action, workspacePath, { claimPath, ...base, resourceName: 'r1', engine });
    const doc = parse(readFileSync(join(workspacePath, claimPath), 'utf8'));
    expect(doc.spec.services.web.resources.r1.kind).toBe(kind);
  });

  it('rejects a duplicate resource name', async () => {
    const action = createAddServiceResourceAction();
    const withRes = CLAIM + '      resources:\n        uploads: { kind: objectstore, engine: s3, access: read }\n';
    const { workspacePath, claimPath } = setup(withRes);
    await expect(run(action, workspacePath, { claimPath, ...base })).rejects.toThrow(
      /already exists/,
    );
  });

  it('rejects an unknown service', async () => {
    const action = createAddServiceResourceAction();
    const { workspacePath, claimPath } = setup();
    await expect(
      run(action, workspacePath, { claimPath, ...base, service: 'api' }),
    ).rejects.toThrow(/not declared/);
  });

  it('rejects an invalid resource name', async () => {
    const action = createAddServiceResourceAction();
    const { workspacePath, claimPath } = setup();
    await expect(
      run(action, workspacePath, { claimPath, ...base, resourceName: 'Bad_Name' }),
    ).rejects.toThrow(/must match/);
  });

  it('refuses a non-XEnvironment doc', async () => {
    const action = createAddServiceResourceAction();
    const { workspacePath, claimPath } = setup('kind: XTenant\nmetadata: { name: x }\n');
    await expect(run(action, workspacePath, { claimPath, ...base })).rejects.toThrow(
      /not an XEnvironment/,
    );
  });
});
