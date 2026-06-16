/*
 * platform:deprovision-product (Deprovision Product, ADR-062) — the Product-scoped, portal-driven teardown
 * action backing the Deprovision Product template. A Product carries no running resources of its own, so
 * deprovisioning it means acting on ALL of its Environments together:
 *
 *   - mode = decommission | reactivate: reversibly set spec.lifecycle.phase on EVERY Environment claim of the
 *     Product (decommissioning ⇄ active) in ONE commit + PR. Additive, so bot-authored is fine. The gitops
 *     gate detects the suspend transition and does NOT auto-merge it (draining a Product — incl. prod — is
 *     reviewer-merged even though reversible). Branch product/<mode>-<team>-<product>.
 *   - mode = purge: open ONE deletion PR removing the Product registry file + ALL its Environment claims + ALL
 *     its Release records together (the gate's completeness guard permits a single Product+decommissioned-envs
 *     teardown). Branch product/purge-<team>-<product> — the sanctioned purge branch the gate recognises. The
 *     PR is never auto-merged; an admin (+ the release-approver if a prod env is in the bundle) approves it.
 *     On a successful PR open the app repo is archived (reversible; default on).
 *
 * All GitHub work is done directly via Octokit: the additive publish:github:pull-request action cannot express
 * file deletions, and we must enumerate the Product's Environments/Releases server-side. Confirmation and the
 * <team>-<product> binding are enforced HERE — the action never trusts the template wiring alone.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ScmIntegrations,
  GithubCredentialsProvider,
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import { parse, stringify } from 'yaml';

const DECOMMISSIONED_AT = 'platform.refplat.org/decommissioned-at';
const REQUESTED_BY = 'platform.refplat.org/requested-by';
const DEFAULT_REPO_URL = 'https://github.com/asanexample/platform';

const bareTeam = (t: string) => t.replace(/^group:(default\/)?/, '');

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

export interface DeprovisionProductOptions {
  integrations: ScmIntegrations;
  githubCredentialsProvider: GithubCredentialsProvider;
  // Test seam: inject a stub Octokit; in production it is built from the GitHub App credentials.
  octokit?: Octokit;
}

const buildOctokit = async (
  options: DeprovisionProductOptions,
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

export const createDeprovisionProductAction = (
  options: DeprovisionProductOptions,
) =>
  createTemplateAction({
    id: 'platform:deprovision-product',
    description:
      'Deprovisions a Product and ALL its Environments via one PR: decommission/reactivate (reversible phase edit across every env) or purge (delete the Product + its envs + releases; archives the app repo). Opens the PR via Octokit (deletions/enumeration the additive publish action cannot do).',
    schema: {
      input: {
        team: z =>
          z
            .string()
            .describe('Owning team (bare name or group:default/<team>).'),
        product: z => z.string().describe('Product name.'),
        mode: z =>
          z
            .enum(['decommission', 'reactivate', 'purge'])
            .describe(
              'decommission/reactivate = reversible phase edit on all envs; purge = delete the Product + its envs + releases.',
            ),
        confirm: z =>
          z
            .string()
            .describe(
              'User-typed confirmation; must equal "<team>-<product>" (checked server-side).',
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
        archiveRepo: z =>
          z
            .boolean()
            .describe('Archive the app repo on purge (default true).')
            .optional(),
        timestamp: z =>
          z
            .string()
            .describe('ISO timestamp to stamp as decommissioned-at.')
            .optional(),
      },
      output: {
        remoteUrl: z => z.string().describe('URL of the opened PR.'),
        pullRequestNumber: z => z.number().describe('Opened PR number.'),
      },
    },
    async handler(ctx) {
      const mode = ctx.input.mode;
      const team = bareTeam(ctx.input.team);
      const product = ctx.input.product;
      const repoUrl = ctx.input.repoUrl ?? DEFAULT_REPO_URL;
      const base = ctx.input.base ?? 'main';

      // Server-side confirmation — a client cannot skip a server-stored step, but the action must also not
      // trust the template wiring alone.
      const expected = `${team}-${product}`;
      if (ctx.input.confirm !== expected) {
        throw new Error(
          `confirmation "${ctx.input.confirm}" does not match the Product "${expected}" — aborting (type the exact <team>-<product> to confirm).`,
        );
      }

      const { owner, repo } = parseOwnerRepo(repoUrl);
      const octokit = options.octokit ?? (await buildOctokit(options, repoUrl));

      const envDir = `gitops/environments/${team}/${product}`;
      const relDir = `gitops/releases/${team}/${product}`;
      const productPath = `gitops/products/${team}/${product}.yaml`;

      const listYaml = async (dir: string): Promise<string[]> => {
        try {
          const res = await octokit.repos.getContent({
            owner,
            repo,
            path: dir,
            ref: base,
          });
          const items = Array.isArray(res.data) ? res.data : [];
          return items
            .filter(i => i.type === 'file' && /\.ya?ml$/.test(i.name))
            .map(i => i.path);
        } catch (e: any) {
          if (e.status === 404) return []; // no such directory = no envs/releases
          throw e;
        }
      };
      const getFile = async (path: string): Promise<string> => {
        const res = await octokit.repos.getContent({
          owner,
          repo,
          path,
          ref: base,
        });
        const data = res.data as { content?: string; encoding?: string };
        return Buffer.from(
          data.content ?? '',
          (data.encoding as BufferEncoding) ?? 'base64',
        ).toString('utf8');
      };

      const envPaths = await listYaml(envDir);

      // Base commit/tree the new branch will build on.
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

      const ts = ctx.input.timestamp ?? new Date().toISOString();
      let treeEntries: any[];
      let branch: string;
      let title: string;
      let body: string;

      if (mode === 'decommission' || mode === 'reactivate') {
        if (envPaths.length === 0) {
          throw new Error(
            `Product ${team}/${product} has no Environments to ${mode} — a Product with no Environments can be removed directly with mode=purge.`,
          );
        }
        const phase = mode === 'decommission' ? 'decommissioning' : 'active';
        treeEntries = [];
        for (const path of envPaths) {
          const doc = parse(await getFile(path));
          if (!doc || doc.kind !== 'XEnvironment') continue;
          doc.spec = doc.spec ?? {};
          doc.spec.lifecycle = { ...(doc.spec.lifecycle ?? {}), phase };
          doc.metadata.annotations = doc.metadata.annotations ?? {};
          if (phase === 'active') {
            delete doc.metadata.annotations[DECOMMISSIONED_AT];
          } else {
            doc.metadata.annotations[DECOMMISSIONED_AT] = ts;
          }
          if (ctx.input.requestedBy) {
            doc.metadata.annotations[REQUESTED_BY] = ctx.input.requestedBy;
          }
          treeEntries.push({
            path,
            mode: '100644',
            type: 'blob',
            content: stringify(doc),
          });
        }
        branch = `product/${mode}-${team}-${product}`;
        title = `chore(products): ${mode} ${team}-${product}`;
        body =
          mode === 'decommission'
            ? `**Decommission** every Environment of Product \`${team}/${product}\` (ADR-062): spec.lifecycle.phase → decommissioning. The Composition zeroes each ResourceQuota; workloads drain; namespaces/IAM/ECR are retained. **Reversible** — run this template again with mode \`reactivate\`. This PR is NOT auto-merged (draining a Product, incl. prod, is reviewer-merged); a reviewer merges it. The irreversible purge is a separate \`purge\` run.\n\nRequested-by: ${ctx.input.requestedBy ?? 'unknown'}`
            : `**Reactivate** every Environment of Product \`${team}/${product}\` (ADR-062): spec.lifecycle.phase → active; quotas reinstated.\n\nRequested-by: ${ctx.input.requestedBy ?? 'unknown'}`;
      } else {
        // purge — fail fast if any env is still active (the gate's decommission-first guard would reject it).
        const active: string[] = [];
        for (const path of envPaths) {
          const doc = parse(await getFile(path));
          const ph = doc?.spec?.lifecycle?.phase ?? 'active';
          if (ph !== 'decommissioning' && ph !== 'suspended') active.push(path);
        }
        if (active.length) {
          throw new Error(
            `cannot purge ${team}/${product}: these Environments are still active — decommission them first (mode=decommission), let it merge and the grace window pass: ${active.join(
              ', ',
            )}`,
          );
        }
        const relPaths = await listYaml(relDir);
        const toDelete = [productPath, ...envPaths, ...relPaths];
        treeEntries = toDelete.map(path => ({
          path,
          mode: '100644',
          type: 'blob',
          sha: null, // a null blob sha in the tree DELETES the path
        }));
        branch = `product/purge-${team}-${product}`;
        title = `chore(products): purge ${team}-${product}`;
        body = `**Purge** Product \`${team}/${product}\` and ALL its Environments + Releases (ADR-062). Removes:\n${toDelete
          .map(p => `- \`${p}\``)
          .join(
            '\n',
          )}\n\nOn merge: registry-reconcile destroys the per-Product OIDC role / ApplicationSet / Kyverno policy; ArgoCD prunes the Environments (namespaces deleted). **ECR images are retained** (deletionPolicy: Orphan). **Irreversible** — requires an admin/maintainer approval (≠ author)${
          ' and, if a prod env is in the bundle, the release-approver'
        }; never auto-merged. The app repo \`app-${team}-${product}\` is archived (reversible).\n\nRequested-by: ${
          ctx.input.requestedBy ?? 'unknown'
        }`;
      }

      const newTree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: treeEntries,
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
          // branch already exists (a re-run) — fast-forward it to the new commit
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

      if (mode === 'purge' && ctx.input.archiveRepo !== false) {
        const appRepo = `app-${team}-${product}`;
        try {
          await octokit.repos.update({ owner, repo: appRepo, archived: true });
          ctx.logger.info(`archived ${owner}/${appRepo}`);
        } catch (e: any) {
          ctx.logger.warn(
            `could not archive ${owner}/${appRepo} (${e.status ?? e.message}) — archive it manually if desired (needs the App's Administration:write).`,
          );
        }
      }

      ctx.output('remoteUrl', pr.data.html_url);
      ctx.output('pullRequestNumber', pr.data.number);
      ctx.logger.info(
        `opened ${pr.data.html_url} — ${mode} ${team}/${product} (${
          treeEntries.length
        } file(s))`,
      );
    },
  });
