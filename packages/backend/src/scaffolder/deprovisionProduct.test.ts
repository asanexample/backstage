import { parse } from 'yaml';
import { createDeprovisionProductAction } from './deprovisionProduct';

// A fake Octokit covering only the methods the action calls. Env/release listings + file contents are
// canned per-Product; tree/commit/ref/PR calls record their args for assertions.
const envClaim = (
  team: string,
  product: string,
  stage: string,
  phase?: string,
) =>
  `apiVersion: platform.refplat.org/v1beta1
kind: XEnvironment
metadata:
  name: ${team}-${product}-${stage}
spec:
  team: ${team}
  product: ${product}
  stage: ${stage}${phase ? `\n  lifecycle:\n    phase: ${phase}` : ''}
`;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

type Dir = Record<string, string[]>; // path -> [filenames]
type Files = Record<string, string>; // path -> yaml content

const makeOctokit = (dirs: Dir, files: Files) => {
  const calls: any = {
    createTree: [],
    createCommit: [],
    createRef: [],
    pullsCreate: [],
    reposUpdate: [],
    reposDelete: [],
  };
  const octokit: any = {
    repos: {
      getContent: jest.fn(async ({ path }: { path: string }) => {
        if (dirs[path]) {
          return {
            data: dirs[path].map(name => ({
              name,
              path: `${path}/${name}`,
              type: 'file',
            })),
          };
        }
        if (files[path] !== undefined) {
          return { data: { content: b64(files[path]), encoding: 'base64' } };
        }
        const e: any = new Error(`404 ${path}`);
        e.status = 404;
        throw e;
      }),
      update: jest.fn(async (a: any) => {
        calls.reposUpdate.push(a);
        return { data: {} };
      }),
      delete: jest.fn(async (a: any) => {
        calls.reposDelete.push(a);
        return { data: {} };
      }),
    },
    git: {
      getRef: jest.fn(async () => ({ data: { object: { sha: 'basecommit' } } })),
      getCommit: jest.fn(async () => ({ data: { tree: { sha: 'basetree' } } })),
      createTree: jest.fn(async (a: any) => {
        calls.createTree.push(a);
        return { data: { sha: 'newtree' } };
      }),
      createCommit: jest.fn(async (a: any) => {
        calls.createCommit.push(a);
        return { data: { sha: 'newcommit' } };
      }),
      createRef: jest.fn(async (a: any) => {
        calls.createRef.push(a);
        return { data: {} };
      }),
      updateRef: jest.fn(async () => ({ data: {} })),
    },
    pulls: {
      create: jest.fn(async (a: any) => {
        calls.pullsCreate.push(a);
        return {
          data: { html_url: 'https://github.com/asanexample/platform/pull/1', number: 1 },
        };
      }),
    },
  };
  return { octokit, calls };
};

const run = (action: any, input: Record<string, unknown>) => {
  const outputs: Record<string, unknown> = {};
  return action
    .handler({
      input,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      output: (k: string, v: unknown) => {
        outputs[k] = v;
      },
    })
    .then(() => outputs);
};

const makeAction = (octokit: any) =>
  createDeprovisionProductAction({
    integrations: { github: { byUrl: () => undefined } } as any,
    githubCredentialsProvider: { getCredentials: async () => ({ token: 't' }) } as any,
    octokit,
  });

