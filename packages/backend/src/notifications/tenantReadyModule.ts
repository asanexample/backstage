import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { notificationService } from '@backstage/plugin-notifications-node';

/*
 * tenant-ready notifier (#285, ADR-064 §2) — the "you don't have to babysit the page" half of the polished
 * provisioning experience. Polls the workload cluster's XTenant claims on a schedule and, when one newly reaches
 * Ready, fires a notification to the requester so they get pinged the moment their tenant is live.
 *
 * Cluster access reuses the PROVEN path the Tenant Status card uses: the kubernetes-backend proxy. We call it
 * in-process with a service-to-service token (the proxy's `httpAuth.credentials` accepts service principals; the
 * upstream EKS auth is the cluster's own `aws` strategy, independent of the caller), so there's no second auth
 * to wire and no direct K8s client to maintain.
 *
 * Two correctness guards:
 *  - First-poll baseline: the very first poll after startup records the already-Ready tenants WITHOUT notifying,
 *    so a deploy/restart doesn't flood the bell with "alpha/bravo/charlie are ready" for tenants that went Ready
 *    long ago. Only Ready transitions OBSERVED on subsequent polls notify.
 *  - Per-transition key + notification scope: we key on `<name>@<Ready.lastTransitionTime>` (in-memory) and set
 *    a stable notification `scope`, so a tenant is announced once per actual Ready transition (a reactivation,
 *    which moves the condition time, legitimately re-announces).
 */

const DEFAULT_CLUSTER = 'preprod-use1-eks';
const POLL_SECONDS = 30;

type Condition = {
  type?: string;
  status?: string;
  lastTransitionTime?: string;
};

const conditionOf = (xt: any, type: string): Condition | undefined =>
  (xt?.status?.conditions as Condition[] | undefined)?.find(
    c => c.type === type,
  );

const deltaSeconds = (from?: string, to?: string): number | undefined => {
  if (!from || !to) return undefined;
  const d = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : undefined;
};

/** A tenant that has reached Ready and is a candidate to announce. */
export interface ReadyTenant {
  name: string;
  /** `<name>@<Ready.lastTransitionTime>` — the per-transition dedup key. */
  key: string;
  requestedBy?: string;
  readySeconds?: number;
}

/**
 * Pure: the Ready, NOT-winding-down tenants in an XTenant list, each with its transition key. A tenant being
 * decommissioned/suspended can still briefly report Ready=True — those are excluded so we never announce them.
 */
export function readyTenants(items: any[]): ReadyTenant[] {
  const out: ReadyTenant[] = [];
  for (const xt of items ?? []) {
    const ready = conditionOf(xt, 'Ready');
    if (ready?.status !== 'True') continue;

    const phase =
      xt?.spec?.lifecycle?.phase ??
      xt?.metadata?.annotations?.['platform.refplat.org/lifecycle-phase'];
    if (phase === 'decommissioning' || phase === 'suspended') continue;

    const name: string = xt?.metadata?.name ?? 'unknown';
    out.push({
      name,
      key: `${name}@${ready.lastTransitionTime ?? ''}`,
      requestedBy:
        xt?.metadata?.annotations?.['platform.refplat.org/requested-by'],
      readySeconds: deltaSeconds(
        xt?.metadata?.creationTimestamp,
        ready.lastTransitionTime,
      ),
    });
  }
  return out;
}

/**
 * Pure (mutates `seen`): given an XTenant list, the keys already accounted for, and whether this is the first
 * poll, return the tenants to announce. On the first poll the result is ALWAYS empty — it only baselines `seen`
 * (already-Ready tenants), so a deploy/restart never floods the bell. Subsequent polls announce only newly-Ready
 * transitions (unseen keys).
 */
export function selectToNotify(
  items: any[],
  seen: Set<string>,
  firstPass: boolean,
): ReadyTenant[] {
  const out: ReadyTenant[] = [];
  for (const t of readyTenants(items)) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    if (firstPass) continue;
    out.push(t);
  }
  return out;
}

export default createBackendModule({
  pluginId: 'notifications',
  moduleId: 'tenant-ready-notifier',
  register(reg) {
    reg.registerInit({
      deps: {
        notifications: notificationService,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
      },
      async init({
        notifications,
        scheduler,
        auth,
        discovery,
        logger,
        config,
      }) {
        const clusterName =
          config.getOptionalString('tenantStatus.clusterName') ??
          DEFAULT_CLUSTER;

        // Set of `<name>@<Ready.lastTransitionTime>` already accounted for (notified, or baselined at startup).
        const seen = new Set<string>();
        let baselined = false;

        const poll = async () => {
          const baseUrl = await discovery.getBaseUrl('kubernetes');
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'kubernetes',
          });

          const res = await fetch(
            `${baseUrl}/proxy/apis/platform.refplat.org/v1alpha2/xtenants`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Backstage-Kubernetes-Cluster': clusterName,
              },
            },
          );
          if (!res.ok) {
            // 403 here means the reader RBAC (backstage-read-tenant-api) isn't in place yet; log and move on.
            logger.warn(
              `tenant-ready notifier: XTenant list failed: ${res.status} ${res.statusText}`,
            );
            return;
          }

          const body = (await res.json()) as { items?: any[] };
          const firstPass = !baselined;
          const toNotify = selectToNotify(body.items ?? [], seen, firstPass);

          for (const t of toNotify) {
            await notifications.send({
              recipients: t.requestedBy
                ? { type: 'entity', entityRef: t.requestedBy }
                : { type: 'broadcast' },
              payload: {
                title: `Tenant ${t.name} is ready`,
                description:
                  typeof t.readySeconds === 'number'
                    ? `Provisioned in ${t.readySeconds}s — open the dashboard to see its endpoints and resources.`
                    : 'Your tenant has finished provisioning — open the dashboard to see its endpoints and resources.',
                link: `/catalog/default/system/${t.name}`,
                severity: 'normal',
                topic: 'tenant-provisioning',
                scope: `tenant-ready:${t.name}`,
              },
            });
          }

          if (firstPass) {
            baselined = true;
            logger.info(
              `tenant-ready notifier: baselined ${seen.size} already-Ready tenant(s) on ${clusterName}`,
            );
          } else if (toNotify.length > 0) {
            logger.info(
              `tenant-ready notifier: announced ${toNotify.length} newly-Ready tenant(s)`,
            );
          }
        };

        await scheduler.scheduleTask({
          id: 'tenant-ready-notifier',
          frequency: { seconds: POLL_SECONDS },
          timeout: { minutes: 2 },
          fn: async () => {
            try {
              await poll();
            } catch (e) {
              logger.warn(
                `tenant-ready notifier poll failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          },
        });

        logger.info(
          `tenant-ready notifier: watching XTenants on ${clusterName} every ${POLL_SECONDS}s`,
        );
      },
    });
  },
});
