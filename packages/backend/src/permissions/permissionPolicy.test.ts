import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  catalogEntityReadPermission,
  catalogEntityDeletePermission,
  catalogEntityCreatePermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  actionExecutePermission,
  taskCancelPermission,
  taskCreatePermission,
} from '@backstage/plugin-scaffolder-common/alpha';
import type {
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  CentricPermissionPolicy,
  PLATFORM_ADMINS_REF,
} from './permissionPolicy';

// The policy only reads user.info.ownershipEntityRefs, so a partial cast is sufficient.
const userWith = (ownershipEntityRefs: string[]): PolicyQueryUser =>
  ({
    info: { userEntityRef: ownershipEntityRefs[0] ?? '', ownershipEntityRefs },
  } as unknown as PolicyQueryUser);

const q = (permission: PolicyQuery['permission']): PolicyQuery => ({
  permission,
});

describe('CentricPermissionPolicy', () => {
  const policy = new CentricPermissionPolicy();

  it('allows platform-admins everything (including writes)', async () => {
    const decision = await policy.handle(
      q(catalogEntityDeletePermission),
      userWith([PLATFORM_ADMINS_REF]),
    );
    expect(decision.result).toBe(AuthorizeResult.ALLOW);
  });

  it('allows any signed-in user to read the catalog', async () => {
    const decision = await policy.handle(
      q(catalogEntityReadPermission),
      userWith(['group:default/alpha']),
    );
    expect(decision.result).toBe(AuthorizeResult.ALLOW);
  });

  it('denies writes for a user with no group refs', async () => {
    const decision = await policy.handle(
      q(catalogEntityDeletePermission),
      userWith([]),
    );
    expect(decision.result).toBe(AuthorizeResult.DENY);
  });

  it('makes catalog deletes conditional on team ownership for a non-admin', async () => {
    const decision = await policy.handle(
      q(catalogEntityDeletePermission),
      userWith(['user:default/dev-alpha', 'group:default/alpha']),
    );
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
  });

  it('denies non-resource catalog create (register) for a non-admin team member', async () => {
    const decision = await policy.handle(
      q(catalogEntityCreatePermission),
      userWith(['group:default/alpha']),
    );
    expect(decision.result).toBe(AuthorizeResult.DENY);
  });

  // #281 (ADR-062 §1): team members may RUN scaffolder templates; per-template scoping is the
  // platform:verify-team-membership action's job, not the policy's.
  it('allows scaffolder task create + action execute for a team member', async () => {
    const member = userWith(['group:default/charlie']);
    expect((await policy.handle(q(taskCreatePermission), member)).result).toBe(
      AuthorizeResult.ALLOW,
    );
    expect(
      (await policy.handle(q(actionExecutePermission), member)).result,
    ).toBe(AuthorizeResult.ALLOW);
  });

  it('denies scaffolder task create for a user with no group refs', async () => {
    const decision = await policy.handle(q(taskCreatePermission), userWith([]));
    expect(decision.result).toBe(AuthorizeResult.DENY);
  });

  it('denies scaffolder task cancel for a non-admin (not granted to members)', async () => {
    const decision = await policy.handle(
      q(taskCancelPermission),
      userWith(['group:default/charlie']),
    );
    expect(decision.result).toBe(AuthorizeResult.DENY);
  });
});
