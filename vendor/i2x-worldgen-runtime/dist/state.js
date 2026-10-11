import { stableId } from './util.js';
/**
 * Mutation helper for one generation/runtime pass.
 *
 * Every canonical collection is indexed once at construction so additions are O(1)
 * by stable identity. This matters for large worlds where linear duplicate scans turn
 * event-rich history generation into quadratic work.
 */
export class SnapshotBuilder {
    snapshot;
    #causalIds;
    #entitiesById;
    #relationIds;
    #eventsById;
    constructor(snapshot) {
        this.snapshot = snapshot;
        this.#causalIds = new Set(snapshot.causalRecords.map((record) => record.id));
        this.#entitiesById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
        this.#relationIds = new Set(snapshot.relations.map((relation) => relation.id));
        this.#eventsById = new Map(snapshot.events.map((event) => [event.id, event]));
    }
    causal(kind, hiddenTruth, parentIds, payload, tick) {
        const id = stableId('cause', kind, tick ?? null, parentIds, payload);
        if (!this.#causalIds.has(id)) {
            const record = { id, kind, parentIds: [...parentIds], hiddenTruth, payload };
            if (tick !== undefined)
                record.tick = tick;
            this.snapshot.causalRecords.push(record);
            this.#causalIds.add(id);
        }
        return id;
    }
    entity(kind, key, components, provenanceIds, spatial, subtype) {
        const id = stableId('ent', kind, key);
        const found = this.#entitiesById.get(id);
        if (found)
            return found;
        const entity = { id, kind, components, provenanceIds: [...provenanceIds] };
        if (spatial)
            entity.spatial = spatial;
        if (subtype)
            entity.subtype = subtype;
        this.snapshot.entities.push(entity);
        this.#entitiesById.set(id, entity);
        return entity;
    }
    relation(kind, sourceId, targetId, provenanceIds, data = {}) {
        const id = stableId('rel', kind, sourceId, targetId, data);
        const relation = { id, kind, sourceId, targetId, data, provenanceIds: [...provenanceIds] };
        if (!this.#relationIds.has(id)) {
            this.snapshot.relations.push(relation);
            this.#relationIds.add(id);
        }
        return relation;
    }
    event(kind, tick, actorIds, targetIds, data, causeIds, provenanceIds, location) {
        const id = stableId('evt', kind, tick, actorIds, targetIds, data);
        const existing = this.#eventsById.get(id);
        if (existing)
            return existing;
        const event = { id, kind, tick, actorIds, targetIds, data, causeIds, provenanceIds };
        if (location)
            event.location = location;
        this.snapshot.events.push(event);
        this.#eventsById.set(id, event);
        return event;
    }
}
