import { Pool } from 'pg';

/**
 * Read side of the durable governance audit (ADR-088 §3.6). The operator WRITES the append-only
 * `activation_audit` rows to the ADR-084 directory Postgres; this reads them back for the per-person Access
 * view ("what has this person held, when, why, how-proven, how-long"). Read-only.
 */

export type Reach = { team?: string; scope?: string };

export interface AuditEvent {
  event: string; // granted | revoked | renewed-<n>
  role: string;
  reach: Reach;
  reason?: string;
  stepUpAcr?: string;
  grantedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  recordedAt: string;
}

export interface AuditReader {
  historyFor(principal: string, limit?: number): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

// The slice of pg.Pool we use — lets the query path be unit-tested with a fake.
export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: AuditRow[] }>;
}

export type AuditRow = {
  event: string;
  role: string;
  reach_team: string | null;
  reach_scope: string | null;
  reason: string | null;
  step_up_acr: string | null;
  granted_at: Date | string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  recorded_at: Date | string;
};

const iso = (v: Date | string | null | undefined): string | undefined => {
  if (v === null || v === undefined) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
};

const rowReach = (r: AuditRow): Reach => {
  if (r.reach_scope) return { scope: r.reach_scope };
  if (r.reach_team) return { team: r.reach_team };
  return {};
};

/** Pure row → event projection (unit-tested). */
export function rowToEvent(r: AuditRow): AuditEvent {
  return {
    event: r.event,
    role: r.role,
    reach: rowReach(r),
    reason: r.reason ?? undefined,
    stepUpAcr: r.step_up_acr ?? undefined,
    grantedAt: iso(r.granted_at),
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
    recordedAt: iso(r.recorded_at)!,
  };
}

const SELECT = `
  SELECT event, role, reach_team, reach_scope, reason, step_up_acr,
         granted_at, expires_at, revoked_at, recorded_at
  FROM activation_audit
  WHERE principal = $1
  ORDER BY recorded_at DESC
  LIMIT $2`;

export class PgAuditReader implements AuditReader {
  constructor(private readonly db: Queryable, private readonly pool?: Pool) {}

  async historyFor(principal: string, limit = 100): Promise<AuditEvent[]> {
    const { rows } = await this.db.query(SELECT, [principal, limit]);
    return rows.map(rowToEvent);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

/** Disabled reader — returns no history (when AUDIT_DB_DSN is unset). */
export class NopAuditReader implements AuditReader {
  async historyFor(
    _principal?: string,
    _limit?: number,
  ): Promise<AuditEvent[]> {
    return [];
  }
  async close(): Promise<void> {}
}

/** Build the reader from a DSN (empty → Nop, so the view degrades to standing + live only). */
export function createAuditReader(dsn?: string): AuditReader {
  if (!dsn) return new NopAuditReader();
  const pool = new Pool({ connectionString: dsn, max: 3 });
  return new PgAuditReader(pool, pool);
}
