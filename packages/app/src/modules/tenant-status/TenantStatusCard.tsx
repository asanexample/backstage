/*
 * Tenant Status card (#285, ADR-064 §2) — the "watch it go Ready" view on a tenant's catalog System page.
 * Fetches the live XTenant claim by name from the workload cluster via the Kubernetes plugin's proxy (reusing
 * its working preprod auth — no labels, no custom backend), parses it (./tenantStatus), and renders a vertical
 * deploy-log timeline (Submitted → Synced → Ready) + the per-domain ingress state. Polls while provisioning.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, configApiRef } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { kubernetesApiRef } from '@backstage/plugin-kubernetes-react';
import {
  InfoCard,
  Progress,
  Link,
  StatusOK,
  StatusError,
  StatusPending,
  StatusRunning,
  StatusAborted,
} from '@backstage/core-components';
import { Box, Typography, makeStyles } from '@material-ui/core';
import {
  parseTenantStatus,
  TenantStatus,
  TimelineStep,
  StepState,
} from './tenantStatus';

const DEFAULT_CLUSTER = 'preprod-use1-eks';
const POLL_MS = 4000;

const useStyles = makeStyles(theme => ({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  },
  headerText: { fontWeight: 600 },
  sub: { color: theme.palette.text.secondary },
  step: {
    display: 'flex',
    gap: theme.spacing(1.5),
    paddingBottom: theme.spacing(2),
    position: 'relative',
  },
  // the connecting rail between step icons
  rail: {
    position: 'absolute',
    left: 7,
    top: 20,
    bottom: -4,
    width: 2,
    background: theme.palette.divider,
  },
  icon: { marginTop: 2, zIndex: 1 },
  stepBody: { display: 'flex', flexDirection: 'column' },
  stepLabel: { fontWeight: 500 },
  delta: {
    color: theme.palette.text.secondary,
    marginLeft: theme.spacing(1),
    fontVariantNumeric: 'tabular-nums',
  },
  section: {
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(0.5),
    letterSpacing: 0.5,
  },
  domain: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    paddingBottom: theme.spacing(0.5),
  },
  links: {
    display: 'flex',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2),
    paddingTop: theme.spacing(1.5),
    borderTop: `1px solid ${theme.palette.divider}`,
  },
}));

const stepIcon = (state: StepState) => {
  switch (state) {
    case 'done':
      return <StatusOK />;
    case 'active':
      return <StatusRunning />;
    case 'error':
      return <StatusError />;
    default:
      return <StatusPending />;
  }
};

const fmtTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
};

// Seconds → a compact human duration ("52s", "1m 32s", "7h 31m") — raw seconds read terribly for anything
// past a minute.
const humanizeDuration = (s: number): string => {
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return sec ? `${m}m ${sec}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
};

const HeaderStatus = ({ status }: { status: TenantStatus }) => {
  const classes = useStyles();
  const { phase, readySeconds } = status;
  const map: Record<string, { icon: JSX.Element; text: string }> = {
    ready: {
      icon: <StatusOK />,
      text: `Ready${
        typeof readySeconds === 'number'
          ? ` · provisioned in ${humanizeDuration(readySeconds)}`
          : ''
      }`,
    },
    provisioning: { icon: <StatusRunning />, text: 'Provisioning…' },
    decommissioning: { icon: <StatusAborted />, text: 'Decommissioning' },
    error: { icon: <StatusError />, text: 'Provisioning error' },
    unknown: { icon: <StatusPending />, text: 'Starting…' },
  };
  const { icon, text } = map[phase] ?? map.unknown;
  return (
    <Box className={classes.header}>
      {icon}
      <Typography variant="subtitle1" className={classes.headerText}>
        {text}
      </Typography>
    </Box>
  );
};

const Step = ({ step, last }: { step: TimelineStep; last: boolean }) => {
  const classes = useStyles();
  return (
    <Box className={classes.step}>
      {!last && <span className={classes.rail} />}
      <span className={classes.icon}>{stepIcon(step.state)}</span>
      <Box className={classes.stepBody}>
        <Typography
          variant="body2"
          className={classes.stepLabel}
          component="span"
        >
          {step.label}
          {step.at && (
            <Typography
              variant="caption"
              className={classes.delta}
              component="span"
            >
              {fmtTime(step.at)}
              {typeof step.deltaSeconds === 'number' && step.deltaSeconds > 0
                ? ` (+${humanizeDuration(step.deltaSeconds)})`
                : ''}
            </Typography>
          )}
        </Typography>
        {step.detail && (
          <Typography variant="caption" className={classes.sub}>
            {step.detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export const TenantStatusCard = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const k8s = useApi(kubernetesApiRef);
  const config = useApi(configApiRef);
  const clusterName =
    config.getOptionalString('tenantStatus.clusterName') ?? DEFAULT_CLUSTER;
  const name = entity.metadata.name;

  const [status, setStatus] = useState<TenantStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const fetchOnce = useCallback(async () => {
    try {
      const res = await k8s.proxy({
        clusterName,
        path: `/apis/platform.refplat.org/v1alpha2/xtenants/${encodeURIComponent(
          name,
        )}`,
      });
      if (res.status === 404) {
        setNotFound(true);
        setStatus(undefined);
        return 'provisioning';
      }
      if (!res.ok) {
        throw new Error(
          `XTenant fetch failed: ${res.status} ${res.statusText}`,
        );
      }
      const xt = await res.json();
      const parsed = parseTenantStatus(xt);
      setNotFound(false);
      setError(undefined);
      setStatus(parsed);
      return parsed.phase;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return 'error';
    } finally {
      setLoading(false);
    }
  }, [k8s, clusterName, name]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const phase = await fetchOnce();
      if (cancelled) return;
      // Keep polling only while it can still change (provisioning / not-yet-synced).
      if (phase === 'provisioning' || phase === 'unknown') {
        timer.current = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchOnce]);

  const title = 'Tenant Provisioning';

  if (loading && !status && !notFound && !error) {
    return (
      <InfoCard title={title}>
        <Progress />
      </InfoCard>
    );
  }

  if (error) {
    return (
      <InfoCard title={title}>
        <Box className={classes.header}>
          <StatusError />
          <Typography variant="body2">
            Couldn't read the tenant status.
          </Typography>
        </Box>
        <Typography variant="caption" className={classes.sub}>
          {error}
        </Typography>
      </InfoCard>
    );
  }

  if (notFound || !status) {
    return (
      <InfoCard title={title}>
        <Box className={classes.header}>
          <StatusRunning />
          <Typography variant="body2">
            Provisioning is starting — the claim hasn't synced to the cluster
            yet.
          </Typography>
        </Box>
      </InfoCard>
    );
  }

  const sourceUrl = (entity.metadata.annotations ?? {})[
    'backstage.io/managed-by-location'
  ]?.replace(/^url:/, '');

  return (
    <InfoCard title={title}>
      <HeaderStatus status={status} />

      <Box>
        {status.steps.map((s, i) => (
          <Step key={s.key} step={s} last={i === status.steps.length - 1} />
        ))}
      </Box>

      {status.domains.length > 0 && (
        <>
          <Typography
            variant="overline"
            className={classes.section}
            display="block"
          >
            Endpoints
          </Typography>
          {status.domains.map(d => (
            <Box key={d.host} className={classes.domain}>
              {d.active ? <StatusOK /> : <StatusPending />}
              <Typography variant="body2">{d.host}</Typography>
              <Typography variant="caption" className={classes.sub}>
                {d.state}
              </Typography>
            </Box>
          ))}
        </>
      )}

      <Box className={classes.links}>
        <Link to={`/catalog/default/system/${name}/kubernetes`}>
          Kubernetes
        </Link>
        {sourceUrl && (
          <Link to={sourceUrl} externalLinkIcon>
            Source
          </Link>
        )}
      </Box>
    </InfoCard>
  );
};
