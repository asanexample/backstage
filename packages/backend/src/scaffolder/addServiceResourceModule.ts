import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createAddServiceResourceAction } from './addServiceResource';

/**
 * Registers platform:add-service-resource with the scaffolder (#553, ADR-073) — the edit step for the
 * New Resource template (declare a self-service cloud resource on a Service's Environment claim).
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-add-service-resource',
  register(reg) {
    reg.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createAddServiceResourceAction());
      },
    });
  },
});
