export class ModuleRegistry {
    #modules = new Map();
    register(module) {
        if (this.#modules.has(module.id))
            throw new Error(`Duplicate module: ${module.id}`);
        this.#modules.set(module.id, module);
        return this;
    }
    require(id) {
        const value = this.#modules.get(id);
        if (!value)
            throw new Error(`Worldgen module not registered: ${id}`);
        return value;
    }
    list() { return [...this.#modules.values()]; }
}
