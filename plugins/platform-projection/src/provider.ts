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
      { repo?: string; repoPath?: string; preview?: boolean; serviceAccount?: string }
    >;
    developerAccess?: { enabled?: boolean };
  };
};

export type ParsedClaim = { claim: XTenantClaim; locationUrl: string };

export type PlatformProjectionConfig = {
  repoUrl: string;
  claimsPath: string;
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
 * Pure, deterministic mapping from XTenant claims to catalog entities (unit-tested).
 *
 * Per claim → a Group (per distinct team, deduped), a System (the tenant, carrying the ADR-049
 * forward-compat `zone`/`tier` attributes — degenerate `default`/`standard` today), and a curated set of
 * Resource entities mirroring what the Crossplane Tenant Composition provisions, owned by the team Group and
 * contained by the tenant System. The Composition (infra/modules/crossplane/charts/tenant) is the reference.
 */
export function buildEntities(
  claims: ParsedClaim[],
  opts: { ecrRegistry?: string } = {},
): Entity[] {
  const entities: Entity[] = [];
  // team -> the claim location to attribute the Group to (first seen wins; dedupes teams with >1 claim).
  const teamGroups = new Map<string, string>();

  for (const { claim, locationUrl } of claims) {
    const spec = claim.spec ?? {};
    const team = spec.team;
    const tenant = claim.metadata?.name;
    if (!team || !tenant) continue;

    // v2 namespace = <team>-<name>-<env> (Composition v2). metadata.name follows the same convention, but
    // construct it from the spec so the projection is correct even if the two ever diverge.
    const ns =
      spec.name && spec.environment
        ? `${team}-${spec.name}-${spec.environment}`
        : tenant;
    const hosts = (spec.domains ?? [])
      .map(d => d.host)
      .filter((h): h is string => !!h);

    if (!teamGroups.has(team)) teamGroups.set(team, locationUrl);

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
        },
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

  // Groups (deduped per team) — supersede the 2.2 seed Groups.
  for (const [team, locationUrl] of teamGroups) {
    entities.push({
      apiVersion: API_VERSION,
      kind: 'Group',
      metadata: {
        name: team,
        title: `Team ${team}`,
        description: `Team ${team} (projected from the tenant claim)`,
        annotations: annotations(locationUrl),
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

  /** Read the claims tree, parse + filter to XTenant, and apply a full mutation. */
  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error('platform-projection: not connected');
    }
    const { urlReader, logger, repoUrl, claimsPath, branch, ecrRegistry } =
      this.opts;

    const treeUrl = `${repoUrl}/tree/${branch}/${claimsPath}`;
    const tree = await urlReader.readTree(treeUrl);
    const files = await tree.files();

    const claims: ParsedClaim[] = [];
    for (const file of files) {
      if (!/\.ya?ml$/i.test(file.path)) continue;
      let doc: XTenantClaim | undefined;
      try {
        doc = parseYaml(
          (await file.content()).toString('utf-8'),
        ) as XTenantClaim;
      } catch (e) {
        logger.warn(
          `platform-projection: skipping unparseable ${file.path}: ${e}`,
        );
        continue;
      }
      // Only project XTenant claims — skip kustomization/other YAML living alongside them.
      if (
        doc?.kind !== 'XTenant' ||
        !String(doc?.apiVersion ?? '').startsWith('platform.refplat.org/')
      ) {
        continue;
      }
      claims.push({
        claim: doc,
        locationUrl: `${repoUrl}/blob/${branch}/${claimsPath}/${file.path}`,
      });
    }

    const entities = buildEntities(claims, { ecrRegistry });
    logger.info(
      `platform-projection: ${claims.length} XTenant claim(s) -> ${entities.length} entit(y/ies)`,
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
