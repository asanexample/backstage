import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { Entity } from '@backstage/catalog-model';
import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import { parse as parseYaml } from 'yaml';

/** The XTenant claim shape (platform.refplat.org/v1alpha2) we read from gitops/tenant-claims. */
export type XTenantClaim = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    team?: string;
    name?: string;
    environment?: string;
    tier?: string;
    domains?: Array<{ host?: string }>;
    apps?: Record<
      string,
      {
        repo?: string;
        repoPath?: string;
        preview?: boolean;
        serviceAccount?: string;
      }
    >;
    developerAccess?: { enabled?: boolean };
    lifecycle?: { phase?: 'active' | 'suspended' | 'decommissioning' };
  };
};

export type ParsedClaim = { claim: XTenantClaim; locationUrl: string };

/** The projected Team CR shape (platform.refplat.org/v1alpha2) we read from gitops/teams. */
export type TeamCR = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    ssoGroup?: string;
    envelope?: {
      allowedTiers?: string[];
      allowedEnvironments?: string[];
      allowedLocations?: string[];
      quotaCap?: { cpu?: string; memory?: string; pods?: number };
      maxDedicatedZones?: number;
    };
  };
};

export type ParsedTeam = { team: TeamCR; locationUrl: string };

export type PlatformProjectionConfig = {
  repoUrl: string;
  claimsPath: string;
  /** Path to the Team CRs (gitops/teams). Each Team CR → a catalog Group, even with no tenants yet. */
  teamsPath: string;
  branch: string;
  ecrRegistry?: string;
};

export type PlatformProjectionOptions = PlatformProjectionConfig & {
  urlReader: UrlReaderService;
  logger: LoggerService;
};

const API_VERSION = 'backstage.io/v1alpha1';

function annotations(locationUrl: string): Record<string, string> {
  const ref = `url:${locationUrl}`;
  return {
    'backstage.io/managed-by-location': ref,
    'backstage.io/managed-by-origin-location': ref,
  };
}

/**
 * Pure, deterministic mapping from Team CRs + XTenant claims to catalog entities (unit-tested).
 *
 * Per Team CR → a Group (every team, even with no tenants yet — so a freshly-onboarded team is immediately
 * visible + pickable; enriched with its envelope + tenant count). Per claim → a System (the tenant, carrying
 * the ADR-049 forward-compat `zone`/`tier` attributes), and a curated set of Resource entities mirroring what
 * the Crossplane Tenant Composition provisions, owned by the team Group and contained by the tenant System.
 * Systems set `owner: group:<team>`, so the team→tenant ownership relations populate once the Group exists.
 * The Composition (infra/modules/crossplane/charts/tenant) is the Resource reference.
 */
