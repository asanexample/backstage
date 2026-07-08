/**
 * Cost data for the Backstage Cost tab (ADR-091 A3). Queries the hub Mimir (federated tenant) for per-team
 * spend + budget — the same metrics the Grafana Cost dashboard uses — so cost is visible in the dev portal.
 * Read-only.
 */

export type TeamValue = { team: string; value: number };

export interface MimirDeps {
  fetch: typeof fetch;
  baseUrl: string; // e.g. http://mimir-gateway.observability.svc/prometheus
  tenant: string; // X-Scope-OrgID; the federated "platform|preprod"
}

// The same expressions the cost dashboard panels use. The node-cost side is wrapped in `max by (node)` so the
// federated tenant query (platform|preprod) doesn't fail with a 1-to-many `group_left()` match: since the P13
// per-team tenant routing went live, node_*_hourly_cost is written under more than one __tenant_id__ for a
// shared node, so a bare `on(node) group_left() node_*_hourly_cost` 422s ("found duplicate series ... on the
// right side"). `max by (node)` collapses the per-tenant copies to one value per node (they're identical).
export const SPEND_BY_TEAM =
  'sum by (team) ( label_replace( sum by (namespace) ( (container_cpu_allocation * on(node) group_left() max by (node) (node_cpu_hourly_cost)) + ((container_memory_allocation_bytes / 1024^3) * on(node) group_left() max by (node) (node_ram_hourly_cost)) ) * 730, "team", "$1", "namespace", "^([a-z0-9]+)-.*" ) )';

export const BUDGET_BY_TEAM = 'max by (team) (team_budget_monthly_usd)';

/** Run an instant PromQL query and return the per-team values (result rows keyed by a `team` label). */
export async function queryByTeam(
  deps: MimirDeps,
  promql: string,
): Promise<TeamValue[]> {
  const url = `${deps.baseUrl}/api/v1/query?query=${encodeURIComponent(
    promql,
  )}`;
  const res = await deps.fetch(url, {
    headers: { 'X-Scope-OrgID': deps.tenant },
  });
  if (!res.ok) {
    throw new Error(`Mimir query failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: {
      result?: Array<{ metric?: { team?: string }; value?: [number, string] }>;
    };
  };
  return (body.data?.result ?? [])
    .filter(r => r.metric?.team)
    .map(r => ({
      team: r.metric!.team as string,
      value: Number(r.value?.[1]),
    }));
}

export type TeamCost = {
  team: string;
  monthlySpendUSD: number;
  budgetUSD: number | null;
  utilizationPct: number | null;
};

/** Join spend + budget into one per-team view (spend with no budget → utilization unknown). */
export function mergeTeamCost(
  spend: TeamValue[],
  budget: TeamValue[],
): TeamCost[] {
  const spendMap = new Map(spend.map(s => [s.team, s.value]));
  const budgetMap = new Map(budget.map(b => [b.team, b.value]));
  const teams = [...new Set([...spendMap.keys(), ...budgetMap.keys()])].sort();
  return teams.map(team => {
    const s = spendMap.get(team) ?? 0;
    const b = budgetMap.get(team) ?? null;
    return {
      team,
      monthlySpendUSD: s,
      budgetUSD: b,
      utilizationPct: b && b > 0 ? (s / b) * 100 : null,
    };
  });
}
