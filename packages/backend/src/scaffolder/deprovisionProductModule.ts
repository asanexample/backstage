import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import { createDeprovisionProductAction } from './deprovisionProduct';

/**
 * Registers platform:deprovision-product with the scaffolder (Deprovision Product, ADR-062) — the
 * Product-scoped teardown action (decommission/reactivate all envs, or purge the Product + envs + releases).
 * It opens PRs directly via the GitHub App credentials (the additive publish action can't delete files).
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-deprovision-product',
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
          createDeprovisionProductAction({
            integrations,
            githubCredentialsProvider,
          }),
        );
      },
    });
  },
});
