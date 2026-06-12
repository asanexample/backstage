import {
  buildEntities,
  buildV3Entities,
  nsFor,
  ParsedClaim,
  ParsedEnvironment,
  ParsedProduct,
  ParsedTeam,
} from './provider';

const claim = (name: string, spec: any): ParsedClaim => ({
  claim: {
    apiVersion: 'platform.refplat.org/v1alpha2',
    kind: 'XTenant',
    metadata: { name },
    spec,
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/tenant-claims/preprod/${name}.yaml`,
});

const team = (name: string, spec: any = {}): ParsedTeam => ({
  team: {
    apiVersion: 'platform.refplat.org/v1alpha2',
    kind: 'Team',
    metadata: { name },
    spec,
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/teams/${name}.yaml`,
});

const byKind = (es: ReturnType<typeof buildEntities>, kind: string) =>
  es.filter(e => e.kind === kind);

describe('buildEntities', () => {
  // v1alpha2 claim: Team alpha / Tenant demo / stage dev → namespace alpha-demo-dev.
  const alpha = claim('alpha-demo-dev', {
    team: 'alpha',
    name: 'demo',
    environment: 'dev',
    tier: 'standard',
    domains: [{ host: 'shop.preprod.aws.refplat.org' }],
    apps: {
      demo: {
        repo: 'asanexample/app-alpha',
        repoPath: 'k8s/preprod',
        preview: true,
        serviceAccount: 'app-alpha',
      },
    },
  });

  it('emits a System owned by the team Group with ADR-049 placement attributes', () => {
    const sys = byKind(
      buildEntities([alpha], [], {
        ecrRegistry: 'acct.dkr.ecr.us-east-1.amazonaws.com',
      }),
      'System',
    );
    expect(sys).toHaveLength(1);
    expect(sys[0].metadata.name).toBe('alpha-demo-dev');
    expect(sys[0].spec).toMatchObject({
      owner: 'group:alpha',
      zone: 'default',
      tier: 'standard',
      environment: 'dev',
      lifecyclePhase: 'active',
    });
  });

  it('stamps the ArgoCD + Kubernetes plugin annotations for the provisioning-status cards (#284)', () => {
    const sys = byKind(buildEntities([alpha]), 'System');
    expect(sys[0].metadata.annotations).toMatchObject({
      'argocd/app-selector': 'platform.refplat.org/tenant=alpha',
      'argocd/instance-name': 'platform',
      'backstage.io/kubernetes-namespace': 'alpha-demo-dev',
      'backstage.io/kubernetes-label-selector': 'team=alpha',
    });
    // An active tenant carries no lifecycle tag/annotation.
    expect(sys[0].metadata.tags ?? []).not.toContain('decommissioning');
    expect(
      sys[0].metadata.annotations?.['platform.refplat.org/lifecycle-phase'],
    ).toBeUndefined();
  });

  it('surfaces a non-active lifecycle phase (#283/#284): spec field + tag + annotation', () => {
    const sys = byKind(
      buildEntities([
        claim('alpha-demo-dev', {
          team: 'alpha',
          name: 'demo',
          environment: 'dev',
          lifecycle: { phase: 'decommissioning' },
        }),
      ]),
      'System',
    );
    expect(sys[0].spec).toMatchObject({ lifecyclePhase: 'decommissioning' });
    expect(sys[0].metadata.tags).toContain('decommissioning');
    expect(
      sys[0].metadata.annotations?.['platform.refplat.org/lifecycle-phase'],
    ).toBe('decommissioning');
  });

  it('derives tier from spec.tier when set', () => {
    const sys = byKind(
      buildEntities([
        claim('reg-api-prod', {
          team: 'reg',
          name: 'api',
          environment: 'prod',
          tier: 'pci',
        }),
      ]),
      'System',
    );
    expect(sys[0].spec).toMatchObject({ tier: 'pci', environment: 'prod' });
  });

  it('emits a team Group, deduped across multiple claims for the same team', () => {
    const groups = byKind(
      buildEntities([
        alpha,
        claim('alpha-demo-test', {
          team: 'alpha',
          name: 'demo',
          environment: 'test',
        }),
      ]),
      'Group',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].metadata.name).toBe('alpha');
    expect(groups[0].spec).toMatchObject({ type: 'team' });
  });

  it('emits curated Resources owned by the Group and contained by the System', () => {
    const res = byKind(
      buildEntities([alpha], [], {
        ecrRegistry: 'acct.dkr.ecr.us-east-1.amazonaws.com',
      }),
      'Resource',
    );
    const names = res.map(r => r.metadata.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'alpha-demo-dev', // namespace <team>-<name>-<env>
        'alpha-demo-dev-quota',
        'ecr-team-alpha-demo', // ECR stays team-scoped (team-<team>/<app>)
        'iam-pod-alpha-demo-dev-demo', // per-app role Pod-<team>-<name>-<env>-<app>
        'iam-developeraccess-alpha', // developerAccess defaults enabled
        'kyverno-restrict-images-alpha-demo-dev', // per-namespace name; ecrRegistry set
        'kyverno-restrict-hostnames-alpha-demo-dev', // per-namespace name; always present
      ]),
    );
    for (const r of res) {
      expect(r.spec).toMatchObject({
        owner: 'group:alpha',
        system: 'alpha-demo-dev',
      });
    }
    // entity names must be valid (no '/')
    for (const n of names) expect(n).not.toMatch(/\//);
  });

  it('omits conditional Resources when their claim fields are absent', () => {
    const res = byKind(
      buildEntities([
        claim('bare-svc-dev', {
          team: 'bare',
          name: 'svc',
          environment: 'dev',
          developerAccess: { enabled: false },
        }),
      ]),
      'Resource',
    );
    const names = res.map(r => r.metadata.name);
    // No apps/ecrRegistry, dev access off → namespace, quota, and the always-present route-hostname policy.
    expect(names).toEqual([
      'bare-svc-dev',
      'bare-svc-dev-quota',
      'kyverno-restrict-hostnames-bare-svc-dev',
    ]);
  });

  it('skips claims missing team or name', () => {
    expect(
      buildEntities([{ claim: { spec: {} } as any, locationUrl: 'x' }]),
    ).toHaveLength(0);
  });

  it('emits a Group for a Team CR with NO tenants yet (a freshly-onboarded team)', () => {
    const groups = byKind(
      buildEntities(
        [],
        [
          team('delta', {
            ssoGroup: 'Dev-delta',
            envelope: {
              allowedTiers: ['standard'],
              allowedEnvironments: ['dev', 'test'],
              quotaCap: { cpu: '8', memory: '16Gi', pods: 40 },
            },
          }),
        ],
      ),
      'Group',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].metadata.name).toBe('delta');
    expect(groups[0].spec).toMatchObject({ type: 'team' });
    // enriched with envelope + a 0-tenant count
    const ann = groups[0].metadata.annotations ?? {};
    expect(ann['platform.refplat.org/sso-group']).toBe('Dev-delta');
    expect(ann['platform.refplat.org/envelope-tiers']).toBe('standard');
    expect(ann['platform.refplat.org/envelope-environments']).toBe('dev,test');
    expect(ann['platform.refplat.org/tenant-count']).toBe('0');
    expect(groups[0].metadata.description).toContain('0 tenants');
  });

  it('a team with BOTH a Team CR and claims yields ONE Group, sourced from the Team CR', () => {
    const es = buildEntities(
      [alpha, claim('alpha-demo-test', { team: 'alpha', name: 'demo', environment: 'test' })],
      [team('alpha', { ssoGroup: 'Dev-alpha', envelope: { allowedTiers: ['standard'], allowedEnvironments: ['dev'] } })],
    );
    const groups = byKind(es, 'Group');
    expect(groups).toHaveLength(1);
    expect(groups[0].metadata.name).toBe('alpha');
    // attributed to the Team CR file, enriched, and counting its 2 tenants
    expect(groups[0].metadata.annotations?.['backstage.io/managed-by-location']).toContain('gitops/teams/alpha.yaml');
    expect(groups[0].metadata.annotations?.['platform.refplat.org/sso-group']).toBe('Dev-alpha');
    expect(groups[0].metadata.annotations?.['platform.refplat.org/tenant-count']).toBe('2');
    // the System still owns up to the Group
    expect(byKind(es, 'System')[0].spec).toMatchObject({ owner: 'group:alpha' });
  });

  it('still emits a fallback Group for a claim whose Team CR is absent (git desync)', () => {
    const groups = byKind(
      buildEntities([claim('ghost-svc-dev', { team: 'ghost', name: 'svc', environment: 'dev' })], []),
      'Group',
    );
    expect(groups.map(g => g.metadata.name)).toEqual(['ghost']);
  });
});

