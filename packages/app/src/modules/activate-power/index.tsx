import {
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';

/**
 * Activate Power frontend (ADR-088) — the temporary-power front door. The page lists the roles you can
 * borrow, forces a fresh passkey step-up, and asks the backend (the sole Activation creator) to mint the
 * borrow. The callback page completes the OIDC popup.
 */

const activatePowerPage = PageBlueprint.make({
  name: 'activate-power',
  params: {
    path: '/activate-power',
    loader: () =>
      import('./ActivatePowerPage').then(m => <m.ActivatePowerPage />),
  },
});

const activatePowerCallbackPage = PageBlueprint.make({
  name: 'activate-power-callback',
  params: {
    path: '/activate-power/callback',
    loader: () =>
      import('./CallbackPage').then(m => <m.ActivatePowerCallbackPage />),
  },
});

// The live borrows view — status, expiry, revoke (and an all-borrows view for access-admin).
const activationsPage = PageBlueprint.make({
  name: 'activations',
  params: {
    path: '/activations',
    loader: () => import('./ActivationsPage').then(m => <m.ActivationsPage />),
  },
});

// The per-person Access view — standing grants + live borrows + audit history, joined at read time.
const accessPage = PageBlueprint.make({
  name: 'access',
  params: {
    path: '/access',
    loader: () => import('./AccessPage').then(m => <m.AccessPage />),
  },
});

export const activatePowerModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    activatePowerPage,
    activatePowerCallbackPage,
    activationsPage,
    accessPage,
  ],
});
