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
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';

export default createApp({
  features: [catalogPlugin, kubernetesPlugin, argocdPlugin, navModule, authModule],
});