// ---------------------------------------------------------------------------
// v3 (ADR-067 §10) projection — Product=System, Environment=custom kind, Team=Group.
// ---------------------------------------------------------------------------

const product = (
  team: string,
  short: string,
  spec: any = {},
): ParsedProduct => ({
  product: {
    apiVersion: 'platform.refplat.org/v1alpha3',
    kind: 'Product',
    metadata: { name: `${team}-${short}` },
    spec: { team, repo: `asanexample/${team}-${short}`, ...spec },
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/products/${team}/${short}.yaml`,
});

const environment = (
  name: string,
  spec: any,
): ParsedEnvironment => ({
  env: {
    apiVersion: 'platform.refplat.org/v1alpha3',
    kind: 'XEnvironment',
    metadata: { name },
    spec,
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/environments/${spec.team}/${spec.product}/${spec.stage}.yaml`,
});

const v3team = (name: string, spec: any = {}): ParsedTeam => ({
  team: {
    apiVersion: 'platform.refplat.org/v1alpha3',
    kind: 'Team',
    metadata: { name },
    spec,
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/teams/${name}.yaml`,
});

const v3 = (es: ReturnType<typeof buildV3Entities>, kind: string) =>
  es.filter(e => e.kind === kind);

describe('nsFor', () => {
  it('matches <team>-<product>-<stage> for short names', () => {
    expect(nsFor('alpha', 'demo', 'dev')).toBe('alpha-demo-dev');
  });
  it('inserts the customer segment before the stage', () => {
    expect(nsFor('alpha', 'shop', 'prod', 'acme')).toBe('alpha-shop-acme-prod');
  });
  it('truncate-and-hashes names over 63 chars (first 56 + 6-hex sha256)', () => {
    const ns = nsFor('teamteamteam', 'productproductproduct', 'staging', 'customercustomercustomer');
    expect(ns.length).toBeLessThanOrEqual(63);
    expect(ns).toMatch(/^.{56}-[0-9a-f]{6}$/);
  });
});

describe('buildV3Entities', () => {
  const ECR = 'acct.dkr.ecr.us-east-1.amazonaws.com';
  const demo = product('alpha', 'demo', {
    tenancy: 'pooled',
    domains: ['demo.preprod.aws.refplat.org'],
  });
  const demoDev = environment('demo-dev', {
    team: 'alpha',
    product: 'demo',
    stage: 'dev',
    tier: 'standard',
    services: { web: { serviceAccount: 'demo-web' } },
  });

  it('projects a Product as a System owned by the team Group', () => {
    const sys = v3(buildV3Entities([demo], [], []), 'System');
    expect(sys).toHaveLength(1);
    expect(sys[0].metadata.name).toBe('alpha-demo');
    expect(sys[0].spec).toMatchObject({ owner: 'group:alpha', tenancy: 'pooled' });
    // ArgoCD selector spans the whole product; repo surfaced; domains → links.
    expect(sys[0].metadata.annotations?.['argocd/app-selector']).toBe(
      'platform.refplat.org/team=alpha,platform.refplat.org/product=demo',
    );
    expect(sys[0].metadata.annotations?.['github.com/project-slug']).toBe('asanexample/alpha-demo');
    expect(sys[0].metadata.links?.[0].url).toBe('https://demo.preprod.aws.refplat.org');
  });

  it('projects an XEnvironment as a custom kind Environment in its Product System', () => {
    const envs = v3(buildV3Entities([demo], [demoDev], []), 'Environment');
    expect(envs).toHaveLength(1);
    const e = envs[0];
    expect(e.metadata.name).toBe('alpha-demo-dev');
    expect(e.spec).toMatchObject({
      owner: 'group:alpha',
      system: 'alpha-demo',
      product: 'alpha-demo',
      stage: 'dev',
      tier: 'standard',
      lifecyclePhase: 'active',
    });
    // namespace-pinned + the live-status CR pointer (xenvironments v1alpha3) for the #285 card.
    expect(e.metadata.annotations?.['backstage.io/kubernetes-namespace']).toBe('alpha-demo-dev');
    expect(e.metadata.annotations?.['platform.refplat.org/cr-plural']).toBe('xenvironments');
    expect(e.metadata.annotations?.['platform.refplat.org/cr-version']).toBe('v1alpha3');
    expect(e.metadata.annotations?.['platform.refplat.org/cr-name']).toBe('demo-dev');
  });

  it('mirrors the Composition footprint as product-scoped Resources contained by the System', () => {
    const res = v3(buildV3Entities([demo], [demoDev], [], { ecrRegistry: ECR }), 'Resource');
    const titles = res.map(r => r.metadata.title);
    // product-scoped ECR team-<team>/<product>-<svc>, per-service Pod role, the per-ns policies.
    expect(titles).toContain(`${ECR}/team-alpha/demo-web`);
    expect(res.find(r => r.metadata.name === 'iam-pod-alpha-demo-dev-web')?.metadata.title).toBe(
      'Pod-alpha-demo-dev-web (IAM role)',
    );
    expect(res.every(r => r.spec?.system === 'alpha-demo')).toBe(true);
    expect(res.some(r => r.metadata.title === 'restrict-images-alpha-demo-dev')).toBe(true);
  });

  it('places a per-customer prod env in the customer-suffixed namespace', () => {
    const shop = product('alpha', 'shop', { tenancy: 'per-customer' });
    const env = environment('shop-acme-prod', {
      team: 'alpha',
      product: 'shop',
      stage: 'prod',
      customer: 'acme',
      services: { api: { serviceAccount: 'shop-api' } },
    });
    const e = v3(buildV3Entities([shop], [env], []), 'Environment')[0];
    expect(e.metadata.name).toBe('alpha-shop-acme-prod');
    expect(e.spec).toMatchObject({ customer: 'acme', stage: 'prod' });
    expect(e.metadata.annotations?.['backstage.io/kubernetes-namespace']).toBe('alpha-shop-acme-prod');
  });

  it('tags a decommissioning env and carries the lifecycle phase', () => {
    const env = environment('demo-dev', {
      team: 'alpha',
      product: 'demo',
      stage: 'dev',
      lifecycle: { phase: 'decommissioning' },
    });
    const e = v3(buildV3Entities([demo], [env], []), 'Environment')[0];
    expect(e.metadata.tags).toEqual(['decommissioning']);
    expect(e.metadata.annotations?.['platform.refplat.org/lifecycle-phase']).toBe('decommissioning');
    expect(e.spec?.lifecyclePhase).toBe('decommissioning');
  });

  it('emits a Group per team enriched with the envelope (v1alpha3 allowedStages) + product count', () => {
    const es = buildV3Entities(
      [demo, product('alpha', 'shop', { tenancy: 'per-customer' })],
      [demoDev],
      [
        v3team('alpha', {
          ssoGroup: 'Dev-alpha',
          envelope: {
            allowedTiers: ['standard'],
            allowedStages: ['dev', 'prod'],
            quotaCap: { cpu: '8', memory: '16Gi', pods: 40 },
          },
        }),
      ],
    );
    const g = v3(es, 'Group');
    expect(g).toHaveLength(1);
    expect(g[0].metadata.annotations?.['platform.refplat.org/product-count']).toBe('2');
    expect(g[0].metadata.annotations?.['platform.refplat.org/envelope-stages']).toBe('dev,prod');
    expect(g[0].metadata.annotations?.['platform.refplat.org/sso-group']).toBe('Dev-alpha');
  });

  it('tolerates a v1alpha2 Team envelope (allowedEnvironments) across the cutover boundary', () => {
    const es = buildV3Entities(
      [demo],
      [],
      [v3team('alpha', { envelope: { allowedEnvironments: ['dev', 'test'] } })],
    );
    const g = v3(es, 'Group')[0];
    expect(g.metadata.annotations?.['platform.refplat.org/envelope-stages']).toBe('dev,test');
  });

  it('emits a fallback Group for an environment whose Team CR / Product is absent (git desync)', () => {
    const es = buildV3Entities(
      [],
      [environment('ghost-svc-dev', { team: 'ghost', product: 'svc', stage: 'dev' })],
      [],
    );
    expect(v3(es, 'Group').map(g => g.metadata.name)).toEqual(['ghost']);
    // the Environment still owns up to the (fallback) Group and references its product System.
    expect(v3(es, 'Environment')[0].spec).toMatchObject({ owner: 'group:ghost', system: 'ghost-svc' });
  });
});
