import { parseTenantStatus } from './tenantStatus';

const xtenant = (over: any = {}) => ({
  metadata: {
    name: 'alpha-demo-dev',
    creationTimestamp: '2026-06-10T05:29:00Z',
    annotations: { 'platform.refplat.org/requested-by': 'user:default/admin' },
    ...over.metadata,
  },
  spec: over.spec ?? {},
  status: {
    conditions: [
      {
        type: 'Synced',
        status: 'True',
        reason: 'ReconcileSuccess',
        lastTransitionTime: '2026-06-10T05:29:02Z',
      },
      {
        type: 'Ready',
        status: 'True',
        reason: 'Available',
        lastTransitionTime: '2026-06-10T05:29:52Z',
      },
      // The noisy watch-throttle condition that must be ignored.
      {
        type: 'Responsive',
        status: 'False',
        reason: 'WatchCircuitOpen',
        lastTransitionTime: '2026-06-10T14:08:07Z',
      },
    ],
    domains: [
      {
        host: 'demo-alpha-dev.preprod.aws.refplat.org',
        state: 'Active',
        mode: 'platform-managed',
      },
    ],
    ...over.status,
  },
});

describe('parseTenantStatus', () => {
  it('reports a Ready tenant with timing, steps, and domains', () => {
    const s = parseTenantStatus(xtenant());
    expect(s.phase).toBe('ready');
    expect(s.requestedBy).toBe('user:default/admin');
    expect(s.readySeconds).toBe(52); // 05:29:00 → 05:29:52
    const byKey = Object.fromEntries(s.steps.map(st => [st.key, st]));
    expect(byKey.created.state).toBe('done');
    expect(byKey.synced.state).toBe('done');
    expect(byKey.synced.deltaSeconds).toBe(2);
    expect(byKey.ready.state).toBe('done');
    expect(byKey.ready.deltaSeconds).toBe(52);
    expect(s.domains).toEqual([
      {
        host: 'demo-alpha-dev.preprod.aws.refplat.org',
        state: 'Active',
        active: true,
      },
    ]);
  });

  it('IGNORES the noisy Responsive=False condition (not an error)', () => {
    const s = parseTenantStatus(xtenant());
    expect(s.phase).toBe('ready'); // Responsive=False must not flip this to error
    expect(s.steps.some(st => st.state === 'error')).toBe(false);
  });

  it('suppresses misleading deltas when the timeline is incoherent (re-synced tenant)', () => {
    // A mature tenant: Synced re-fired LATER than Ready last transitioned → not monotonic.
    const s = parseTenantStatus(
      xtenant({
        status: {
          conditions: [
            {
              type: 'Synced',
              status: 'True',
              reason: 'ReconcileSuccess',
              lastTransitionTime: '2026-06-10T11:53:50Z',
            },
            {
              type: 'Ready',
              status: 'True',
              reason: 'Available',
              lastTransitionTime: '2026-06-10T10:29:31Z',
            },
          ],
        },
      }),
    );
    expect(s.phase).toBe('ready'); // still Ready — just no bogus timing
    expect(s.readySeconds).toBeUndefined(); // no "provisioned in 7h"
    const byKey = Object.fromEntries(s.steps.map(st => [st.key, st]));
    expect(byKey.synced.deltaSeconds).toBeUndefined();
    expect(byKey.ready.deltaSeconds).toBeUndefined();
    expect(byKey.ready.at).toBe('2026-06-10T10:29:31Z'); // absolute timestamp still shown
  });

  it('shows provisioning when Synced but not yet Ready', () => {
    const s = parseTenantStatus(
      xtenant({
        status: {
          conditions: [
            {
              type: 'Synced',
              status: 'True',
              reason: 'ReconcileSuccess',
              lastTransitionTime: '2026-06-10T05:29:02Z',
            },
            { type: 'Ready', status: 'False', reason: 'Creating' },
          ],
        },
      }),
    );
    expect(s.phase).toBe('provisioning');
    const ready = s.steps.find(st => st.key === 'ready')!;
    expect(ready.state).toBe('active');
    expect(s.readySeconds).toBeUndefined();
  });

  it('flags an error on Synced=False (reconcile error)', () => {
    const s = parseTenantStatus(
      xtenant({
        status: {
          conditions: [
            {
              type: 'Synced',
              status: 'False',
              reason: 'ReconcileError',
              message: 'boom',
            },
          ],
        },
      }),
    );
    expect(s.phase).toBe('error');
    expect(s.steps.find(st => st.key === 'synced')!.state).toBe('error');
  });

  it('reports decommissioning from spec.lifecycle.phase', () => {
    const s = parseTenantStatus(
      xtenant({ spec: { lifecycle: { phase: 'decommissioning' } } }),
    );
    expect(s.phase).toBe('decommissioning');
    expect(s.lifecyclePhase).toBe('decommissioning');
  });

  it('handles a not-yet-synced claim (no status)', () => {
    const s = parseTenantStatus({
      metadata: { name: 'x', creationTimestamp: '2026-06-10T05:29:00Z' },
    });
    expect(s.phase).toBe('provisioning');
    expect(s.domains).toEqual([]);
  });
});
