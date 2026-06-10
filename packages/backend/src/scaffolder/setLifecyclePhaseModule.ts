import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createSetLifecyclePhaseAction } from './setLifecyclePhase';

/**
 * Registers platform:set-lifecycle-phase with the scaffolder (#283, ADR-062) — the deprovisioning
 * (decommission / reactivate) edit step for the Deprovision Tenant template.
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-set-lifecycle-phase',
  register(reg) {
    reg.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createSetLifecyclePhaseAction());
      },
    });
  },
});
