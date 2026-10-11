import type { CausalRecord, JsonValue, WorldEntity, WorldEventRecord, WorldRelation, WorldSnapshot } from './contract.js';
/**
 * Mutation helper for one generation/runtime pass.
 *
 * Every canonical collection is indexed once at construction so additions are O(1)
 * by stable identity. This matters for large worlds where linear duplicate scans turn
 * event-rich history generation into quadratic work.
 */
export declare class SnapshotBuilder {
    #private;
    readonly snapshot: WorldSnapshot;
    constructor(snapshot: WorldSnapshot);
    causal(kind: CausalRecord['kind'], hiddenTruth: boolean, parentIds: string[], payload: Record<string, JsonValue>, tick?: number): string;
    entity(kind: string, key: unknown, components: Record<string, JsonValue>, provenanceIds: string[], spatial?: WorldEntity['spatial'], subtype?: string): WorldEntity;
    relation(kind: string, sourceId: string, targetId: string, provenanceIds: string[], data?: Record<string, JsonValue>): WorldRelation;
    event(kind: string, tick: number, actorIds: string[], targetIds: string[], data: Record<string, JsonValue>, causeIds: string[], provenanceIds: string[], location?: WorldEventRecord['location']): WorldEventRecord;
}
