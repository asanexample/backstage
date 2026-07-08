import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
// Kubernetes plugin (Phase 2.4a): adds the live "Kubernetes" tab to Component entities. The backend reads
// the platform + preprod clusters read-only via EKS Pod Identity (see infra/modules/backstage). Components
// match k8s objects through the `backstage.io/kubernetes-label-selector` annotation in their catalog-info.yaml.
import kubernetesPlugin from '@backstage/plugin-kubernetes/alpha';
// ArgoCD plugin (Phase 2.4b): adds Argo CD deployment cards (sync/health overview + history) to Component
// entities. The backend reads our self-hosted ArgoCD read-only via a token (see infra/modules/backstage).
// Components match their Application(s) through the `argocd/app-selector` annotation in catalog-info.yaml.
// Roadie's plugin is the only new-frontend-system-native ArgoCD plugin (it adds entity cards, not a page).
import argocdPlugin from '@roadiehq/backstage-plugin-argo-cd/alpha';
// Scaffolder (BACK Phase 3, ADR-062): the /create page. Templates are platform-owned (the platform repo's
// scaffolder/templates/, registered in app-config.production.yaml); execution is admin-only for now via the
// #197 permission policy (non-catalog writes deny). The sidebar already reserves page:scaffolder.
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';
// Tenant Status card (#285, ADR-064 §2): a custom overview card on the tenant System entity rendering the live
// XTenant provisioning journey (Submitted → Synced → Ready) + domains, via the Kubernetes plugin's proxy.
import { tenantStatusModule } from './modules/tenant-status';
// Team Tenants card: on a team's Group page, lists the tenants it owns (env/tier/lifecycle, linking to each
// tenant System). Makes the team→tenant relationship navigable in one readable table.
import { teamTenantsModule } from './modules/team-tenants';
// ProductPicker scaffolder field: makes the New Environment form's Product input a Team-scoped dropdown
// (auto-populated from the catalog's Systems owned by the selected Team) instead of a free-text field.
import { productPickerModule } from './modules/product-picker';
// Activate Power (ADR-088): the temporary-power front door — borrow a privileged role for a bounded window,
// gated by a fresh passkey step-up. The backend (the sole Activation creator) verifies the step-up and the
// operator mints/expires the borrow.
import { activatePowerModule } from './modules/activate-power';
// Cost (ADR-091 A3): per-team spend vs budget in the portal, from the cost backend (queries the hub Mimir).
import { costModule } from './modules/cost';
// TechDocs (#938, ADR-097): the entity "Docs" tab + the /docs reader, serving the platform Learning Portal
// (docs/learn) from S3 (builder: external — the platform repo's techdocs CI publishes the pre-built site;
// the backstage module sets techdocs.publisher=awsS3). (Mermaid rendering of the portal's diagrams is a follow-up — the new-frontend addon wiring differs.)
import techdocsPlugin from '@backstage/plugin-techdocs/alpha';

export default createApp({
  features: [
    catalogPlugin,
    kubernetesPlugin,
    argocdPlugin,
    scaffolderPlugin,
    navModule,
    authModule,
    tenantStatusModule,
    teamTenantsModule,
    productPickerModule,
    activatePowerModule,
    costModule,
    techdocsPlugin,
  ],
});
