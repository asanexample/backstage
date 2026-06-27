import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import { createOffboardPersonAction } from './offboardPerson';

/**
 * Registers platform:offboard-person with the scaffolder — the leaver action backing the Offboard Person
 * template (identity strategy §2.5). It opens a deletion PR directly via the GitHub App (the additive publish
 * action can't delete files); the People Gate authorizes the deletion (access-admin approval, never auto-merged).
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-offboard-person',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        const integrations = ScmIntegrations.fromConfig(config);
        const githubCredentialsProvider =
          DefaultGithubCredentialsProvider.fromIntegrations(integrations);
        scaffolder.addActions(
          createOffboardPersonAction({
            integrations,
            githubCredentialsProvider,
          }),
        );
      },
    });
  },
});
