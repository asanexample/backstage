import { createOffboardPersonAction } from './offboardPerson';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// A fake Octokit covering only the methods the action calls. `files` maps path -> content (present = exists).
const makeOctokit = (files: Record<string, string>) => {
  const calls: any = {
    createTree: [],
    createCommit: [],
    createRef: [],
    pullsCreate: [],
  };
  const octokit: any = {
    repos: {
      getContent: jest.fn(async ({ path }: { path: string }) => {
        if (files[path] !== undefined) {
          return { data: { content: b64(files[path]), encoding: 'base64' } };
        }
        const e: any = new Error(`404 ${path}`);
        e.status = 404;
        throw e;
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
          data: {
            html_url: 'https://github.com/asanexample/platform/pull/1',
            number: 1,
          },
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
  createOffboardPersonAction({
    integrations: { github: { byUrl: () => undefined } } as any,
    githubCredentialsProvider: {
      getCredentials: async () => ({ token: 't' }),
    } as any,
    octokit,
  });

describe('platform:offboard-person', () => {
  it('opens a deletion PR removing the Person file on a person/offboard-<name> branch', async () => {
    const { octokit, calls } = makeOctokit({
      'gitops/people/sarah-chen.yaml': 'kind: Person\n',
    });
    const out = await run(makeAction(octokit), {
      name: 'sarah-chen',
      confirm: 'sarah-chen',
      requestedBy: 'user:default/josh',
    });

    const tree = calls.createTree[0].tree;
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe('gitops/people/sarah-chen.yaml');
    expect(tree[0].sha).toBeNull(); // null blob sha = deletion
    expect(calls.createRef[0].ref).toBe('refs/heads/person/offboard-sarah-chen');
    expect(calls.pullsCreate[0].head).toBe('person/offboard-sarah-chen');
    expect(calls.pullsCreate[0].base).toBe('main');
    expect(out.remoteUrl).toContain('/pull/1');
    expect(out.pullRequestNumber).toBe(1);
  });

  it('refuses when the confirmation does not match the roster name', async () => {
    const { octokit } = makeOctokit({
      'gitops/people/sarah-chen.yaml': 'kind: Person\n',
    });
    await expect(
      run(makeAction(octokit), { name: 'sarah-chen', confirm: 'wrong' }),
    ).rejects.toThrow(/does not match/);
  });

  it('refuses when the Person does not exist', async () => {
    const { octokit } = makeOctokit({});
    await expect(
      run(makeAction(octokit), { name: 'ghost', confirm: 'ghost' }),
    ).rejects.toThrow(/no such Person/);
  });
});
