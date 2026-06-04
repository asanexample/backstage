import { buildEntities, ParsedClaim } from './provider';

const claim = (name: string, spec: any): ParsedClaim => ({
  claim: {
    apiVersion: 'platform.refplat.org/v1alpha1',
    kind: 'XTenant',
    metadata: { name },
    spec,
  },
  locationUrl: `https://github.com/asanexample/platform/blob/main/gitops/tenant-claims/preprod/${name}.yaml`,
});

const byKind = (es: ReturnType<typeof buildEntities>, kind: string) =>
  es.filter(e => e.kind === kind);

describe('buildEntities', () => {
  const alpha = claim('alpha', {
    team: 'alpha',
    hostnames: ['demo.preprod.aws.refplat.org'],
    apps: { demo: { repoPath: 'k8s/preprod', preview: true } },
    aws: { serviceAccount: 'app-alpha' },
  });

  it('emits a System owned by the team Group with ADR-049 forward-compat attributes', () => {
    const sys = byKind(
      buildEntities([alpha], {
        ecrRegistry: 'acct.dkr.ecr.us-east-1.amazonaws.com',
      }),
      'System',
    );
    expect(sys).toHaveLength(1);
    expect(sys[0].metadata.name).toBe('alpha');
    expect(sys[0].spec).toMatchObject({
      owner: 'group:alpha',
      zone: 'default',
      tier: 'standard',
    });
  });

  it('derives tier from complianceTier when set', () => {
    const sys = byKind(
      buildEntities([claim('reg', { team: 'reg', complianceTier: 'pci' })]),
      'System',
    );
    expect(sys[0].spec).toMatchObject({ tier: 'pci' });
  });

  it('emits a team Group, deduped across multiple claims for the same team', () => {
    const groups = byKind(
      buildEntities([alpha, claim('alpha2', { team: 'alpha' })]),
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
        'team-alpha',
        'team-alpha-quota',
        'ecr-team-alpha-demo',
        'iam-pod-team-alpha', // aws.serviceAccount set
        'iam-developeraccess-alpha', // developerAccess defaults enabled
        'kyverno-restrict-images-team-alpha', // ecrRegistry set
        'kyverno-restrict-hostnames-team-alpha', // hostnames set
      ]),
    );
    for (const r of res) {
      expect(r.spec).toMatchObject({ owner: 'group:alpha', system: 'alpha' });
    }
    // entity names must be valid (no '/')
    for (const n of names) expect(n).not.toMatch(/\//);
  });

  it('omits conditional Resources when their claim fields are absent', () => {
    const res = byKind(
      buildEntities([
        claim('bare', { team: 'bare', developerAccess: { enabled: false } }),
      ]),
      'Resource',
    );
    const names = res.map(r => r.metadata.name);
    expect(names).toEqual(['team-bare', 'team-bare-quota']); // no apps/aws/hostnames/ecrRegistry, dev access off
  });

  it('skips claims missing team or name', () => {
    expect(
      buildEntities([{ claim: { spec: {} } as any, locationUrl: 'x' }]),
    ).toHaveLength(0);
  });
});
