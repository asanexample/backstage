import { Entity } from '@backstage/catalog-model';
import { EnvironmentRelationProcessor } from './environmentRelationProcessor';

const env = (spec: any): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Environment',
  metadata: { name: 'alpha-demo-dev' },
  spec,
});

const run = (entity: Entity) => {
  const emitted: any[] = [];
  const p = new EnvironmentRelationProcessor();
  return p
    .postProcessEntity(entity, {} as any, r => emitted.push(r))
    .then(() => emitted.filter(r => r.type === 'relation').map(r => r.relation));
};

describe('EnvironmentRelationProcessor', () => {
  it('emits ownedBy/ownerOf + partOf/hasPart for a kind:Environment', async () => {
    const rels = await run(
      env({ owner: 'group:alpha', system: 'alpha-demo' }),
    );
    const self = { kind: 'Environment', namespace: 'default', name: 'alpha-demo-dev' };
    const group = { kind: 'group', namespace: 'default', name: 'alpha' };
    const system = { kind: 'System', namespace: 'default', name: 'alpha-demo' };
    expect(rels).toEqual(
      expect.arrayContaining([
        { source: self, type: 'ownedBy', target: group },
        { source: group, type: 'ownerOf', target: self },
        { source: self, type: 'partOf', target: system },
        { source: system, type: 'hasPart', target: self },
      ]),
    );
  });

  it('defaults the owner to a Group and the system to a System ref', async () => {
    const rels = await run(env({ owner: 'alpha', system: 'alpha-demo' }));
    expect(rels.find(r => r.type === 'ownedBy').target).toMatchObject({ kind: 'Group', name: 'alpha' });
    expect(rels.find(r => r.type === 'partOf').target).toMatchObject({ kind: 'System', name: 'alpha-demo' });
  });

  it('emits nothing for non-Environment kinds (e.g. a System)', async () => {
    const sys = { ...env({ owner: 'group:alpha' }), kind: 'System' };
    expect(await run(sys)).toHaveLength(0);
  });

  it('skips the relation when the field is absent', async () => {
    const rels = await run(env({ owner: 'group:alpha' })); // no system
    expect(rels.some(r => r.type === 'partOf')).toBe(false);
    expect(rels.some(r => r.type === 'ownedBy')).toBe(true);
  });
});
