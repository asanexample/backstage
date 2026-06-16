import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createResolveReleaseDigestAction } from './resolveReleaseDigest';

/**
 * Registers platform:resolve-release-digest with the scaffolder (#377 Phase 3b) — the digest-resolution step
 * the Request Promotion template uses to move the same signed artifact up the stage ladder.
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-resolve-release-digest',
  register(reg) {
    reg.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createResolveReleaseDigestAction());
      },
    });
  },
});
