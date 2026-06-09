/*
 * Registers the Centric permission policy, replacing the stock allow-all module
 * (@backstage/plugin-permission-backend-module-allow-all-policy) in packages/backend/src/index.ts.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { CentricPermissionPolicy } from './permissionPolicy';

export const permissionModuleCentricPolicy = createBackendModule({
  pluginId: 'permission',
  moduleId: 'centric-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new CentricPermissionPolicy());
      },
    });
  },
});

export default permissionModuleCentricPolicy;
