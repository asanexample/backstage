import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
// Kubernetes plugin (Phase 2.4a): adds the live "Kubernetes" tab to Component entities. The backend reads
// the platform + preprod clusters read-only via EKS Pod Identity (see infra/modules/backstage). Components
// match k8s objects through the `backstage.io/kubernetes-label-selector` annotation in their catalog-info.yaml.
import kubernetesPlugin from '@backstage/plugin-kubernetes/alpha';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';

export default createApp({
  features: [catalogPlugin, kubernetesPlugin, navModule, authModule],
});
