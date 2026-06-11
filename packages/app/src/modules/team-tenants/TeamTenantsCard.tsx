/*
 * Team Tenants card — on a team's catalog Group page, lists the tenants that team owns (the team→tenant
 * relationship made visible in one place), each with its environment, tier, and lifecycle phase, linking to
 * the tenant's System page (where the live #285 provisioning-status card lives). Data comes from the catalog
 * (the platform-projection emits Systems owned by `group:<team>`), so this is reliable + cluster-free.
 */
import { useEffect, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import {
  catalogApiRef,
  useEntity,
  EntityRefLink,
} from '@backstage/plugin-catalog-react';
import {
  InfoCard,
  Progress,
  Link,
  StatusOK,
  StatusPending,
  StatusAborted,
} from '@backstage/core-components';
import {
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Chip,
} from '@material-ui/core';
import type { Entity } from '@backstage/catalog-model';

const LifecycleStatus = ({ phase }: { phase?: string }) => {
  if (!phase || phase === 'active') return <StatusOK>active</StatusOK>;
  if (phase === 'decommissioning') return <StatusAborted>decommissioning</StatusAborted>;
  return <StatusPending>{phase}</StatusPending>;
};

export const TeamTenantsCard = () => {
  const { entity } = useEntity();
  const catalogApi = useApi(catalogApiRef);
  const team = entity.metadata.name;

  const [state, setState] = useState<{
    loading: boolean;
    error?: Error;
    value?: Entity[];
  }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      try {
        const { items } = await catalogApi.getEntities({
          filter: {
            kind: 'System',
            'relations.ownedBy': `group:default/${team}`,
          },
        });
        // Stable order: environment then name.
        const sorted = (items as Entity[]).slice().sort((a, b) => {
          const ea = String((a.spec as any)?.environment ?? '');
          const eb = String((b.spec as any)?.environment ?? '');
          return (
            ea.localeCompare(eb) ||
            a.metadata.name.localeCompare(b.metadata.name)
          );
        });
        if (!cancelled) setState({ loading: false, value: sorted });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e as Error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [team, catalogApi]);

  const { value, loading, error } = state;

  return (
    <InfoCard title="Tenants">
      {loading && <Progress />}
      {error && (
        <Typography color="error">
          Failed to load tenants: {error.message}
        </Typography>
      )}
      {!loading && !error && (value?.length ?? 0) === 0 && (
        <Box py={2}>
          <Typography variant="body2" color="textSecondary">
            No tenants yet. Provision one from the{' '}
            <Link to="/create">New Tenant</Link> template — it'll appear here
            once the claim merges.
          </Typography>
        </Box>
      )}
      {!loading && !error && (value?.length ?? 0) > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Tenant</TableCell>
              <TableCell>Environment</TableCell>
              <TableCell>Tier</TableCell>
              <TableCell>Lifecycle</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {value!.map(sys => {
              const spec = (sys.spec ?? {}) as any;
              return (
                <TableRow key={sys.metadata.name}>
                  <TableCell>
                    <EntityRefLink entityRef={sys} defaultKind="System" />
                  </TableCell>
                  <TableCell>
                    {spec.environment ? (
                      <Chip size="small" label={spec.environment} />
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{spec.tier ?? '—'}</TableCell>
                  <TableCell>
                    <LifecycleStatus phase={spec.lifecyclePhase} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {!loading && !error && (value?.length ?? 0) > 0 && (
        <Box pt={1}>
          <Typography variant="caption" color="textSecondary">
            Open a tenant for its live provisioning status (Synced → Ready).
          </Typography>
        </Box>
      )}
    </InfoCard>
  );
};
