import {
  CatalogProcessor,
  CatalogProcessorEmit,
  processingResult,
} from '@backstage/plugin-catalog-node';
import {
  Entity,
  RELATION_OWNED_BY,
  RELATION_OWNER_OF,
  RELATION_PART_OF,
  RELATION_HAS_PART,
  getCompoundEntityRef,
  parseEntityRef,
} from '@backstage/catalog-model';

/**
 * Emits ownership + containment relations for the v3 custom `kind: Environment` (ADR-067 §10). Backstage's
 * BuiltinKindsEntityProcessor only wires `spec.owner`/`spec.system` for its KNOWN kinds (Component/System/
 * Resource/…); a custom kind gets none, so `relations.ownedBy` queries (the team-tenants card) and the
 * Product-System "has parts" view would be empty. This restores them:
 *   - spec.owner  → ownedBy / ownerOf  (Environment ⇄ its Team Group)
 *   - spec.system → partOf  / hasPart  (Environment ⇄ its Product System — the cross-stage grouping)
 * The projection (provider.ts) sets both fields on every Environment. Dangling targets are fine — the relation
 * resolves once the Group/System entity exists.
 */
export class EnvironmentRelationProcessor implements CatalogProcessor {
  getProcessorName(): string {
    return 'EnvironmentRelationProcessor';
  }

  async postProcessEntity(
    entity: Entity,
    _location: unknown,
    emit: CatalogProcessorEmit,
  ): Promise<Entity> {
    if (
      entity.apiVersion === 'backstage.io/v1alpha1' &&
      entity.kind === 'Environment'
    ) {
      const self = getCompoundEntityRef(entity);
      const spec = entity.spec as
        | { owner?: string; system?: string }
        | undefined;

      const owner = spec?.owner;
      if (owner) {
        const target = parseEntityRef(owner, {
          defaultKind: 'Group',
          defaultNamespace: entity.metadata.namespace,
        });
        emit(processingResult.relation({ source: self, type: RELATION_OWNED_BY, target }));
        emit(processingResult.relation({ source: target, type: RELATION_OWNER_OF, target: self }));
      }

      const system = spec?.system;
      if (system) {
        const target = parseEntityRef(system, {
          defaultKind: 'System',
          defaultNamespace: entity.metadata.namespace,
        });
        emit(processingResult.relation({ source: self, type: RELATION_PART_OF, target }));
        emit(processingResult.relation({ source: target, type: RELATION_HAS_PART, target: self }));
      }
    }
    return entity;
  }
}
