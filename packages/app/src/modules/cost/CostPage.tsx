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
  fetchApiRef,
  discoveryApiRef,
} from '@backstage/core-plugin-api';
import { Box, Grid, LinearProgress, Typography } from '@material-ui/core';

type TeamCost = {
  team: string;
  monthlySpendUSD: number;
  budgetUSD: number | null;
  utilizationPct: number | null;
};

const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const utilColor = (p: number): string => {
  if (p >= 100) return '#d32f2f';
  if (p >= 80) return '#ed6c02';
  return '#2e7d32';
};

export const CostPage = () => {
  const fetchApi = useApi(fetchApiRef);
  const discovery = useApi(discoveryApiRef);

  const [teams, setTeams] = useState<TeamCost[]>();
  const [error, setError] = useState<Error>();

  const load = useCallback(async () => {
    try {
      const base = await discovery.getBaseUrl('cost');
      const res = await fetchApi.fetch(`${base}/teams`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setTeams(((await res.json()) as { teams: TeamCost[] }).teams);
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    }
  }, [fetchApi, discovery]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Page themeId="tool">
      <Header
        title="Cost"
        subtitle="Per-team monthly spend vs budget (ADR-091). Detail in the Grafana Cost dashboard."
      />
      <Content>
        {error && <ResponseErrorPanel error={error} />}
        {!teams && !error && <Progress />}
        {teams && (
          <Grid container spacing={2}>
            {teams.length === 0 && (
              <Grid item xs={12}>
                <Typography color="textSecondary">
                  No cost data yet (OpenCost may still be warming up).
                </Typography>
              </Grid>
            )}
            {teams.map(t => (
              <Grid item xs={12} md={6} lg={4} key={t.team}>
                <InfoCard
                  title={t.team}
                  subheader={
                    t.budgetUSD !== null
                      ? `Budget ${usd(t.budgetUSD)}/mo`
                      : 'No budget set'
                  }
                >
                  <Typography variant="h5">
                    {usd(t.monthlySpendUSD)}
                    <Typography
                      component="span"
                      variant="body2"
                      color="textSecondary"
                    >
                      {' '}
                      est. /mo
                    </Typography>
                  </Typography>
                  {t.utilizationPct !== null && (
                    <Box mt={2}>
                      <Box
                        display="flex"
                        justifyContent="space-between"
                        mb={0.5}
                      >
                        <Typography variant="body2">Budget used</Typography>
                        <Typography
                          variant="body2"
                          style={{
                            color: utilColor(t.utilizationPct),
                            fontWeight: 600,
                          }}
                        >
                          {t.utilizationPct.toFixed(0)}%
                        </Typography>
                      </Box>
                      <LinearProgress
                        variant="determinate"
                        value={Math.min(100, t.utilizationPct)}
                      />
                    </Box>
                  )}
                </InfoCard>
              </Grid>
            ))}
          </Grid>
        )}
      </Content>
    </Page>
  );
};
