import {
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';

/**
 * Cost frontend (ADR-091 A3) — per-team spend vs budget in the portal, from the cost backend (which queries
 * the hub Mimir). The Grafana Cost dashboard has the detail.
 */
const costPage = PageBlueprint.make({
  name: 'cost',
  params: {
    path: '/cost',
    loader: () => import('./CostPage').then(m => <m.CostPage />),
  },
});

export const costModule = createFrontendModule({
  pluginId: 'app',
  extensions: [costPage],
});
