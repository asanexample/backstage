import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createVerifyTeamMembershipAction } from './verifyTeamMembership';

/**
 * Registers platform:verify-team-membership with the scaffolder (#281, ADR-062 §1) — the server-side
 * team-scoping step the self-service templates start with.
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-verify-team-membership',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        userInfo: coreServices.userInfo,
      },
      async init({ scaffolder, userInfo }) {
        scaffolder.addActions(createVerifyTeamMembershipAction({ userInfo }));
      },
    });
  },
});
