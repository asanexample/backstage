/*
 * Pure parsing of a live XTenant claim (platform.refplat.org/v1alpha2) into the shape the Tenant Status card
 * renders (#285, ADR-064 §2). Kept separate from the component so it's unit-tested.
 *
 * The claim's status carries Crossplane-standard conditions (Synced, Ready) + a noisy `Responsive` condition
 * (a watch-throttle artifact that is False on healthy tenants — we IGNORE it), plus status.domains[] (ADR-061
 * per-domain ingress state). The timeline is the on-cluster provisioning journey: Created → Synced → Ready.
 */

export type Phase =
  | 'provisioning'
  | 'ready'
  | 'decommissioning'
  | 'error'
  | 'unknown';

export type StepState = 'done' | 'active' | 'pending' | 'error';

export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
  at?: string;
  /** seconds since the Created step (for the "+Ns" badge) */
  deltaSeconds?: number;
  detail?: string;
}

export interface DomainView {
  host: string;
  state: string;
  active: boolean;
}

export interface TenantStatus {
  phase: Phase;
  createdAt?: string;
  requestedBy?: string;
  lifecyclePhase?: string;
  steps: TimelineStep[];
  domains: DomainView[];
  /** Created → Ready, in seconds (only when Ready). */
  readySeconds?: number;
}

type Condition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

const cond = (xt: any, type: string): Condition | undefined =>
  (xt?.status?.conditions as Condition[] | undefined)?.find(
    c => c.type === type,
  );

const deltaSec = (from?: string, to?: string): number | undefined => {
  if (!from || !to) return undefined;
  const d = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : undefined;
};

export function parseTenantStatus(xt: any): TenantStatus {
  const createdAt: string | undefined = xt?.metadata?.creationTimestamp;
  const annotations = xt?.metadata?.annotations ?? {};
  const requestedBy = annotations['platform.refplat.org/requested-by'];
  const lifecyclePhase =
    xt?.spec?.lifecycle?.phase ??
    annotations['platform.refplat.org/lifecycle-phase'];

  const synced = cond(xt, 'Synced');
  const ready = cond(xt, 'Ready');

  // Overall phase. Decommissioning wins (a deliberate wind-down). A Synced=False is a real reconcile error.
  let phase: Phase;
  if (lifecyclePhase === 'decommissioning' || lifecyclePhase === 'suspended') {
    phase = 'decommissioning';
  } else if (synced?.status === 'False') {
    phase = 'error';
  } else if (ready?.status === 'True') {
    phase = 'ready';
  } else if (createdAt) {
    phase = 'provisioning';
  } else {
    phase = 'unknown';
  }

  let syncedState: StepState = 'active';
  if (synced?.status === 'True') {
    syncedState = 'done';
  } else if (synced?.status === 'False') {
    syncedState = 'error';
  }

  let readyState: StepState = 'pending';
  if (ready?.status === 'True') {
    readyState = 'done';
  } else if (synced?.status === 'True') {
    readyState = 'active'; // synced, still provisioning the footprint
  }

  // A tenant that's been re-synced many times (cutover churn, generation bumps) has condition
  // lastTransitionTimes that no longer form a clean Created → Synced → Ready sequence — Synced re-fires on
  // every reconcile while Ready stays put, so "elapsed since creation" becomes meaningless (even negative).
  // Only surface the +Δ / "time to ready" numbers when the timeline is COHERENT (monotonic forward); a messy
  // mature tenant then degrades to honest absolute timestamps rather than a misleading "provisioned in 7h".
  const tCreated = createdAt ? Date.parse(createdAt) : NaN;
  const tSynced = synced?.lastTransitionTime
    ? Date.parse(synced.lastTransitionTime)
    : NaN;
  const tReady =
    ready?.status === 'True' && ready?.lastTransitionTime
      ? Date.parse(ready.lastTransitionTime)
      : NaN;
  const monotonic = (...ts: number[]): boolean => {
    const known = ts.filter(t => Number.isFinite(t));
    for (let i = 1; i < known.length; i++) {
      if (known[i] < known[i - 1]) return false;
    }
    return true;
  };
  const coherent = monotonic(tCreated, tSynced, tReady);

  const steps: TimelineStep[] = [
    {
      key: 'created',
      label: 'Submitted',
      state: createdAt ? 'done' : 'active',
      at: createdAt,
      detail: requestedBy ? `by ${requestedBy}` : undefined,
    },
    {
      key: 'synced',
      label: 'Synced',
      state: syncedState,
      at: synced?.lastTransitionTime,
      deltaSeconds: coherent
        ? deltaSec(createdAt, synced?.lastTransitionTime)
        : undefined,
      detail: synced?.reason ?? synced?.message,
    },
    {
      key: 'ready',
      label: 'Ready',
      state: readyState,
      at: ready?.status === 'True' ? ready?.lastTransitionTime : undefined,
      deltaSeconds:
        coherent && ready?.status === 'True'
          ? deltaSec(createdAt, ready?.lastTransitionTime)
          : undefined,
      detail:
        ready?.status === 'True' ? ready?.reason ?? 'Available' : undefined,
    },
  ];

  const domains: DomainView[] = (
    (xt?.status?.domains as any[] | undefined) ?? []
  )
    .filter(d => d?.host)
    .map(d => ({
      host: d.host,
      state: d.state ?? 'Pending',
      active: d.state === 'Active',
    }));

  const readySeconds =
    coherent && ready?.status === 'True'
      ? deltaSec(createdAt, ready?.lastTransitionTime)
      : undefined;

  return {
    phase,
    createdAt,
    requestedBy,
    lifecyclePhase,
    steps,
    domains,
    readySeconds,
  };
}