export function buildEntities(
  claims: ParsedClaim[],
  teams: ParsedTeam[] = [],
  opts: { ecrRegistry?: string } = {},
): Entity[] {
  const entities: Entity[] = [];

  // Team Group source: the Team CR is authoritative (every team gets a Group). A claim that references a team
  // with no Team CR present (e.g. a git desync) still gets a fallback Group so its System owner never dangles.
  type TeamInfo = {
    locationUrl: string;
    sso?: string;
    envelope?: NonNullable<TeamCR['spec']>['envelope'];
  };
  const teamInfo = new Map<string, TeamInfo>();
  for (const { team, locationUrl } of teams) {
    const name = team.metadata?.name;
    if (!name) continue;
    teamInfo.set(name, { locationUrl, sso: team.spec?.ssoGroup, envelope: team.spec?.envelope });
  }

  // Derived status: tenant count per team (from the claims) — surfaced on the team Group.
  const tenantCount = new Map<string, number>();

  for (const { claim, locationUrl } of claims) {
    const spec = claim.spec ?? {};
    const team = spec.team;
    const tenant = claim.metadata?.name;
    if (!team || !tenant) continue;
    tenantCount.set(team, (tenantCount.get(team) ?? 0) + 1);
    if (!teamInfo.has(team)) teamInfo.set(team, { locationUrl }); // fallback Group for a Team-CR-less claim

    // v2 namespace = <team>-<name>-<env> (Composition v2). metadata.name follows the same convention, but
    // construct it from the spec so the projection is correct even if the two ever diverge.
    const ns =
      spec.name && spec.environment
        ? `${team}-${spec.name}-${spec.environment}`
        : tenant;
    const hosts = (spec.domains ?? [])
      .map(d => d.host)
      .filter((h): h is string => !!h);
    // DESIRED lifecycle phase from the claim spec in git (ADR-062 #283) — NOT live status. The cards
    // (ArgoCD/Kubernetes) and the polished status card (#285) show live Ready/teardown; this is intent.
    const phase = spec.lifecycle?.phase ?? 'active';

    // System per tenant.
    entities.push({
      apiVersion: API_VERSION,
      kind: 'System',
      metadata: {
        name: tenant,
        description: `Tenant "${tenant}" (team ${team})`,
        annotations: {
          ...annotations(locationUrl),
          // ArgoCD plugin (2.4b): the tenant System surfaces ALL of the team's Argo CD Applications, which
          // carry the `platform.refplat.org/tenant=<team>` label (set by the argocd-apps ApplicationSet).
          // instance-name pins our single ArgoCD instance for query performance.
          'argocd/app-selector': `platform.refplat.org/tenant=${team}`,
          'argocd/instance-name': 'platform',
          // Kubernetes plugin (#284): surface the tenant's namespace workloads. The label-selector triggers
          // the plugin's `isKubernetesAvailable` (annotation-presence) filter so the K8s tab attaches; the
          // namespace scopes the query to this tenant. `team=<team>` is the label the demo app workloads carry.
          'backstage.io/kubernetes-namespace': ns,
          'backstage.io/kubernetes-label-selector': `team=${team}`,
          // At-a-glance lifecycle (only when winding down, so the catalog highlights it).
          ...(phase !== 'active'
            ? { 'platform.refplat.org/lifecycle-phase': phase }
            : {}),
        },
        // Tag a non-active tenant so it's filterable/visible in catalog lists.
        ...(phase !== 'active' ? { tags: [phase] } : {}),
        ...(hosts.length
          ? {
              links: hosts.map(h => ({
                url: `https://${h}`,
                title: h,
              })),
            }
          : {}),
      },
      spec: {
        owner: `group:${team}`,
        // ADR-049 placement attributes. Zone/customer stay degenerate (single pooled zone); tier is the v2
        // hardening profile (spec.tier), environment is the promotion stage.
        zone: 'default',
        tier: spec.tier ?? 'standard',
        environment: spec.environment ?? 'dev',
        // Desired lifecycle phase (git intent, #283/#284) — see the `phase` note above.
        lifecyclePhase: phase,
        // customer: omitted (not customer-dedicated)
      },
    });

    // Curated Resources (mirror of the Composition's provisioned resources).
    const resources: Array<{ name: string; type: string; title: string }> = [
      {
        name: ns,
        type: 'kubernetes-namespace',
        title: `${ns} (namespace)`,
      },
      {
        name: `${ns}-quota`,
        type: 'resource-quota',
        title: `${ns} ResourceQuota`,
      },
    ];
    for (const [app, appcfg] of Object.entries(spec.apps ?? {})) {
      // ECR is team-scoped + env-agnostic in v2 (team-<team>/<app>, built once, promoted across stages).
      const repo = `team-${team}/${app}`;
      resources.push({
        name: `ecr-team-${team}-${app}`,
        type: 'ecr-repository',
        title: opts.ecrRegistry ? `${opts.ecrRegistry}/${repo}` : repo,
      });
      // Per-app workload IAM role (v2): Pod-<team>-<name>-<env>-<app>.
      if (appcfg.serviceAccount) {
        resources.push({
          name: `iam-pod-${ns}-${app}`,
          type: 'iam-role',
          title: `Pod-${ns}-${app} (IAM role)`,
        });
      }
    }
    if (spec.developerAccess?.enabled !== false) {
      resources.push({
        name: `iam-developeraccess-${team}`,
        type: 'iam-role',
        title: `DeveloperAccess-${team} (IAM role)`,
      });
    }
    if (opts.ecrRegistry) {
      resources.push({
        name: `kyverno-restrict-images-${ns}`,
        type: 'kyverno-policy',
        title: `restrict-images-${ns}`,
      });
    }
    // Composition v2 always creates restrict-route-hostnames (the generated-host anchor), with or without
    // spec.domains aliases — so project it unconditionally.
    resources.push({
      name: `kyverno-restrict-hostnames-${ns}`,
      type: 'kyverno-policy',
      title: `restrict-route-hostnames-${ns}`,
    });

    for (const r of resources) {
      entities.push({
        apiVersion: API_VERSION,
        kind: 'Resource',
        metadata: {
          name: r.name,
          title: r.title,
          description: `${r.type} provisioned for tenant ${tenant}`,
          annotations: annotations(locationUrl),
        },
        spec: { type: r.type, owner: `group:${team}`, system: tenant },
      });
    }
  }

  // Groups — one per team (every Team CR + any Team-CR-less claim's team), enriched with the team's envelope
  // and tenant count so the team page shows real signal. Deduped: a team with both a Team CR and claims → one
  // Group, sourced from the Team CR. Supersedes the 2.2 seed Groups.
  for (const [team, info] of teamInfo) {
    const env = info.envelope;
    const count = tenantCount.get(team) ?? 0;
    const q = env?.quotaCap;
    const desc: string[] = [];
    if (info.sso) desc.push(`SSO group ${info.sso}`);
    if (env?.allowedTiers?.length) desc.push(`tiers: ${env.allowedTiers.join(', ')}`);
    if (env?.allowedEnvironments?.length)
      desc.push(`envs: ${env.allowedEnvironments.join(', ')}`);
    if (q)
      desc.push(
        `per-tenant quota ${q.cpu ?? '—'} cpu / ${q.memory ?? '—'} / ${q.pods ?? '—'} pods`,
      );
    desc.push(`${count} tenant${count === 1 ? '' : 's'}`);

    entities.push({
      apiVersion: API_VERSION,
      kind: 'Group',
      metadata: {
        name: team,
        title: `Team ${team}`,
        description: desc.join(' · '),
        annotations: {
          ...annotations(info.locationUrl),
          // Structured envelope/usage so a custom team card (or filters) can read it without re-parsing git.
          ...(info.sso ? { 'platform.refplat.org/sso-group': info.sso } : {}),
          ...(env?.allowedTiers?.length
            ? { 'platform.refplat.org/envelope-tiers': env.allowedTiers.join(',') }
            : {}),
          ...(env?.allowedEnvironments?.length
            ? {
                'platform.refplat.org/envelope-environments':
                  env.allowedEnvironments.join(','),
              }
            : {}),
          'platform.refplat.org/tenant-count': String(count),
        },
      },
      spec: { type: 'team', children: [] },
    });
  }

  return entities;
}

