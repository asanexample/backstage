/*
 * Team Tenants card — on a team's catalog Group page, lists the team's deployables (the v2 tenant `System` or
 * the v3 custom `kind: Environment`), each with its stage/environment, tier, and lifecycle phase, linking to
 * its entity page (where the live #285 provisioning-status card lives). Data comes from the catalog
 * (`relations.ownedBy: group:<team>` + the kubernetes-namespace annotation), so this is reliable + cluster-free.
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
          // The team's deployables: the v2 tenant `System` OR the v3 custom `kind: Environment` (both ownedBy
          // the team — Environments via the relation processor). The v3 Product `System` is also ownedBy the
          // team but is NOT a deployable, so filter to entities carrying the kubernetes-namespace annotation.
          filter: {
            kind: ['System', 'Environment'],
            'relations.ownedBy': `group:default/${team}`,
          },
        });
        const deployables = (items as Entity[]).filter(
          e =>
            !!e.metadata.annotations?.['backstage.io/kubernetes-namespace'],
        );
        // Stable order: stage/environment then name.
        const stageOf = (e: Entity) =>
          String((e.spec as any)?.stage ?? (e.spec as any)?.environment ?? '');
        const sorted = deployables.slice().sort((a, b) => {
          return (
            stageOf(a).localeCompare(stageOf(b)) ||
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
            {value!.map(item => {
              const spec = (item.spec ?? {}) as any;
              const stage = spec.stage ?? spec.environment; // v3 stage | v2 environment
              return (
                <TableRow key={item.metadata.name}>
                  <TableCell>
                    <EntityRefLink entityRef={item} defaultKind={item.kind} />
                  </TableCell>
                  <TableCell>
                    {stage ? <Chip size="small" label={stage} /> : '—'}
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
