export class DemographyPolicyRegistry {
    #policies = new Map();
    register(policy) {
        if (!policy.id)
            throw new Error('Demography policy id is required');
        if (this.#policies.has(policy.id))
            throw new Error(`Duplicate demography policy: ${policy.id}`);
        this.#policies.set(policy.id, policy);
        return this;
    }
    unregister(id) { return this.#policies.delete(id); }
    get(id) { return this.#policies.get(id); }
    require(id) {
        const policy = this.#policies.get(id);
        if (!policy)
            throw new Error(`Demography policy not registered: ${id}`);
        return policy;
    }
    list() { return [...this.#policies.values()]; }
}
export const demographyPolicyRegistry = new DemographyPolicyRegistry();
