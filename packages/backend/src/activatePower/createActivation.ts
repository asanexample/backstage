import { type Reach, type PersonGrant } from './eligibility';

/**
 * Builds + submits the `Activation` custom resource (ADR-088). The CR is created imperatively through the
 * Backstage kubernetes-backend proxy (the pod authenticates to EKS via its own Pod Identity), mirroring the
 * tenant-ready notifier — but a POST, and only after the route has verified a fresh passkey step-up.
 */

const GROUP = 'platform.refplat.org';
const VERSION = 'v1alpha1';
const PLURAL = 'activations';

export interface ActivationRequest {
  /** The verified principal (Keycloak username) — both the borrower and the requester. */
  principal: string;
  role: string;
  reach: Reach;
  /** Go duration string, e.g. "1h"/"30m" (the operator caps it to the role's sessionDuration). */
  duration: string;
  reason: string;
  /** The verified step-up, recorded on the CR for audit. */
  stepUp: { authTime: string; acr?: string };
}

/** A deterministic, k8s-valid name so a duplicate active borrow is an atomic AlreadyExists, not a race. */
export function activationName(
  principal: string,
  role: string,
  reach: Reach,
): string {
  const reachKey = reach.scope ?? reach.team ?? 'unknown';
  return `${principal}-${role}-${reachKey}`.toLowerCase();
}

/** The Activation CR manifest. Pure — unit-tested separately from the HTTP submission. */
export function buildActivationManifest(
  req: ActivationRequest,
): Record<string, unknown> {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'Activation',
    metadata: {
      name: activationName(req.principal, req.role, req.reach),
    },
    spec: {
      principal: req.principal,
      role: req.role,
      reach: req.reach,
      duration: req.duration,
      reason: req.reason,
      requestedBy: req.principal,
      stepUp: req.stepUp,
    },
  };
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

export interface ProxyDeps {
  /** Resolved base URL of the kubernetes plugin (discovery.getBaseUrl('kubernetes')). */
  baseUrl: string;
  /** A Backstage service-to-service token targeting the kubernetes plugin. */
  token: string;
  /** The target cluster name (the `Backstage-Kubernetes-Cluster` header). */
  clusterName: string;
  fetch: FetchLike;
}

export class AlreadyActiveError extends Error {}

/**
 * Resolve a person's grants by their Keycloak identity (front-door eligibility). The caller is the login
 * username (the OIDC `preferred_username` / email local-part), which the People registry records as
 * `spec.person` — NOT the Person record's name (the registry slug differs from the login, e.g. record
 * `alpha-dev` ↔ login `dev-alpha`). So we LIST people and match on `spec.person`, not GET-by-name. Returns []
 * when no person anchors to that login.
 */
export async function getPersonGrants(
  deps: ProxyDeps,
  username: string,
): Promise<PersonGrant[]> {
  const path = `/apis/${GROUP}/v1beta1/people`;
  const res = await proxyRequest(deps, 'GET', path);
  if (!res.ok) {
    throw new Error(`listing people: ${res.status} ${await res.text()}`);
  }
  const body = JSON.parse(await res.text()) as {
    items?: Array<{ spec?: { person?: string; grants?: PersonGrant[] } }>;
  };
  const person = (body.items ?? []).find(p => p.spec?.person === username);
  return person?.spec?.grants ?? [];
}

/** POST the Activation CR. Throws {@link AlreadyActiveError} on a 409 (an active borrow already exists). */
export async function submitActivation(
  deps: ProxyDeps,
  manifest: Record<string, unknown>,
): Promise<{ name: string }> {
  const path = `/apis/${GROUP}/${VERSION}/${PLURAL}`;
  const res = await proxyRequest(deps, 'POST', path, JSON.stringify(manifest));
  if (res.status === 409) {
    throw new AlreadyActiveError(
      'you already have an active borrow of this role — let it expire or revoke it first',
    );
  }
  if (!res.ok) {
    throw new Error(`creating Activation: ${res.status} ${await res.text()}`);
  }
  const created = JSON.parse(await res.text()) as {
    metadata?: { name?: string };
  };
  return { name: created.metadata?.name ?? '' };
}

/** A live borrow, flattened for the Activations page. */
export interface ActivationSummary {
  name: string;
  principal: string;
  role: string;
  reach: Reach;
  reason?: string;
  phase?: string;
  grantedAt?: string;
  expiresAt?: string;
}

type ActivationItem = {
  metadata?: { name?: string };
  spec?: {
    principal?: string;
    role?: string;
    reach?: Reach;
    reason?: string;
  };
  status?: { phase?: string; grantedAt?: string; expiresAt?: string };
};

const toSummary = (it: ActivationItem): ActivationSummary => ({
  name: it.metadata?.name ?? '',
  principal: it.spec?.principal ?? '',
  role: it.spec?.role ?? '',
  reach: it.spec?.reach ?? {},
  reason: it.spec?.reason,
  phase: it.status?.phase,
  grantedAt: it.status?.grantedAt,
  expiresAt: it.status?.expiresAt,
});

/** List all Activations (the caller scopes/filters them). */
export async function listActivations(
  deps: ProxyDeps,
): Promise<ActivationSummary[]> {
  const res = await proxyRequest(
    deps,
    'GET',
    `/apis/${GROUP}/${VERSION}/${PLURAL}`,
  );
  if (!res.ok) {
    throw new Error(`listing activations: ${res.status} ${await res.text()}`);
  }
  const body = JSON.parse(await res.text()) as { items?: ActivationItem[] };
  return (body.items ?? []).map(toSummary);
}

/** Fetch one Activation (to check ownership before revoking). Null on 404. */
export async function getActivation(
  deps: ProxyDeps,
  name: string,
): Promise<ActivationSummary | null> {
  const res = await proxyRequest(
    deps,
    'GET',
    `/apis/${GROUP}/${VERSION}/${PLURAL}/${encodeURIComponent(name)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `reading activation ${name}: ${res.status} ${await res.text()}`,
    );
  }
  return toSummary(JSON.parse(await res.text()) as ActivationItem);
}

/** Delete an Activation — the operator's finalizer revokes every grant. Idempotent (404 = already gone). */
export async function deleteActivation(
  deps: ProxyDeps,
  name: string,
): Promise<void> {
  const res = await proxyRequest(
    deps,
    'DELETE',
    `/apis/${GROUP}/${VERSION}/${PLURAL}/${encodeURIComponent(name)}`,
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `revoking activation ${name}: ${res.status} ${await res.text()}`,
    );
  }
}

async function proxyRequest(
  deps: ProxyDeps,
  method: string,
  path: string,
  body?: string,
) {
  return deps.fetch(`${deps.baseUrl}/proxy${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.token}`,
      'Backstage-Kubernetes-Cluster': deps.clusterName,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
}
