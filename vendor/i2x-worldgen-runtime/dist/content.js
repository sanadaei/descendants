function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
}
export class ContentPackRegistry {
    #packs = new Map();
    #migrations = new Map();
    register(pack) {
        if (this.#packs.has(pack.id))
            throw new Error(`Duplicate content pack: ${pack.id}`);
        this.#packs.set(pack.id, { ...pack, data: cloneData(pack.data) });
        return this;
    }
    registerMigration(migration) {
        if (!migration.packId || !migration.fromVersion || !migration.toVersion || migration.fromVersion === migration.toVersion)
            throw new Error('Content pack migration requires packId and distinct fromVersion/toVersion');
        const list = this.#migrations.get(migration.packId) ?? [];
        if (list.some((item) => item.fromVersion === migration.fromVersion && item.toVersion === migration.toVersion))
            throw new Error(`Duplicate content pack migration: ${migration.packId} ${migration.fromVersion}->${migration.toVersion}`);
        list.push(migration);
        list.sort((a, b) => a.fromVersion.localeCompare(b.fromVersion) || a.toVersion.localeCompare(b.toVersion));
        this.#migrations.set(migration.packId, list);
        return this;
    }
    has(id) { return this.#packs.has(id); }
    #migrationPath(packId, fromVersion, toVersion) {
        if (fromVersion === toVersion)
            return [];
        const candidates = this.#migrations.get(packId) ?? [];
        const queue = [{ version: fromVersion, path: [] }];
        const visited = new Set([fromVersion]);
        while (queue.length) {
            const current = queue.shift();
            for (const migration of candidates.filter((item) => item.fromVersion === current.version)) {
                const path = [...current.path, migration];
                if (migration.toVersion === toVersion)
                    return path;
                if (!visited.has(migration.toVersion)) {
                    visited.add(migration.toVersion);
                    queue.push({ version: migration.toVersion, path });
                }
            }
        }
        return null;
    }
    require(id, version) {
        const pack = this.#packs.get(id);
        if (!pack)
            throw new Error(`Content pack not registered: ${id}`);
        if (!version || pack.version === version)
            return { ...pack, data: cloneData(pack.data) };
        const path = this.#migrationPath(id, pack.version, version);
        if (!path)
            throw new Error(`Content pack ${id} version mismatch: recipe=${version}, registry=${pack.version}; no registered migration path`);
        let data = cloneData(pack.data);
        let currentVersion = pack.version;
        for (const migration of path) {
            if (migration.fromVersion !== currentVersion)
                throw new Error(`Invalid content migration chain for ${id}: expected ${currentVersion}, got ${migration.fromVersion}`);
            data = cloneData(migration.migrate(cloneData(data)));
            currentVersion = migration.toVersion;
        }
        const migrated = { id, version: currentVersion, data };
        this.#packs.set(id, migrated);
        return { ...migrated, data: cloneData(migrated.data) };
    }
    validateReferences(refs) {
        for (const ref of refs)
            this.require(ref.id, ref.version);
    }
    list() { return [...this.#packs.values()].map((pack) => ({ ...pack, data: cloneData(pack.data) })); }
}
