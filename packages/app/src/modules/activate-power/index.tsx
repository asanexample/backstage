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

export const activatePowerModule = createFrontendModule({
  pluginId: 'app',
  extensions: [activatePowerPage, activatePowerCallbackPage],
});
