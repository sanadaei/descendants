import type { JsonValue, WorldSnapshot } from './contract.js';
export declare const CURRENT_SNAPSHOT_SCHEMA_VERSION: 1;
export interface SnapshotEnvelope {
    schemaVersion: 1;
    digest: string;
    snapshot: WorldSnapshot;
}
export interface LegacySnapshotEnvelopeV0 {
    schemaVersion: 0;
    world: WorldSnapshot;
}
export interface SnapshotDelta {
    schemaVersion: 1;
    baseDigest: string;
    targetDigest: string;
    target: WorldSnapshot;
    diagnostics: Record<string, JsonValue>;
}
export declare function serializeSnapshot(snapshot: WorldSnapshot): string;
export declare function deserializeSnapshot(text: string): WorldSnapshot;
export declare function createSnapshotDelta(base: WorldSnapshot, target: WorldSnapshot): SnapshotDelta;
export declare function applySnapshotDelta(base: WorldSnapshot, delta: SnapshotDelta): WorldSnapshot;
export declare function migrateSnapshot(input: unknown): WorldSnapshot;