/**
 * Reads the platform repo's XTenant claims from git via the configured GitHub App (urlReader) and projects
 * them into the catalog. Runs on a schedule (see the backend module).
 */
export class PlatformProjectionProvider implements EntityProvider {
  private connection?: EntityProviderConnection;

  constructor(private readonly opts: PlatformProjectionOptions) {}

  getProviderName(): string {
    return 'platform-projection';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
  }

  /** Read a repo dir, parse YAML files, and return docs matching the given kind. */
  private async readDocs<T>(
    dir: string,
    kind: string,
  ): Promise<Array<{ doc: T; path: string }>> {
    const { urlReader, logger, repoUrl, branch } = this.opts;
    const out: Array<{ doc: T; path: string }> = [];
    let files;
    try {
      files = await (await urlReader.readTree(
        `${repoUrl}/tree/${branch}/${dir}`,
      )).files();
    } catch (e) {
      logger.warn(`platform-projection: could not read ${dir}: ${e}`);
      return out;
    }
    for (const file of files) {
      if (!/\.ya?ml$/i.test(file.path)) continue;
      let doc: any;
      try {
        doc = parseYaml((await file.content()).toString('utf-8'));
      } catch (e) {
        logger.warn(
          `platform-projection: skipping unparseable ${dir}/${file.path}: ${e}`,
        );
        continue;
      }
      if (
        doc?.kind !== kind ||
        !String(doc?.apiVersion ?? '').startsWith('platform.refplat.org/')
      ) {
        continue;
      }
      out.push({ doc: doc as T, path: file.path });
    }
    return out;
  }

  /** Read the teams + claims trees, parse, and apply a full mutation. */
  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error('platform-projection: not connected');
    }
    const {
      logger,
      repoUrl,
      claimsPath,
      teamsPath,
      branch,
      ecrRegistry,
    } = this.opts;

    // Teams: every Team CR → a Group (even with no tenants). Claims: each XTenant → a System + Resources.
    const teams: ParsedTeam[] = (
      await this.readDocs<TeamCR>(teamsPath, 'Team')
    ).map(({ doc, path }) => ({
      team: doc,
      locationUrl: `${repoUrl}/blob/${branch}/${teamsPath}/${path}`,
    }));
    const claims: ParsedClaim[] = (
      await this.readDocs<XTenantClaim>(claimsPath, 'XTenant')
    ).map(({ doc, path }) => ({
      claim: doc,
      locationUrl: `${repoUrl}/blob/${branch}/${claimsPath}/${path}`,
    }));

    const entities = buildEntities(claims, teams, { ecrRegistry });
    logger.info(
      `platform-projection: ${teams.length} Team(s) + ${claims.length} XTenant claim(s) -> ${entities.length} entit(y/ies)`,
    );

    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({
        entity,
        locationKey: this.getProviderName(),
      })),
    });
  }
}
