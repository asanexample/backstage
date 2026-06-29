import {
  isEligibleToBorrow,
  borrowableGrants,
  type PersonGrant,
} from './eligibility';

const grants: PersonGrant[] = [
  { role: 'access-admin', scope: 'platform' }, // standing — not borrowable
  { role: 'break-glass', scope: 'platform', activation: 'on-demand' },
  { role: 'developer', team: 'alpha', activation: 'on-demand' },
];

describe('isEligibleToBorrow', () => {
  it('allows an on-demand grant matching role + scope', () => {
    expect(
      isEligibleToBorrow(grants, 'break-glass', { scope: 'platform' }),
    ).toBe(true);
  });

  it('allows an on-demand grant matching role + team', () => {
    expect(isEligibleToBorrow(grants, 'developer', { team: 'alpha' })).toBe(
      true,
    );
  });

  it('rejects a standing grant (held, not borrowable)', () => {
    expect(
      isEligibleToBorrow(grants, 'access-admin', { scope: 'platform' }),
    ).toBe(false);
  });

  it('rejects a role the person does not hold', () => {
    expect(
      isEligibleToBorrow(grants, 'platform-operator', { scope: 'platform' }),
    ).toBe(false);
  });

  it('rejects the right role at the wrong reach', () => {
    expect(isEligibleToBorrow(grants, 'developer', { team: 'bravo' })).toBe(
      false,
    );
    expect(
      isEligibleToBorrow(grants, 'break-glass', { team: 'alpha' }),
    ).toBe(false);
  });
});

describe('borrowableGrants', () => {
  it('lists only the on-demand grants, as role+reach', () => {
    expect(borrowableGrants(grants)).toEqual([
      { role: 'break-glass', reach: { scope: 'platform' } },
      { role: 'developer', reach: { team: 'alpha' } },
    ]);
  });
});
