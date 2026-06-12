import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';

/**
 * Tenant Status card (#285, ADR-064 §2) — a custom overview card that renders the live composite claim's
 * provisioning journey (Submitted → Synced → Ready) + per-domain ingress state. Attaches to any namespace-pinned
 * entity the platform-projection emits: the v2 tenant `System`, or the v3 custom `kind: Environment`. Kind-agnostic
 * on purpose — it matches the kubernetes-namespace annotation (which both carry; the v3 Product System does NOT,
 * so it correctly gets no card). The card reads the target CR via the `platform.refplat.org/cr-*` annotations
 * (v3) and falls back to the v1alpha2 XTenant path (v2).
 */
const tenantStatusCard = EntityCardBlueprint.make({
  name: 'tenantStatus',
  params: {
    filter: {
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
