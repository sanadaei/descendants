import { deepClone, stableStringify } from './util.js';
import { snapshotDigest } from './engine.js';
export const CURRENT_SNAPSHOT_SCHEMA_VERSION = 1;
export function serializeSnapshot(snapshot) {
    const envelope = { schemaVersion: 1, digest: snapshotDigest(snapshot), snapshot: deepClone(snapshot) };
    return stableStringify(envelope);
}
export function deserializeSnapshot(text) {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed && parsed.schemaVersion === 0)
        return migrateSnapshot(parsed);
    const envelope = parsed;
    if (envelope.schemaVersion !== 1 || !envelope.snapshot || typeof envelope.digest !== 'string')
        throw new Error('Unsupported or malformed snapshot envelope');
    if (envelope.snapshot.manifest?.contractVersion !== '1.0.0')
        throw new Error('Unsupported world contract version');
    const actual = snapshotDigest(envelope.snapshot);
    if (actual !== envelope.digest)
        throw new Error(`Snapshot digest mismatch: expected ${envelope.digest}, got ${actual}`);
    return deepClone(envelope.snapshot);
}
export function createSnapshotDelta(base, target) {
    const baseDigest = snapshotDigest(base);
    const targetDigest = snapshotDigest(target);
    return {
        schemaVersion: 1,
        baseDigest,
        targetDigest,
        target: deepClone(target),
        diagnostics: {
            entityDelta: target.entities.length - base.entities.length,
            eventDelta: target.events.length - base.events.length,
            knowledgeDelta: target.knowledge.length - base.knowledge.length,
        },
    };
}
export function applySnapshotDelta(base, delta) {
    if (delta.schemaVersion !== 1)
        throw new Error(`Unsupported delta schema ${String(delta.schemaVersion)}`);
    const actualBase = snapshotDigest(base);
    if (actualBase !== delta.baseDigest)
        throw new Error(`Delta base mismatch: expected ${delta.baseDigest}, got ${actualBase}`);
    const target = deepClone(delta.target);
    const actualTarget = snapshotDigest(target);
    if (actualTarget !== delta.targetDigest)
        throw new Error(`Delta target mismatch: expected ${delta.targetDigest}, got ${actualTarget}`);
    return target;
}
export function migrateSnapshot(input) {
    if (!input || typeof input !== 'object')
        throw new Error('Cannot migrate non-object snapshot');
    const maybeRaw = input;
    if (maybeRaw.manifest?.contractVersion === '1.0.0' && Array.isArray(maybeRaw.entities))
        return deepClone(maybeRaw);
    const envelope = input;
    if (envelope.schemaVersion === 0 && envelope.world?.manifest?.contractVersion === '1.0.0') {
        const migrated = deepClone(envelope.world);
        migrated.aggregates = migrated.aggregates ?? {};
        migrated.aggregates.persistenceMigration = { fromSchemaVersion: 0, toSchemaVersion: 1 };
        return migrated;
    }
    if (envelope.schemaVersion === 1 && envelope.snapshot?.manifest?.contractVersion === '1.0.0')
        return deepClone(envelope.snapshot);
    throw new Error('No migration path for supplied snapshot');
}
