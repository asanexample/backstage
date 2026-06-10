import type { UserInfoService } from '@backstage/backend-plugin-api';
import {
  createVerifyTeamMembershipAction,
  PLATFORM_ADMINS_REF,
} from './verifyTeamMembership';

const credentials = { $$type: '@backstage/BackstageCredentials' as const };

const makeUserInfo = (refs: string[] | Error): UserInfoService => ({
  getUserInfo: jest.fn(async () => {
    if (refs instanceof Error) throw refs;
    return {
      userEntityRef: 'user:default/tester',
      ownershipEntityRefs: refs,
    };
  }),
});

// The handler only touches input, logger, and getInitiatorCredentials — a minimal ctx suffices
// (this scaffolder-node version ships no createMockActionContext).
const run = (action: any, input: Record<string, unknown>) =>
  action.handler({
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    getInitiatorCredentials: async () => credentials,
  });

describe('platform:verify-team-membership', () => {
  it('passes a member of the target team', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo(['group:default/charlie']),
    });
    await expect(run(action, { team: 'charlie' })).resolves.toBeUndefined();
  });

  it('normalizes a full entity ref the same as a bare name', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo(['group:default/charlie']),
    });
    await expect(
      run(action, { team: 'group:default/charlie' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a non-member', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo(['group:default/alpha']),
    });
    await expect(run(action, { team: 'charlie' })).rejects.toThrow(
      /not a member of group:default\/charlie/,
    );
  });

  it('lets a platform admin act for any team', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo([PLATFORM_ADMINS_REF]),
    });
    await expect(run(action, { team: 'charlie' })).resolves.toBeUndefined();
  });

  it('requireAdmin rejects a non-admin even for their own team', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo(['group:default/charlie']),
    });
    await expect(
      run(action, { team: 'charlie', requireAdmin: true }),
    ).rejects.toThrow(/not a platform admin/);
  });

  it('requireAdmin passes an admin', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo([PLATFORM_ADMINS_REF]),
    });
    await expect(run(action, { requireAdmin: true })).resolves.toBeUndefined();
  });

  it('refuses to verify nothing (no team, no requireAdmin)', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo(['group:default/charlie']),
    });
    await expect(run(action, {})).rejects.toThrow(/refusing to verify nothing/);
  });

  it('fails closed when the initiator has no user info (service principal)', async () => {
    const action = createVerifyTeamMembershipAction({
      userInfo: makeUserInfo(new Error('no user info for service credentials')),
    });
    await expect(run(action, { team: 'charlie' })).rejects.toThrow(
      /no user info/,
    );
  });
});
