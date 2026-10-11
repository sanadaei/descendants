export class WorldLawEffectOperatorRegistry {
    #operators = new Map();
    register(operator) {
        if (!operator.id)
            throw new Error('World-law effect operator id is required');
        if (this.#operators.has(operator.id))
            throw new Error(`Duplicate world-law effect operator: ${operator.id}`);
        this.#operators.set(operator.id, operator);
        return this;
    }
    get(id) { return this.#operators.get(id); }
    require(id) {
        const operator = this.get(id);
        if (!operator)
            throw new Error(`World-law effect operator not registered: ${id}`);
        return operator;
    }
    list() { return [...this.#operators.values()]; }
}
export const worldLawEffectOperatorRegistry = new WorldLawEffectOperatorRegistry();
