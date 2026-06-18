/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);
// platform:verify-team-membership — server-side team scoping for the self-service templates (#281)
backend.add(import('./scaffolder/verifyTeamMembershipModule'));
// platform:set-lifecycle-phase — deprovisioning edit step for the Deprovision Tenant template (#283)
backend.add(import('./scaffolder/setLifecyclePhaseModule'));
// platform:resolve-release-digest — digest-resolution step for the Request Promotion template (#377 Phase 3b)
backend.add(import('./scaffolder/resolveReleaseDigestModule'));
// platform:deprovision-product — Product-scoped teardown (decommission/reactivate all envs, or purge the
// Product + its envs + releases) for the Deprovision Product template (ADR-062)
backend.add(import('./scaffolder/deprovisionProductModule'));
// platform:add-service-resource — declare a self-service cloud resource on a Service's Environment claim,
// for the New Resource template (#553, ADR-073)
backend.add(import('./scaffolder/addServiceResourceModule'));

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// See https://backstage.io/docs/backend-system/building-backends/migrating#the-auth-plugin
// guest provider — local development only (configured in app-config.local.yaml, never in production).
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
// See https://backstage.io/docs/auth/guest/provider
// oidc provider — production SSO. Backstage authenticates directly against Keycloak (the platform IdP of
// record) over OIDC. Keycloak issues refresh tokens, so the silent /refresh on reload succeeds and the
// session survives without a fronting proxy — the move off SAML/Dex removed the need for oauth2-proxy
// (#202). Config: app-config.production.yaml (auth.providers.oidc).
// Our local module replaces the stock oidc-provider module: it registers providerId `oidc` with a custom
// resolver that attaches Keycloak group membership to the identity (ownershipEntityRefs) for RBAC (#197).
backend.add(import('./authOidcModule'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));
// GitHub org discovery — registers catalog-info.yaml Components from the asanexample app repos.
// Config + schedule in app-config.production.yaml (catalog.providers.github). Auth is the read-only
// GitHub App (integrations.github.apps). See docs/runbooks/backstage-github-app.md.
backend.add(import('@backstage/plugin-catalog-backend-module-github'));
// Platform projection (Phase 2.3a) — reads the platform repo's XTenant claims from git (via the GitHub App)
// and projects them as Groups/Systems/Resources (ADR-049). Config under `platformProjection`.
backend.add(
  import('@internal/plugin-catalog-backend-module-platform-projection'),
);

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// Centric group-based RBAC policy (#197): platform-admins -> full access; everyone reads the catalog;
// team members write/delete only entities their team owns; other writes admin-only. Group membership comes
// from the Keycloak `groups` claim via the custom sign-in resolver (./authOidcModule). Replaces allow-all.
backend.add(import('./permissions/permissionPolicyModule'));

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// argocd plugin (Phase 2.4b) — proxies our self-hosted ArgoCD read-only (token auth) so Component entities
// show live sync/health + deployment history. Config (instances/token) in app-config, injected by the platform
// backstage module (auth.providers stay untouched). See docs/runbooks/backstage-argocd.md.
backend.add(import('@roadiehq/backstage-plugin-argo-cd-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));
// tenant-ready notifier (#285, ADR-064 §2) — polls the workload cluster's XTenant claims and pings the
// requester when their tenant newly reaches Ready (pairs with the Tenant Status card). First-poll baselines
// already-Ready tenants so a deploy doesn't flood the bell.
backend.add(import('./notifications/tenantReadyModule'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
