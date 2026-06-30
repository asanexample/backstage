import {
  activationName,
  buildActivationManifest,
  getPersonGrants,
  submitActivation,
  listActivations,
  getActivation,
  deleteActivation,
  requestExtend,
  AlreadyActiveError,
  type FetchLike,
  type ProxyDeps,
} from './createActivation';

describe('activationName', () => {
  it('is deterministic and k8s-valid (principal-role-reach, lowercased)', () => {
    expect(activationName('josh', 'break-glass', { scope: 'platform' })).toBe(
      'josh-break-glass-platform',
    );
    expect(activationName('Alpha-Dev', 'developer', { team: 'alpha' })).toBe(
      'alpha-dev-developer-alpha',
    );
  });
});

describe('buildActivationManifest', () => {
  it('builds the Activation CR with principal == requestedBy and the step-up stamped', () => {
    const m = buildActivationManifest({
      principal: 'josh',
      role: 'break-glass',
      reach: { scope: 'platform' },
      duration: '1h',
      reason: 'prod incident',
      stepUp: { authTime: '2026-06-29T20:00:00.000Z', acr: 'passkey' },
    }) as any;
    expect(m.apiVersion).toBe('platform.refplat.org/v1alpha1');
    expect(m.kind).toBe('Activation');
    expect(m.metadata.name).toBe('josh-break-glass-platform');
    expect(m.spec).toMatchObject({
      principal: 'josh',
      requestedBy: 'josh',
      role: 'break-glass',
      reach: { scope: 'platform' },
      duration: '1h',
      reason: 'prod incident',
      stepUp: { authTime: '2026-06-29T20:00:00.000Z', acr: 'passkey' },
    });
  });
});

function fakeProxy(
  responder: (
    method: string,
    url: string,
    body?: string,
  ) => { status: number; body?: string },
): ProxyDeps {
  const fetch: FetchLike = async (url, init) => {
    const { status, body = '' } = responder(
      init?.method ?? 'GET',
      url,
      init?.body,
    );
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    };
  };
  return { baseUrl: 'http://k8s', token: 't', clusterName: 'c', fetch };
}

const peopleList = (...people: Array<{ person: string; grants: unknown[] }>) =>
  JSON.stringify({ items: people.map(p => ({ spec: p })) });

describe('getPersonGrants', () => {
  it('matches on spec.person (the login anchor), not the record name', async () => {
    // login `dev-alpha` resolves the record whose spec.person is `dev-alpha`, even though its name differs.
    const p = fakeProxy(() => ({
      status: 200,
      body: peopleList(
        { person: 'robin', grants: [{ role: 'developer', team: 'platform' }] },
        {
          person: 'dev-alpha',
          grants: [
            { role: 'break-glass', scope: 'platform', activation: 'on-demand' },
          ],
        },
      ),
    }));
    expect(await getPersonGrants(p, 'dev-alpha')).toEqual([
      { role: 'break-glass', scope: 'platform', activation: 'on-demand' },
    ]);
  });

  it('returns [] when no person anchors to that login', async () => {
    const p = fakeProxy(() => ({
      status: 200,
      body: peopleList({
        person: 'robin',
        grants: [{ role: 'developer', team: 'platform' }],
      }),
    }));
    expect(await getPersonGrants(p, 'nobody')).toEqual([]);
  });

  it('throws when the list call fails', async () => {
    const p = fakeProxy(() => ({ status: 403, body: 'forbidden' }));
    await expect(getPersonGrants(p, 'josh')).rejects.toThrow(/403/);
  });
});

