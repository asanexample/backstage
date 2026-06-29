/**
 * Front-door eligibility check (ADR-088). A lightweight "may this person borrow this role at this reach?"
 * derived from their Person registry grants — so the UI rejects an ineligible request immediately with a
 * clear message. The activation operator independently re-checks eligibility at mint (defense-in-depth), so
 * this is the friendly gate, not the security backstop.
 *
 * A borrow is allowed only for an `on-demand` grant (standing grants are already held — nothing to borrow).
 */

export interface PersonGrant {
  role: string;
  team?: string;
  scope?: string;
  activation?: string;
}

export interface Reach {
  team?: string;
  scope?: string;
}

/** True iff the grants contain an on-demand grant for exactly this role + reach. */
export function isEligibleToBorrow(
  grants: PersonGrant[],
  role: string,
  reach: Reach,
): boolean {
  return grants.some(
    g =>
      g.role === role &&
      g.activation === 'on-demand' &&
      reachMatches(g, reach),
  );
}

/** The on-demand grants a person could borrow, as {role, reach} pairs — for populating the UI. */
export function borrowableGrants(
  grants: PersonGrant[],
): Array<{ role: string; reach: Reach }> {
  return grants
    .filter(g => g.activation === 'on-demand')
    .map(g => ({
      role: g.role,
      reach: g.scope ? { scope: g.scope } : { team: g.team },
    }));
}

function reachMatches(grant: PersonGrant, reach: Reach): boolean {
  if (reach.scope) {
    return grant.scope === reach.scope;
  }
  if (reach.team) {
    return grant.team === reach.team;
  }
  return false;
}
