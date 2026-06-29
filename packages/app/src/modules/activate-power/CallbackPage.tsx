import { useEffect } from 'react';
import { useApi, configApiRef } from '@backstage/core-plugin-api';
import { Progress } from '@backstage/core-components';
import { completeStepUp } from './stepUp';

/**
 * The step-up popup lands here (the registered redirect_uri). It completes the OIDC code exchange and signals
 * the opener — which resolves the `stepUp()` promise on the Activate Power page — then the popup closes itself.
 */
export const ActivatePowerCallbackPage = () => {
  const config = useApi(configApiRef);
  useEffect(() => {
    completeStepUp({
      authority: config.getString('activatePower.authority'),
      clientId: config.getString('activatePower.clientId'),
      acrValues: config.getOptionalString('activatePower.acrValues'),
    }).catch(() => {
      // The opener's signinPopup promise rejects with the real error; nothing to show in the popup.
    });
  }, [config]);
  return <Progress />;
};
