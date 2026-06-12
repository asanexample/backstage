import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { PlatformProjectionProvider } from './provider';
import { EnvironmentRelationProcessor } from './environmentRelationProcessor';

/**
 * Catalog backend module: registers the platform projection entity provider, which reads the platform repo's
 * XTenant claims from git (via the GitHub App) and projects them into the catalog as Groups / Systems /
 * Resources (ADR-049). Config under `platformProjection` (see config.d.ts).
 */
export const catalogModulePlatformProjection = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'platform-projection',
  register(reg) {
    reg.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        scheduler: coreServices.scheduler,
        logger: coreServices.logger,
        urlReader: coreServices.urlReader,
        config: coreServices.rootConfig,
      },
      async init({ catalog, scheduler, logger, urlReader, config }) {
        const sub = config.getOptionalConfig('platformProjection');
        const provider = new PlatformProjectionProvider({
          urlReader,
          logger,
          repoUrl:
            sub?.getOptionalString('repoUrl') ??
            'https://github.com/asanexample/platform',
          claimsPath:
            sub?.getOptionalString('claimsPath') ?? 'gitops/tenant-claims',
          teamsPath: sub?.getOptionalString('teamsPath') ?? 'gitops/teams',
          productsPath:
            sub?.getOptionalString('productsPath') ?? 'gitops/products',
          environmentsPath:
            sub?.getOptionalString('environmentsPath') ?? 'gitops/environments',
          branch: sub?.getOptionalString('branch') ?? 'main',
          ecrRegistry: sub?.getOptionalString('ecrRegistry'),
          // ADR-067: 'v2' (default) projects XTenant claims; 'v3' projects Products + Environments. The
          // cutover flips this to 'v3'. Additive — the default keeps the live catalog unchanged.
          mode: sub?.getOptionalString('mode') === 'v3' ? 'v3' : 'v2',
        });

        catalog.addEntityProvider(provider);

        // Wire ownership/containment relations for the v3 custom kind:Environment (BuiltinKindsEntityProcessor
        // doesn't, for unknown kinds). Harmless in v2 mode (no Environment entities exist).
        catalog.addProcessor(new EnvironmentRelationProcessor());

        // Refresh cadence: the tenant entity (and its provisioning-status cards) should appear within minutes
        // of a claim merging, not the old 30 — #284 visibility. Reading the git tree every few minutes is well
        // within the GitHub App rate limit. Configurable via platformProjection.refreshMinutes (default 5).
        const refreshMinutes = sub?.getOptionalNumber('refreshMinutes') ?? 5;
        // initialDelay gives the catalog time to call provider.connect() before the first run.
        await scheduler.scheduleTask({
          id: 'platform-projection:refresh',
          frequency: { minutes: refreshMinutes },
          timeout: { minutes: 5 },
          initialDelay: { seconds: 15 },
          fn: async () => {
            await provider.run();
          },
        });
      },
    });
  },
});
