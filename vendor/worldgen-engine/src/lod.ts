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

export class LodCoarseningPolicyRegistry {
  #policies = new Map<string, LodCoarseningPolicy>();

  register(policy: LodCoarseningPolicy): this {
    if (!policy.id || !policy.id.trim()) throw new Error('LOD coarsening policy id must be non-empty');
    if (this.#policies.has(policy.id)) throw new Error(`LOD coarsening policy already registered: ${policy.id}`);
    this.#policies.set(policy.id, policy);
    return this;
  }

  unregister(id: string): boolean { return this.#policies.delete(id); }
  get(id: string): LodCoarseningPolicy | undefined { return this.#policies.get(id); }
  require(id: string): LodCoarseningPolicy {
    const policy = this.#policies.get(id);
    if (!policy) throw new Error(`Unknown LOD coarsening policy: ${id}`);
    return policy;
  }
  list(): LodCoarseningPolicy[] { return [...this.#policies.values()].sort((a, b) => a.id.localeCompare(b.id)); }
}

/** Public process-level registry. Recipes opt into registered policies by id via lod.config.coarseningPolicyIds. */
export const lodCoarseningPolicyRegistry = new LodCoarseningPolicyRegistry();
