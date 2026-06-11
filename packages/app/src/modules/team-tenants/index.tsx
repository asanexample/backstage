import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';

/**
 * Team Tenants card — a custom overview card on a team's Group entity that lists the tenants the team owns
 * (env / tier / lifecycle, linking to each tenant System). Attaches only to team Groups (spec.type: team,
 * projected per Team CR by the platform-projection plugin). Complements the built-in Ownership card + catalog
 * graph by putting the team→tenant relationship in a readable table.
 */
const teamTenantsCard = EntityCardBlueprint.make({
  name: 'teamTenants',
  params: {
    filter: { kind: 'group', 'spec.type': 'team' },
    loader: () =>
      import('./TeamTenantsCard').then(m => <m.TeamTenantsCard />),
  },
});

export const teamTenantsModule = createFrontendModule({
  pluginId: 'app',
  extensions: [teamTenantsCard],
});
