import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Header,
  Content,
  InfoCard,
  Table,
  type TableColumn,
  Progress,
  ResponseErrorPanel,
  StatusOK,
  StatusAborted,
} from '@backstage/core-components';
import {
  useApi,
  fetchApiRef,
  discoveryApiRef,
} from '@backstage/core-plugin-api';
import { Box, Chip, Grid, TextField, Typography } from '@material-ui/core';

type Reach = { scope?: string; team?: string };
type Grant = {
  role: string;
  team?: string;
  scope?: string;
  activation?: string;
};
type Borrow = {
  name: string;
  role: string;
  reach: Reach;
  phase?: string;
  expiresAt?: string;
};
type AuditEvent = {
  event: string;
  role: string;
  reach: Reach;
  reason?: string;
  stepUpAcr?: string;
  recordedAt: string;
};
type AccessResponse = {
  user: string;
  isSelf: boolean;
  isAdmin: boolean;
  standingGrants: Grant[];
  borrowableGrants: Grant[];
  liveBorrows: Borrow[];
  history: AuditEvent[];
};

const reachLabel = (r: Reach | Grant) => {
  if (r.scope) return `scope: ${r.scope}`;
  if (r.team) return `team: ${r.team}`;
  return '—';
};

const GrantChips = ({ grants, empty }: { grants: Grant[]; empty: string }) =>
  grants.length === 0 ? (
    <Typography variant="body2" color="textSecondary">
      {empty}
    </Typography>
  ) : (
    <Box display="flex" flexWrap="wrap" gridGap={8}>
      {grants.map(g => (
        <Chip
          key={`${g.role}-${reachLabel(g)}`}
          label={`${g.role} · ${reachLabel(g)}`}
        />
      ))}
    </Box>
  );

export const AccessPage = () => {
  const fetchApi = useApi(fetchApiRef);
  const discovery = useApi(discoveryApiRef);

  const [data, setData] = useState<AccessResponse>();
  const [error, setError] = useState<Error>();
  const [who, setWho] = useState(''); // admin: view another person

  const load = useCallback(async () => {
    try {
      const base = await discovery.getBaseUrl('activate-power');
      const url = who
        ? `${base}/access?user=${encodeURIComponent(who)}`
        : `${base}/access`;
      const res = await fetchApi.fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setData((await res.json()) as AccessResponse);
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    }
  }, [fetchApi, discovery, who]);

  useEffect(() => {
    load();
  }, [load]);

  const historyColumns: TableColumn<AuditEvent>[] = [
    {
      title: 'When',
      render: e => new Date(e.recordedAt).toLocaleString(),
      defaultSort: 'desc',
    },
    {
      title: 'Event',
      render: e =>
        e.event === 'revoked' ? (
          <StatusAborted>{e.event}</StatusAborted>
        ) : (
          <StatusOK>{e.event}</StatusOK>
        ),
    },
    { title: 'Role', field: 'role' },
    { title: 'Reach', render: e => reachLabel(e.reach) },
    { title: 'Reason', field: 'reason' },
    { title: 'Step-up', render: e => e.stepUpAcr ?? '—' },
  ];

  return (
    <Page themeId="tool">
      <Header
        title="My Access"
        subtitle="Your standing grants, live borrows, and borrow history (ADR-088)"
      />
      <Content>
        {error && <ResponseErrorPanel error={error} />}
        {!data && !error && <Progress />}
        {data && (
          <>
            {data.isAdmin && (
              <Box mb={2}>
                <TextField
                  label="View another person (access-admin)"
                  placeholder="leave blank for yourself"
                  variant="outlined"
                  size="small"
                  value={who}
                  onChange={e => setWho(e.target.value.trim())}
                  helperText={`Showing: ${data.user}${
                    data.isSelf ? ' (you)' : ''
                  }`}
                />
              </Box>
            )}
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <InfoCard title="Standing grants" subheader="held continuously">
                  <GrantChips
                    grants={data.standingGrants}
                    empty="No standing grants."
                  />
                </InfoCard>
              </Grid>
              <Grid item xs={12} md={6}>
                <InfoCard
                  title="Borrowable"
                  subheader="on-demand, via Activate Power"
                >
                  <GrantChips
                    grants={data.borrowableGrants}
                    empty="Nothing to borrow."
                  />
                </InfoCard>
              </Grid>
              <Grid item xs={12}>
                <InfoCard title="Live borrows" subheader="active now">
                  {data.liveBorrows.length === 0 ? (
                    <Typography variant="body2" color="textSecondary">
                      No active borrows.
                    </Typography>
                  ) : (
                    <Box display="flex" flexWrap="wrap" gridGap={8}>
                      {data.liveBorrows.map(b => (
                        <Chip
                          key={b.name}
                          color="primary"
                          label={`${b.role} · ${reachLabel(b.reach)} · ${
                            b.phase ?? '?'
                          }`}
                        />
                      ))}
                    </Box>
                  )}
                </InfoCard>
              </Grid>
            </Grid>
            <Box mt={2}>
              <Table<AuditEvent>
                title="Borrow history"
                options={{
                  search: false,
                  paging: true,
                  pageSize: 10,
                  padding: 'dense',
                }}
                columns={historyColumns}
                data={data.history}
                emptyContent={
                  <div style={{ padding: 24 }}>
                    No history yet (or the durable audit isn't wired).
                  </div>
                }
              />
            </Box>
          </>
        )}
      </Content>
    </Page>
  );
};
