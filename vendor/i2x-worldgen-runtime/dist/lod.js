export class LodCoarseningPolicyRegistry {
    #policies = new Map();
    register(policy) {
        if (!policy.id || !policy.id.trim())
            throw new Error('LOD coarsening policy id must be non-empty');
        if (this.#policies.has(policy.id))
            throw new Error(`LOD coarsening policy already registered: ${policy.id}`);
        this.#policies.set(policy.id, policy);
        return this;
    }
    unregister(id) { return this.#policies.delete(id); }
    get(id) { return this.#policies.get(id); }
    require(id) {
        const policy = this.#policies.get(id);
        if (!policy)
            throw new Error(`Unknown LOD coarsening policy: ${id}`);
        return policy;
    }
    list() { return [...this.#policies.values()].sort((a, b) => a.id.localeCompare(b.id)); }
}
/** Public process-level registry. Recipes opt into registered policies by id via lod.config.coarseningPolicyIds. */
export const lodCoarseningPolicyRegistry = new LodCoarseningPolicyRegistry();
