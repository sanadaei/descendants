import type { JsonValue, WorldEntity } from './contract.js';
export interface LodCoarseningContext {
    tick: number;
    cohort: WorldEntity;
    person: WorldEntity;
    anchor?: WorldEntity;
}
export interface LodRestoreContext {
    tick: number;
    cohort: WorldEntity;
    anchor: WorldEntity;
    ordinal: number;
    summary: JsonValue;
}
export interface LodCoarseningPolicy {
    id: string;
    summarize(context: LodCoarseningContext): JsonValue | undefined;
    restore?(context: LodRestoreContext): Record<string, JsonValue> | undefined;
}
export declare class LodCoarseningPolicyRegistry {
    #private;
    register(policy: LodCoarseningPolicy): this;
    unregister(id: string): boolean;
    get(id: string): LodCoarseningPolicy | undefined;
    require(id: string): LodCoarseningPolicy;
    list(): LodCoarseningPolicy[];
}
/** Public process-level registry. Recipes opt into registered policies by id via lod.config.coarseningPolicyIds. */
export declare const lodCoarseningPolicyRegistry: LodCoarseningPolicyRegistry;
