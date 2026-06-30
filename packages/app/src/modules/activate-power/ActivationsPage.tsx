import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Header,
  Content,
  Table,
  type TableColumn,
  Progress,
  ResponseErrorPanel,
  StatusOK,
  StatusPending,
  StatusError,
  StatusAborted,
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
  FormControlLabel,
  Switch,
  Tooltip,
} from '@material-ui/core';
import { stepUp } from './stepUp';

type Reach = { scope?: string; team?: string };
type Activation = {
  name: string;
  principal: string;
  role: string;
  reach: Reach;
  reason?: string;
  phase?: string;
  expiresAt?: string;
};
type ActivationsResponse = {
  user: string;
  isAdmin: boolean;
  scope: 'mine' | 'all';
  activations: Activation[];
};

const reachLabel = (r: Reach) =>
  r.scope ? `scope: ${r.scope}` : `team: ${r.team}`;

const phaseStatus = (phase?: string) => {
  switch (phase) {
    case 'Active':
      return <StatusOK>Active</StatusOK>;
    case 'Provisioning':
    case 'Pending':
      return <StatusPending>{phase}</StatusPending>;
    case 'Expiring':
    case 'Expired':
    case 'Revoked':
      return <StatusAborted>{phase}</StatusAborted>;
    case 'Failed':
      return <StatusError>Failed</StatusError>;
    default:
      return <StatusPending>{phase ?? 'unknown'}</StatusPending>;
  }
};

const timeLeft = (expiresAt?: string, now = Date.now()): string => {
  if (!expiresAt) return '—';
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'expiring…';
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const ActivationsPage = () => {
  const config = useApi(configApiRef);
  const fetchApi = useApi(fetchApiRef);
  const discovery = useApi(discoveryApiRef);

  const [data, setData] = useState<ActivationsResponse>();
  const [error, setError] = useState<Error>();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string>();
  // Re-render once a minute so the countdowns tick even between fetches.
  const [, setTick] = useState(0);

  const baseUrl = useCallback(
    () => discovery.getBaseUrl('activate-power'),
    [discovery],
  );

  const load = useCallback(async () => {
    try {
      const url = `${await baseUrl()}/activations${showAll ? '?all=true' : ''}`;
      const res = await fetchApi.fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setData((await res.json()) as ActivationsResponse);
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    }
  }, [fetchApi, baseUrl, showAll]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 20000);
    const tick = setInterval(() => setTick(t => t + 1), 60000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const revoke = async (a: Activation) => {
    // eslint-disable-next-line no-alert -- a deliberate confirmation for a destructive, irreversible revoke
    const confirmed = window.confirm(
      `Revoke "${a.name}"? This immediately pulls back every grant for ${a.principal}.`,
    );
    if (!confirmed) return;
    setBusy(a.name);
    try {
      const res = await fetchApi.fetch(
        `${await baseUrl()}/activations/${encodeURIComponent(a.name)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `revoke failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(undefined);
    }
  };

  // Extend re-proves identity with a fresh passkey, then asks the operator to push the expiry out
  // (capped at the role's ceiling). Your own Active borrows only.
  const extend = async (a: Activation) => {
    setBusy(a.name);
    try {
      const stepUpToken = await stepUp({
        authority: config.getString('activatePower.authority'),
        clientId: config.getString('activatePower.clientId'),
        acrValues: config.getOptionalString('activatePower.acrValues'),
      });
      const res = await fetchApi.fetch(
        `${await baseUrl()}/activations/${encodeURIComponent(a.name)}/extend`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stepUpToken }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `extend failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(undefined);
    }
  };

  const columns: TableColumn<Activation>[] = [
    { title: 'Role', field: 'role' },
    {
      title: 'Reach',
      render: a => <Chip size="small" label={reachLabel(a.reach)} />,
    },
    { title: 'User', field: 'principal' },
    { title: 'Status', render: a => phaseStatus(a.phase) },
    {
      title: 'Expires in',
      render: a => (
        <Tooltip title={a.expiresAt ?? ''}>
          <span>{timeLeft(a.expiresAt)}</span>
        </Tooltip>
      ),
    },
    { title: 'Reason', field: 'reason' },
    {
      title: '',
      render: a => (
        <Box display="flex" gridGap={8} justifyContent="flex-end">
          {a.principal === data?.user && a.phase === 'Active' && (
            <Button
              size="small"
              variant="outlined"
              disabled={!!busy}
              onClick={() => extend(a)}
            >
              {busy === a.name ? 'Tap passkey…' : 'Extend'}
            </Button>
          )}
          <Button
            size="small"
            variant="outlined"
            color="secondary"
            disabled={!!busy}
            onClick={() => revoke(a)}
          >
            {busy === a.name ? 'Revoking…' : 'Revoke'}
          </Button>
        </Box>
      ),
    },
  ];

  return (
    <Page themeId="tool">
      <Header
        title="Active Power"
        subtitle="Live privileged borrows — status, expiry, and revoke (ADR-088)"
      >
        {data?.isAdmin && (
          <FormControlLabel
            control={
              <Switch
                checked={showAll}
                onChange={e => setShowAll(e.target.checked)}
                color="default"
              />
            }
            label="All borrows"
          />
        )}
      </Header>
      <Content>
        {error && <ResponseErrorPanel error={error} />}
        {!data && !error && <Progress />}
        {data && (
          <Table<Activation>
            title={
              data.scope === 'all'
                ? 'All active borrows'
                : `Your active borrows (${data.user})`
            }
            options={{ search: false, paging: false, padding: 'dense' }}
            columns={columns}
            data={data.activations}
            emptyContent={
              <div style={{ padding: 24 }}>
                No active borrows. Borrow a role from{' '}
                <a href="/activate-power">Activate Power</a>.
              </div>
            }
          />
        )}
      </Content>
    </Page>
  );
};
