import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { Router } from 'express';
import {
  queryByTeam,
  mergeTeamCost,
  SPEND_BY_TEAM,
  BUDGET_BY_TEAM,
} from './mimir';

/**
 * Cost backend (ADR-091 A3) — surfaces per-team spend vs budget in the portal. Queries the hub Mimir
 * (federated tenant) for the same metrics the Grafana Cost dashboard uses. Read-only; any signed-in user.
 */
export const costPlugin = createBackendPlugin({
  pluginId: 'cost',
  register(env) {
    env.registerInit({
      deps: {
        http: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ http, httpAuth, config, logger }) {
        // In-cluster Mimir gateway query API + the federated tenant header (spans platform|preprod).
        const baseUrl = config.getString('cost.mimirUrl');
        const tenant = config.getString('cost.mimirTenant');

        const router = Router();

        // Per-team monthly spend vs budget (+ utilization). The Cost page renders it.
        router.get('/teams', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const deps = { fetch: globalThis.fetch, baseUrl, tenant };
          try {
            const [spend, budget] = await Promise.all([
              queryByTeam(deps, SPEND_BY_TEAM),
              queryByTeam(deps, BUDGET_BY_TEAM),
            ]);
            res.json({ teams: mergeTeamCost(spend, budget) });
          } catch (e) {
            logger.error(`cost: Mimir query failed: ${e}`);
            res.status(502).json({
              error: 'cost data unavailable (the Mimir query failed)',
            });
          }
        });

        http.use(router);
      },
    });
  },
});

export default costPlugin;
