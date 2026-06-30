import {
  Sidebar,
  SidebarDivider,
  SidebarGroup,
  SidebarItem,
  SidebarScrollWrapper,
  SidebarSpace,
} from '@backstage/core-components';
import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { SidebarLogo } from './SidebarLogo';
import MenuIcon from '@material-ui/icons/Menu';
import SearchIcon from '@material-ui/icons/Search';
import GroupIcon from '@material-ui/icons/Group';
import LinkIcon from '@material-ui/icons/Link';
import LockOpenIcon from '@material-ui/icons/LockOpen';
import ListIcon from '@material-ui/icons/List';
import AccountBoxIcon from '@material-ui/icons/AccountBox';
import { SidebarSearchModal } from '@backstage/plugin-search';
import { UserSettingsSignInAvatar } from '@backstage/plugin-user-settings';
import { NotificationsSidebarItem } from '@backstage/plugin-notifications';
import { SidebarSignOut } from '../auth';

export const SidebarContent = NavContentBlueprint.make({
  params: {
    component: ({ navItems }) => {
      const nav = navItems.withComponent(item => (
        <SidebarItem icon={() => item.icon} to={item.href} text={item.title} />
      ));

      // Skipped items
      nav.take('page:search'); // Using search modal instead
      // Kubernetes is an entity tab (per-Component), not a standalone page — the global page has no entity
      // context and errors. Consume its auto-derived nav item so it isn't rendered in the sidebar.
      nav.take('page:kubernetes');
      // The Activate Power OIDC callback is a popup target, not a user page — consume its nav item. The
      // Activate Power page itself is placed explicitly in the Menu group below.
      nav.take('page:activate-power-callback');
      nav.take('page:activate-power');
      nav.take('page:activations');
      nav.take('page:access');

      return (
        <Sidebar>
          <SidebarLogo />
          <SidebarGroup label="Search" icon={<SearchIcon />} to="/search">
            <SidebarSearchModal />
          </SidebarGroup>
          <SidebarDivider />
          <SidebarGroup label="Menu" icon={<MenuIcon />}>
            {nav.take('page:catalog')}
            {/* Teams: the catalog pre-filtered to team Groups — one-click "all teams" overview (each team's
                page lists its tenants + the catalog graph shows the team→tenant relationships). */}
            <SidebarItem
              icon={GroupIcon}
              to="/catalog?filters[kind]=group"
              text="Teams"
            />
            {nav.take('page:scaffolder')}
            {/* Activate Power (ADR-088): borrow a privileged role for a bounded window, gated by a fresh
                passkey step-up. Activations lists the live borrows (status, expiry, revoke). */}
            <SidebarItem
              icon={LockOpenIcon}
              to="/activate-power"
              text="Activate Power"
            />
            <SidebarItem
              icon={ListIcon}
              to="/activations"
              text="Active Power"
            />
            <SidebarItem icon={AccountBoxIcon} to="/access" text="My Access" />
            <SidebarDivider />
            <SidebarScrollWrapper>
              {nav.rest({ sortBy: 'title' })}
            </SidebarScrollWrapper>
          </SidebarGroup>
          <SidebarSpace />
          <SidebarDivider />
          <NotificationsSidebarItem />
          <SidebarDivider />
          <SidebarGroup
            label="Settings"
            icon={<UserSettingsSignInAvatar />}
            to="/settings"
          >
            {nav.take('page:app-visualizer')}
            {nav.take('page:user-settings')}
            {/* Link GitHub + Slack to your platform identity (Keycloak Account Console) so the triage agent
                can @mention you by name on incidents your change caused (ADR-084 Phase 1). External link. */}
            <SidebarItem
              icon={LinkIcon}
              to="https://keycloak.aws.refplat.org/realms/platform/account"
              text="Connect accounts"
            />
            <SidebarSignOut />
          </SidebarGroup>
        </Sidebar>
      );
    },
  },
});
