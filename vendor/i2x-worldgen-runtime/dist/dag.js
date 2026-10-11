export function sortGenerationPasses(passes) {
    const enabled = passes.filter((pass) => pass.enabled ?? true);
    const byId = new Map(enabled.map((pass) => [pass.id, pass]));
    for (const pass of enabled) {
        for (const dependency of pass.dependsOn ?? []) {
            if (!byId.has(dependency))
                throw new Error(`Pass ${pass.id} depends on missing/disabled pass ${dependency}`);
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const sorted = [];
    const visit = (id) => {
        if (visited.has(id))
            return;
        if (visiting.has(id))
            throw new Error(`Generation pipeline contains a cycle at ${id}`);
        visiting.add(id);
        const pass = byId.get(id);
        for (const dependency of pass.dependsOn ?? [])
            visit(dependency);
        visiting.delete(id);
        visited.add(id);
        sorted.push(pass);
    };
    for (const pass of enabled)
        visit(pass.id);
    return sorted;
}