describe('submitActivation', () => {
  it('POSTs the manifest and returns the created name', async () => {
    let seen: { method: string; url: string; body?: string } | undefined;
    const p = fakeProxy((method, url, body) => {
      seen = { method, url, body };
      return {
        status: 201,
        body: JSON.stringify({
          metadata: { name: 'josh-break-glass-platform' },
        }),
      };
    });
    const out = await submitActivation(p, { metadata: { name: 'x' } });
    expect(out.name).toBe('josh-break-glass-platform');
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toContain(
      '/proxy/apis/platform.refplat.org/v1alpha1/activations',
    );
  });

  it('maps a 409 to AlreadyActiveError', async () => {
    const p = fakeProxy(() => ({
      status: 409,
      body: '{"reason":"AlreadyExists"}',
    }));
    await expect(submitActivation(p, {})).rejects.toThrow(AlreadyActiveError);
  });

  it('throws on other failures', async () => {
    const p = fakeProxy(() => ({ status: 403, body: 'forbidden' }));
    await expect(submitActivation(p, {})).rejects.toThrow(/403/);
  });
});

const activationItem = (
  name: string,
  principal: string,
  extra: Record<string, unknown> = {},
) => ({
  metadata: { name },
  spec: {
    principal,
    role: 'break-glass',
    reach: { scope: 'platform' },
    reason: 'x',
  },
  status: { phase: 'Active', expiresAt: '2026-06-30T03:00:00Z' },
  ...extra,
});

describe('listActivations', () => {
  it('flattens items to summaries (spec + status)', async () => {
    const p = fakeProxy(() => ({
      status: 200,
      body: JSON.stringify({
        items: [activationItem('josh-break-glass-platform', 'josh')],
      }),
    }));
    const out = await listActivations(p);
    expect(out).toEqual([
      {
        name: 'josh-break-glass-platform',
        principal: 'josh',
        role: 'break-glass',
        reach: { scope: 'platform' },
        reason: 'x',
        phase: 'Active',
        grantedAt: undefined,
        expiresAt: '2026-06-30T03:00:00Z',
      },
    ]);
  });
});

describe('getActivation', () => {
  it('returns null on 404', async () => {
    const p = fakeProxy(() => ({ status: 404 }));
    expect(await getActivation(p, 'nope')).toBeNull();
  });
  it('returns the summary on 200', async () => {
    const p = fakeProxy(() => ({
      status: 200,
      body: JSON.stringify(activationItem('a', 'robin')),
    }));
    expect((await getActivation(p, 'a'))?.principal).toBe('robin');
  });
});

describe('deleteActivation', () => {
  it('DELETEs the named CR', async () => {
    let seen: { method: string; url: string } | undefined;
    const p = fakeProxy((method, url) => {
      seen = { method, url };
      return { status: 200 };
    });
    await deleteActivation(p, 'josh-break-glass-platform');
    expect(seen?.method).toBe('DELETE');
    expect(seen?.url).toContain('/activations/josh-break-glass-platform');
  });
  it('treats 404 as success (idempotent)', async () => {
    const p = fakeProxy(() => ({ status: 404 }));
    await expect(deleteActivation(p, 'gone')).resolves.toBeUndefined();
  });
  it('throws on other failures', async () => {
    const p = fakeProxy(() => ({ status: 403, body: 'forbidden' }));
    await expect(deleteActivation(p, 'x')).rejects.toThrow(/403/);
  });
});

describe('requestExtend', () => {
  it('PATCHes the renew annotation with a merge-patch', async () => {
    let seen: { method: string; url: string } | undefined;
    const p = fakeProxy((method, url) => {
      seen = { method, url };
      return { status: 200 };
    });
    const ok = await requestExtend(p, 'josh-break-glass-platform', {
      nonce: 'n1',
      authTime: '2026-06-30T02:50:00.000Z',
      acr: 'silver',
    });
    expect(ok).toBe(true);
    expect(seen?.method).toBe('PATCH');
    expect(seen?.url).toContain('/activations/josh-break-glass-platform');
  });
  it('returns false on 404 (borrow already gone)', async () => {
    const p = fakeProxy(() => ({ status: 404 }));
    expect(await requestExtend(p, 'gone', { nonce: 'n', authTime: 't' })).toBe(
      false,
    );
  });
  it('throws on other failures', async () => {
    const p = fakeProxy(() => ({ status: 403, body: 'forbidden' }));
    await expect(
      requestExtend(p, 'x', { nonce: 'n', authTime: 't' }),
    ).rejects.toThrow(/403/);
  });
});
