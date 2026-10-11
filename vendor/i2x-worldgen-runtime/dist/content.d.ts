import type { JsonValue, VersionedRef } from './contract.js';
export interface ContentPack extends VersionedRef {
    data: Record<string, JsonValue>;
}
export interface ContentPackMigration {
    packId: string;
    fromVersion: string;
    toVersion: string;
    migrate(data: Record<string, JsonValue>): Record<string, JsonValue>;
}
export declare class ContentPackRegistry {
    #private;
    register(pack: ContentPack): this;
    registerMigration(migration: ContentPackMigration): this;
    has(id: string): boolean;
    require(id: string, version?: string): ContentPack;
    validateReferences(refs: VersionedRef[]): void;
    list(): ContentPack[];
}
