import { readyTenants, selectToNotify } from './tenantReadyModule';

const xtenant = (over: any = {}) => ({
  metadata: {
    name: over.name ?? 'alpha-demo-dev',
    creationTimestamp: over.createdAt ?? '2026-06-10T05:29:00Z',
    annotations: {
      'platform.refplat.org/requested-by':
        over.requestedBy ?? 'user:default/admin',
      ...(over.lifecycleAnnotation
        ? { 'platform.refplat.org/lifecycle-phase': over.lifecycleAnnotation }
        : {}),
    },
  },
  spec: over.lifecycle ? { lifecycle: { phase: over.lifecycle } } : {},
  status: {
    conditions: [
      {
        type: 'Ready',
        status: over.ready ?? 'True',
        lastTransitionTime: over.readyAt ?? '2026-06-10T05:29:52Z',
      },
      // The noisy watch-throttle condition is irrelevant to the notifier.
      { type: 'Responsive', status: 'False' },
    ],
  },
});

describe('readyTenants', () => {
  it('returns Ready tenants with a transition key, requester, and elapsed seconds', () => {
    expect(readyTenants([xtenant()])).toEqual([
      {
        name: 'alpha-demo-dev',
        key: 'alpha-demo-dev@2026-06-10T05:29:52Z',
        requestedBy: 'user:default/admin',
        readySeconds: 52,
      },
    ]);
  });

  it('excludes tenants that are not Ready=True', () => {
    expect(readyTenants([xtenant({ ready: 'False' })])).toEqual([]);
  });

  it('excludes tenants being wound down even if Ready=True', () => {
    expect(readyTenants([xtenant({ lifecycle: 'decommissioning' })])).toEqual(
      [],
    );
    expect(readyTenants([xtenant({ lifecycle: 'suspended' })])).toEqual([]);
    // also via the projected annotation form
    expect(
      readyTenants([xtenant({ lifecycleAnnotation: 'decommissioning' })]),
    ).toEqual([]);
  });
});

describe('selectToNotify (baseline + dedup)', () => {
  it('first poll baselines already-Ready tenants WITHOUT announcing them', () => {
    const seen = new Set<string>();
    const out = selectToNotify([xtenant()], seen, /* firstPass */ true);
    expect(out).toEqual([]); // no spam on startup
    expect(seen.has('alpha-demo-dev@2026-06-10T05:29:52Z')).toBe(true);
  });

  it('announces a newly-Ready tenant on a subsequent poll, exactly once', () => {
    const seen = new Set<string>();
    selectToNotify([], seen, true); // baseline empty

    const first = selectToNotify([xtenant()], seen, false);
    expect(first.map(t => t.name)).toEqual(['alpha-demo-dev']);

    // Same claim, same Ready time → already seen → not re-announced.
    const second = selectToNotify([xtenant()], seen, false);
    expect(second).toEqual([]);
  });

  it('re-announces when Ready transitions again (e.g. reactivation moves the time)', () => {
    const seen = new Set<string>();
    selectToNotify([xtenant()], seen, false); // announced + seen

    const reactivated = selectToNotify(
      [xtenant({ readyAt: '2026-06-10T18:00:00Z' })],
      seen,
      false,
    );
    expect(reactivated.map(t => t.key)).toEqual([
      'alpha-demo-dev@2026-06-10T18:00:00Z',
    ]);
  });

  it('falls back to broadcast when no requested-by annotation is present', () => {
    const xt = xtenant();
    delete xt.metadata.annotations['platform.refplat.org/requested-by'];
    const seen = new Set<string>();
    const out = selectToNotify([xt], seen, false);
    expect(out[0].requestedBy).toBeUndefined();
  });
});
