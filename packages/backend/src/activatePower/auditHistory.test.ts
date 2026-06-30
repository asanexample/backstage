import {
  rowToEvent,
  PgAuditReader,
  NopAuditReader,
  type AuditRow,
  type Queryable,
} from './auditHistory';

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  event: 'granted',
  role: 'break-glass',
  reach_team: null,
  reach_scope: 'platform',
  reason: 'prod incident',
  step_up_acr: 'silver',
  granted_at: new Date('2026-06-30T02:16:45Z'),
  expires_at: new Date('2026-06-30T03:16:45Z'),
  revoked_at: null,
  recorded_at: new Date('2026-06-30T02:16:46Z'),
  ...over,
});

describe('rowToEvent', () => {
  it('projects a row, picking scope|team and ISO-ifying dates', () => {
    expect(rowToEvent(row())).toEqual({
      event: 'granted',
      role: 'break-glass',
      reach: { scope: 'platform' },
      reason: 'prod incident',
      stepUpAcr: 'silver',
      grantedAt: '2026-06-30T02:16:45.000Z',
      expiresAt: '2026-06-30T03:16:45.000Z',
      revokedAt: undefined,
      recordedAt: '2026-06-30T02:16:46.000Z',
    });
  });

  it('uses team when scope is absent, and drops null optionals', () => {
    const e = rowToEvent(
      row({
        reach_scope: null,
        reach_team: 'alpha',
        reason: null,
        step_up_acr: null,
      }),
    );
    expect(e.reach).toEqual({ team: 'alpha' });
    expect(e.reason).toBeUndefined();
    expect(e.stepUpAcr).toBeUndefined();
  });
});

describe('PgAuditReader.historyFor', () => {
  it('queries by principal + limit and maps rows newest-first', async () => {
    let seen: { sql: string; params: unknown[] } | undefined;
    const fake: Queryable = {
      query: async (sql, params) => {
        seen = { sql, params };
        return {
          rows: [row({ event: 'renewed-1' }), row({ event: 'granted' })],
        };
      },
    };
    const out = await new PgAuditReader(fake).historyFor('josh', 50);
    expect(seen?.params).toEqual(['josh', 50]);
    expect(seen?.sql).toContain('FROM activation_audit');
    expect(out.map(e => e.event)).toEqual(['renewed-1', 'granted']);
  });
});

describe('NopAuditReader', () => {
  it('returns no history', async () => {
    expect(await new NopAuditReader().historyFor('josh')).toEqual([]);
  });
});
