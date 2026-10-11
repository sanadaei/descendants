import type {
  AdvanceRequest, AdvanceResult, AreaProjection, AreaQuery, CommandResult, EntityId, KnowledgeRecord,
  SpatialRef, WorldCommand, WorldEntity, WorldManifest, WorldProvider, WorldRelation, WorldSnapshot,
} from './contract.js';

function distanceKm(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function clone<T>(value: T): T { return structuredClone(value); }

/**
 * Game-side read/write facade for a contract-valid snapshot. It is intentionally implementation-agnostic:
 * tests can prove the game loop does not depend on MockWorldProvider-specific branches before the real
 * Worldgen engine is available. Commands are recorded as intervention causal records but do not invent
 * setting-specific physical outcomes; those remain the real provider's responsibility.
 */
export class SnapshotWorldProvider implements WorldProvider {
  #snapshot: WorldSnapshot;
  #commandSequence = 0;

  constructor(snapshot: WorldSnapshot) {
    this.#snapshot = clone(snapshot);
  }

  async getManifest(): Promise<WorldManifest> { return clone(this.#snapshot.manifest); }

  async getEntity(id: EntityId): Promise<WorldEntity | null> {
    const entity = this.#snapshot.entities.find((candidate) => candidate.id === id);
    return entity ? clone(entity) : null;
  }

  async queryArea(query: AreaQuery): Promise<AreaProjection> {
    const entities = this.#snapshot.entities.filter((entity) => {
      if (!entity.spatial || distanceKm(entity.spatial, query.center) > query.radiusKm) return false;
      return !query.entityKinds?.length || query.entityKinds.includes(entity.kind);
    });
    const ids = new Set(entities.map((entity) => entity.id));
    const relations: WorldRelation[] = this.#snapshot.relations.filter((relation) => ids.has(relation.sourceId) || ids.has(relation.targetId));
    const observationIds = query.includeKnowledgeProjection
      ? this.#snapshot.knowledge.filter((entry) => query.observerId ? entry.holderId === query.observerId : true).map((entry) => entry.id)
      : [];
    return {
      tick: this.#snapshot.manifest.currentTick,
      effectiveDetailRank: query.requestedDetailRank,
      entities: clone(entities),
      relations: clone(relations),
      aggregates: clone(this.#snapshot.aggregates),
      observationIds,
    };
  }

  async getKnowledge(holderId: EntityId, subjectId?: string): Promise<KnowledgeRecord[]> {
    return clone(this.#snapshot.knowledge.filter((entry) => entry.holderId === holderId && (!subjectId || entry.subjectIds.includes(subjectId))));
  }

  async issueCommand(command: WorldCommand): Promise<CommandResult> {
    const id = `snapshot-intervention:${++this.#commandSequence}`;
    this.#snapshot.causalRecords.push({
      id,
      kind: 'intervention',
      parentIds: [...(command.epistemicBasisIds ?? [])],
      tick: this.#snapshot.manifest.currentTick,
      hiddenTruth: false,
      payload: { commandId: command.id, kind: command.kind, payload: clone(command.payload) },
    });
    return { commandId: command.id, accepted: true, eventIds: [], causalRecordIds: [id] };
  }

  async advance(request: AdvanceRequest): Promise<AdvanceResult> {
    const fromTick = this.#snapshot.manifest.currentTick;
    const toTick = Math.max(fromTick, Math.floor(request.toTick));
    this.#snapshot.manifest.currentTick = toTick;
    return { fromTick, toTick, eventIds: [], changedEntityIds: [], changedAggregateKeys: [] };
  }

  async exportSnapshot(): Promise<WorldSnapshot> { return clone(this.#snapshot); }
}
