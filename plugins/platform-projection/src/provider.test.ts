import { buildEntities, ParsedClaim } from './provider';

const claim = (name: string, spec: any): ParsedClaim => ({
  claim: {
    apiVersion: 'platform.refplat.org/v1alpha2',
    kind: 'XTenant',
    metadata: { name },
    spec,
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/tenant-claims/preprod/${name}.yaml`,
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
      buildEntities([alpha], {
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
    });
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
      buildEntities([alpha], {
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
});
