/*
 * platform:offboard-person (identity strategy §2.5, platform #890 follow-up) — the leaver action backing the
 * Offboard Person template. Removing a Person from the roster (gitops/people/<name>.yaml) is a file DELETION,
 * which the additive publish:github:pull-request action cannot express — so we open the deletion PR directly via
 * the GitHub App (the same mechanism as platform:deprovision-product's purge).
 *
 * Authorization is the People Gate, not this action: a gitops/people deletion is routed to an ACCESS-ADMIN
 * approval (≠ author) by people-gate/publish-verdict, and is never auto-merged — so a bot-authored offboarding
 * PR sits until an admin approves it. This action only opens the proposal (and verifies the Person exists +
 * the typed confirmation), faithful to propose-never-grant.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ScmIntegrations,
  GithubCredentialsProvider,
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';

const DEFAULT_REPO_URL = 'https://github.com/asanexample/platform';

const parseOwnerRepo = (repoUrl: string) => {
  const u = new URL(repoUrl);
  const [owner, repo] = u.pathname
    .replace(/^\//, '')
    .replace(/\.git$/, '')
    .split('/');
  if (!owner || !repo) {
    throw new Error(`cannot parse owner/repo from "${repoUrl}"`);
  }
  return { owner, repo };
};

export interface OffboardPersonOptions {
  integrations: ScmIntegrations;
  githubCredentialsProvider: GithubCredentialsProvider;
  // Test seam: inject a stub Octokit; in production it is built from the GitHub App credentials.
  octokit?: Octokit;
}

const buildOctokit = async (
  options: OffboardPersonOptions,
  repoUrl: string,
): Promise<Octokit> => {
  const apiBaseUrl =
    options.integrations.github.byUrl(repoUrl)?.config.apiBaseUrl ??
    'https://api.github.com';
  const { token } = await options.githubCredentialsProvider.getCredentials({
    url: repoUrl,
  });
  return new Octokit({ auth: token, baseUrl: apiBaseUrl });
};

export const createOffboardPersonAction = (options: OffboardPersonOptions) =>
  createTemplateAction({
    id: 'platform:offboard-person',
    description:
      'Offboards a person: opens a PR deleting gitops/people/<name>.yaml. Authorization is the People Gate (an access-admin approval, never auto-merged); this action only opens the proposal. Uses Octokit (the additive publish action cannot delete files).',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .describe('The Person roster name (the gitops/people/<name>.yaml file).'),
        confirm: z =>
          z
            .string()
            .describe(
              'User-typed confirmation; must equal the roster name (checked server-side).',
            ),
        requestedBy: z =>
          z.string().describe('Requesting user entity ref (audit).').optional(),
        repoUrl: z =>
          z
            .string()
            .describe('Registry repo URL (default the platform repo).')
            .optional(),
        base: z =>
          z.string().describe('Base branch (default main).').optional(),
      },
      output: {
        remoteUrl: z => z.string().describe('URL of the opened PR.'),
        pullRequestNumber: z => z.number().describe('Opened PR number.'),
      },
    },
    async handler(ctx) {
      const name = ctx.input.name;
      const repoUrl = ctx.input.repoUrl ?? DEFAULT_REPO_URL;
      const base = ctx.input.base ?? 'main';

      // Server-side confirmation — a client cannot skip a server-stored step, but the action must not trust the
      // template wiring alone either.
      if (ctx.input.confirm !== name) {
        throw new Error(
          `confirmation "${ctx.input.confirm}" does not match the Person "${name}" — aborting (type the exact roster name to confirm).`,
        );
      }

      const { owner, repo } = parseOwnerRepo(repoUrl);
      const octokit = options.octokit ?? (await buildOctokit(options, repoUrl));
      const path = `gitops/people/${name}.yaml`;

      // The Person must exist — fail fast on a typo'd name rather than opening an empty/no-op PR.
      try {
        await octokit.repos.getContent({ owner, repo, path, ref: base });
      } catch (e: any) {
        if (e.status === 404) {
          throw new Error(
            `no such Person: ${path} does not exist on ${base} — check the roster name.`,
          );
        }
        throw e;
      }

      // Base commit/tree the deletion branch builds on.
      const ref = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${base}`,
      });
      const baseCommitSha = ref.data.object.sha;
      const baseCommit = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: baseCommitSha,
      });
      const baseTreeSha = baseCommit.data.tree.sha;

      const branch = `person/offboard-${name}`;
      const title = `chore(people): offboard ${name}`;
      const body = `**Offboard** \`${name}\` — removes \`${path}\` from the roster.

Requested via the Backstage **Offboard Person** template by ${
        ctx.input.requestedBy ?? 'unknown'
      }.

On merge the generators stop projecting this person: \`identity-center\` (#888, AWS console) and \`keycloak-config\` (#889, app access) drop them on their next apply. **The People Gate authorizes this** — a Person deletion needs an **access-admin** approval (≠ author) and is **never auto-merged**, so this PR waits for that sign-off.

Requested-by: ${ctx.input.requestedBy ?? 'unknown'}`;

      // A null blob sha in the tree DELETES the path.
      const newTree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: [{ path, mode: '100644', type: 'blob', sha: null }],
      });
      const commit = await octokit.git.createCommit({
        owner,
        repo,
        message: `${title}\n\nRequested-by: ${ctx.input.requestedBy ?? 'unknown'}`,
        tree: newTree.data.sha,
        parents: [baseCommitSha],
      });
      try {
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: commit.data.sha,
        });
      } catch (e: any) {
        if (e.status === 422) {
          // branch already exists (a re-run) — fast-forward it
          await octokit.git.updateRef({
            owner,
            repo,
            ref: `heads/${branch}`,
            sha: commit.data.sha,
            force: true,
          });
        } else {
          throw e;
        }
      }

      const pr = await octokit.pulls.create({
        owner,
        repo,
        title,
        head: branch,
        base,
        body,
      });

      ctx.output('remoteUrl', pr.data.html_url);
      ctx.output('pullRequestNumber', pr.data.number);
      ctx.logger.info(`opened ${pr.data.html_url} — offboard ${name}`);
    },
  });
