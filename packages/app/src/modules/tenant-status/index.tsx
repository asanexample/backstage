import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';

/**
 * Tenant Status card (#285, ADR-064 §2) — a custom overview card on the tenant's System entity that renders the
 * live XTenant claim's provisioning journey (Submitted → Synced → Ready) + per-domain ingress state. Attaches
 * only to tenant Systems (which carry the kubernetes-namespace annotation from the platform-projection plugin).
 */
const tenantStatusCard = EntityCardBlueprint.make({
  name: 'tenantStatus',
  params: {
    filter: {
      kind: 'system',
      'metadata.annotations.backstage.io/kubernetes-namespace': {
        $exists: true,
      },
    },
    loader: () =>
      import('./TenantStatusCard').then(m => <m.TenantStatusCard />),
  },
});

export const tenantStatusModule = createFrontendModule({
  pluginId: 'app',
  extensions: [tenantStatusCard],
});
