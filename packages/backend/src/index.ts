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

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// See https://backstage.io/docs/backend-system/building-backends/migrating#the-auth-plugin
// guest provider — local development only (configured in app-config.local.yaml, never in production).
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
// See https://backstage.io/docs/auth/guest/provider
// oauth2-proxy provider — production SSO. The portal is fronted by oauth2-proxy (which does the OIDC
// dance with the Dex broker and owns a durable session cookie); this provider establishes the Backstage
// identity from the proxy-injected X-Forwarded-* headers. It trusts those headers, so backstage:7007 is
// network-locked to the proxy pod (platform backstage module NetworkPolicy). Fixes logout-on-refresh
// (#202 — SAML/Dex issues no refresh token). Config: app-config.production.yaml (auth.providers.oauth2Proxy).
backend.add(import('@backstage/plugin-auth-backend-module-oauth2-proxy-provider'));

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
// See https://backstage.io/docs/permissions/getting-started for how to create your own permission policy
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

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

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
