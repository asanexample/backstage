import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Header,
  Content,
  InfoCard,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import {
  useApi,
  configApiRef,
  fetchApiRef,
  discoveryApiRef,
} from '@backstage/core-plugin-api';
import {
  Box,
  Button,
  Chip,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import LockOpenIcon from '@material-ui/icons/LockOpen';
import { stepUp } from './stepUp';

type Reach = { scope?: string; team?: string };
type Borrowable = { role: string; reach: Reach };

const reachLabel = (r: Reach) =>
  r.scope ? `scope: ${r.scope}` : `team: ${r.team}`;

export const ActivatePowerPage = () => {
  const config = useApi(configApiRef);
  const fetchApi = useApi(fetchApiRef);
  const discovery = useApi(discoveryApiRef);

  const [roles, setRoles] = useState<Borrowable[]>();
  const [loadError, setLoadError] = useState<Error>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const baseUrl = useCallback(
    () => discovery.getBaseUrl('activate-power'),
    [discovery],
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchApi.fetch(`${await baseUrl()}/eligible`);
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        const body = (await res.json()) as { roles?: Borrowable[] };
        setRoles(body.roles ?? []);
      } catch (e) {
        setLoadError(e as Error);
      }
    })();
  }, [fetchApi, baseUrl]);

  const activate = async (b: Borrowable) => {
    setActionError(undefined);
    setResult(undefined);
    if (!reason.trim()) {
      setActionError('Please enter a reason for the borrow.');
      return;
    }
    setBusy(`${b.role}|${reachLabel(b.reach)}`);
    try {
      // The passkey step-up — a fresh tap, right now.
      const stepUpToken = await stepUp({
        authority: config.getString('activatePower.authority'),
        clientId: config.getString('activatePower.clientId'),
        acrValues: config.getOptionalString('activatePower.acrValues'),
      });
      const res = await fetchApi.fetch(`${await baseUrl()}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: b.role,
          reach: b.reach,
          reason,
          stepUpToken,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        name?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `request failed (${res.status})`);
      }
      setResult(
        `Borrowed ${b.role} — activation "${body.name}" is provisioning. It will be revoked automatically when its window expires.`,
      );
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Page themeId="tool">
      <Header
        title="Activate Power"
        subtitle="Borrow a privileged role for a bounded window — with a fresh passkey (ADR-088)"
      />
      <Content>
        <InfoCard title="Reason">
          <Typography variant="body2" color="textSecondary" gutterBottom>
            Every borrow is recorded. Say why you need it (e.g. the incident
            you're responding to).
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={2}
            variant="outlined"
            placeholder="Responding to INC-1234 — prod payments degraded"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />
        </InfoCard>

        <Box mt={2} />

        {loadError && <ResponseErrorPanel error={loadError} />}
        {!roles && !loadError && <Progress />}

        {result && (
          <Box mb={2}>
            <InfoCard title="Activated">
              <Typography variant="body1">{result}</Typography>
            </InfoCard>
          </Box>
        )}
        {actionError && (
          <Box mb={2}>
            <ResponseErrorPanel
              title="Activation failed"
              error={new Error(actionError)}
            />
          </Box>
        )}

        {roles && roles.length === 0 && (
          <InfoCard title="Nothing to borrow">
            <Typography>
              You have no on-demand grants. Borrowable roles come from your
              entry in the workforce registry.
            </Typography>
          </InfoCard>
        )}

        <Grid container spacing={2}>
          {roles?.map(b => {
            const key = `${b.role}|${reachLabel(b.reach)}`;
            return (
              <Grid item xs={12} md={6} key={key}>
                <InfoCard title={b.role}>
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <Chip size="small" label={reachLabel(b.reach)} />
                    <Button
                      variant="contained"
                      color="primary"
                      startIcon={<LockOpenIcon />}
                      disabled={!!busy}
                      onClick={() => activate(b)}
                    >
                      {busy === key ? 'Tap your passkey…' : 'Activate'}
                    </Button>
                  </Box>
                </InfoCard>
              </Grid>
            );
          })}
        </Grid>
      </Content>
    </Page>
  );
};
