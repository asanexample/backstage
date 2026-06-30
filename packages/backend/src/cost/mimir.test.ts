import { queryByTeam, mergeTeamCost, type MimirDeps } from './mimir';

const fakeFetch = (status: number, result: unknown[]): MimirDeps['fetch'] =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => 'err',
    json: async () => ({ data: { result } }),
  })) as unknown as MimirDeps['fetch'];

describe('queryByTeam', () => {
  it('sends the tenant header + the encoded query, returns per-team values', async () => {
    let seenUrl = '';
    let seenTenant = '';
    const deps: MimirDeps = {
      baseUrl: 'http://mimir/prometheus',
      tenant: 'platform|preprod',
      fetch: (async (
        url: string,
        opts: { headers: Record<string, string> },
      ) => {
        seenUrl = url;
        seenTenant = opts.headers['X-Scope-OrgID'];
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            data: {
              result: [{ metric: { team: 'alpha' }, value: [0, '12.5'] }],
            },
          }),
        };
      }) as unknown as MimirDeps['fetch'],
    };
    const out = await queryByTeam(deps, 'up{a="b"}');
    expect(seenTenant).toBe('platform|preprod');
    expect(seenUrl).toContain('http://mimir/prometheus/api/v1/query?query=');
    expect(seenUrl).toContain(encodeURIComponent('up{a="b"}'));
    expect(out).toEqual([{ team: 'alpha', value: 12.5 }]);
  });

  it('drops rows with no team label', async () => {
    const deps: MimirDeps = {
      baseUrl: 'x',
      tenant: 't',
      fetch: fakeFetch(200, [{ metric: {}, value: [0, '1'] }]),
    };
    expect(await queryByTeam(deps, 'q')).toEqual([]);
  });

  it('throws on a non-2xx response', async () => {
    const deps: MimirDeps = {
      baseUrl: 'x',
      tenant: 't',
      fetch: fakeFetch(503, []),
    };
    await expect(queryByTeam(deps, 'q')).rejects.toThrow(
      /Mimir query failed: 503/,
    );
  });
});

describe('mergeTeamCost', () => {
  it('joins spend + budget and computes utilization', () => {
    const out = mergeTeamCost(
      [
        { team: 'alpha', value: 800 },
        { team: 'bravo', value: 50 },
      ],
      [
        { team: 'alpha', value: 2000 },
        { team: 'platform', value: 5000 },
      ],
    );
    expect(out).toEqual([
      {
        team: 'alpha',
        monthlySpendUSD: 800,
        budgetUSD: 2000,
        utilizationPct: 40,
      },
      // bravo has spend but no budget → utilization unknown
      {
        team: 'bravo',
        monthlySpendUSD: 50,
        budgetUSD: null,
        utilizationPct: null,
      },
      // platform has a budget but no spend → 0%
      {
        team: 'platform',
        monthlySpendUSD: 0,
        budgetUSD: 5000,
        utilizationPct: 0,
      },
    ]);
  });
});