describe('platform:deprovision-product', () => {
  it('purge: deletes the Product + all its envs + releases and archives the app repo', async () => {
    const { octokit, calls } = makeOctokit(
      {
        'gitops/environments/alpha/shop': ['dev.yaml', 'test.yaml'],
        'gitops/releases/alpha/shop': ['dev.yaml'],
      },
      {
        'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning'),
        'gitops/environments/alpha/shop/test.yaml': envClaim('alpha', 'shop', 'test', 'decommissioning'),
      },
    );
    const out = await run(makeAction(octokit), {
      team: 'alpha',
      product: 'shop',
      mode: 'purge',
      confirm: 'alpha-shop',
    });

    const tree = calls.createTree[0].tree;
    const deleted = tree.map((t: any) => t.path).sort();
    expect(deleted).toEqual(
      [
        'gitops/environments/alpha/shop/dev.yaml',
        'gitops/environments/alpha/shop/test.yaml',
        'gitops/products/alpha/shop.yaml',
        'gitops/releases/alpha/shop/dev.yaml',
      ].sort(),
    );
    // every entry is a deletion (null blob sha)
    expect(tree.every((t: any) => t.sha === null)).toBe(true);
    expect(calls.createRef[0].ref).toBe('refs/heads/product/purge-alpha-shop');
    expect(calls.pullsCreate[0].head).toBe('product/purge-alpha-shop');
    expect(calls.reposUpdate[0]).toMatchObject({ repo: 'alpha-shop', archived: true });
    expect(out.remoteUrl).toContain('/pull/1');
  });

  it('purge: refuses while an Environment is still active (decommission-first)', async () => {
    const { octokit } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml', 'prod.yaml'] },
      {
        'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning'),
        'gitops/environments/alpha/shop/prod.yaml': envClaim('alpha', 'shop', 'prod'), // active
      },
    );
    await expect(
      run(makeAction(octokit), { team: 'alpha', product: 'shop', mode: 'purge', confirm: 'alpha-shop' }),
    ).rejects.toThrow(/still active/);
  });

  it('purge: repoAction=keep leaves the repo (no archive, no delete)', async () => {
    const { octokit, calls } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml'] },
      { 'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning') },
    );
    await run(makeAction(octokit), {
      team: 'alpha',
      product: 'shop',
      mode: 'purge',
      confirm: 'alpha-shop',
      repoAction: 'keep',
    });
    expect(calls.reposUpdate).toHaveLength(0);
    expect(calls.reposDelete).toHaveLength(0);
  });

  it('purge: repoAction=delete hard-deletes the app repo (no archive)', async () => {
    const { octokit, calls } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml'] },
      { 'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning') },
    );
    await run(makeAction(octokit), {
      team: 'alpha',
      product: 'shop',
      mode: 'purge',
      confirm: 'alpha-shop',
      repoAction: 'delete',
    });
    expect(calls.reposDelete[0]).toMatchObject({ repo: 'alpha-shop' });
    expect(calls.reposUpdate).toHaveLength(0);
  });

  it('purge: default (no repoAction) archives the app repo', async () => {
    const { octokit, calls } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml'] },
      { 'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning') },
    );
    await run(makeAction(octokit), {
      team: 'alpha',
      product: 'shop',
      mode: 'purge',
      confirm: 'alpha-shop',
    });
    expect(calls.reposUpdate[0]).toMatchObject({ repo: 'alpha-shop', archived: true });
    expect(calls.reposDelete).toHaveLength(0);
  });

  it('decommission: sets phase=decommissioning on every env in one commit', async () => {
    const { octokit, calls } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml', 'test.yaml'] },
      {
        'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev'),
        'gitops/environments/alpha/shop/test.yaml': envClaim('alpha', 'shop', 'test'),
      },
    );
    await run(makeAction(octokit), {
      team: 'alpha',
      product: 'shop',
      mode: 'decommission',
      confirm: 'alpha-shop',
      requestedBy: 'user:default/dev-alpha',
      timestamp: '2026-06-16T00:00:00Z',
    });
    const tree = calls.createTree[0].tree;
    expect(tree).toHaveLength(2);
    for (const entry of tree) {
      expect(entry.sha).toBeUndefined(); // a content edit, not a deletion
      const doc = parse(entry.content);
      expect(doc.spec.lifecycle.phase).toBe('decommissioning');
      expect(doc.metadata.annotations['platform.refplat.org/decommissioned-at']).toBe('2026-06-16T00:00:00Z');
    }
    expect(calls.pullsCreate[0].head).toBe('product/decommission-alpha-shop');
    expect(calls.createCommit).toHaveLength(1); // single commit / atomic fan-out
  });

  it('reactivate: sets phase=active and clears the decommission marker', async () => {
    const { octokit, calls } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml'] },
      { 'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning') },
    );
    await run(makeAction(octokit), {
      team: 'alpha',
      product: 'shop',
      mode: 'reactivate',
      confirm: 'alpha-shop',
    });
    const doc = parse(calls.createTree[0].tree[0].content);
    expect(doc.spec.lifecycle.phase).toBe('active');
    expect(doc.metadata.annotations?.['platform.refplat.org/decommissioned-at']).toBeUndefined();
    expect(calls.pullsCreate[0].head).toBe('product/reactivate-alpha-shop');
  });

  it('rejects a confirmation that does not match <team>-<product>', async () => {
    const { octokit } = makeOctokit({}, {});
    await expect(
      run(makeAction(octokit), { team: 'alpha', product: 'shop', mode: 'purge', confirm: 'wrong' }),
    ).rejects.toThrow(/does not match the Product/);
  });

  it('decommission: errors when the Product has no Environments', async () => {
    const { octokit } = makeOctokit({}, {}); // env dir 404s → no envs
    await expect(
      run(makeAction(octokit), { team: 'alpha', product: 'shop', mode: 'decommission', confirm: 'alpha-shop' }),
    ).rejects.toThrow(/no Environments to decommission/);
  });

  it('normalizes a group ref team and binds confirm to the bare name', async () => {
    const { octokit, calls } = makeOctokit(
      { 'gitops/environments/alpha/shop': ['dev.yaml'] },
      { 'gitops/environments/alpha/shop/dev.yaml': envClaim('alpha', 'shop', 'dev', 'decommissioning') },
    );
    await run(makeAction(octokit), {
      team: 'group:default/alpha',
      product: 'shop',
      mode: 'purge',
      confirm: 'alpha-shop',
    });
    expect(calls.pullsCreate[0].head).toBe('product/purge-alpha-shop');
  });
});
