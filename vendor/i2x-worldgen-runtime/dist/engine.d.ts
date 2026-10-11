import type { AdvanceRequest, AdvanceResult, AreaProjection, AreaQuery, CommandResult, KnowledgeRecord, WorldCommand, WorldEntity, WorldManifest, WorldProvider, WorldRecipe, WorldSnapshot } from './contract.js';
import { ContentPackRegistry } from './content.js';
import { ModuleRegistry } from './registry.js';
export declare const ENGINE_VERSION = "1.5.0";
export declare function createBuiltinRegistry(): ModuleRegistry;
export declare class WorldgenEngine {
    readonly registry: ModuleRegistry;
    readonly content: ContentPackRegistry;
    constructor(registry?: ModuleRegistry, content?: ContentPackRegistry);
    generate(recipe: WorldRecipe): Promise<GeneratedWorld>;
    fromSnapshot(recipe: WorldRecipe, snapshot: WorldSnapshot): GeneratedWorld;
}
export declare class GeneratedWorld implements WorldProvider {
    #private;
    readonly recipe: WorldRecipe;
    readonly snapshot: WorldSnapshot;
    constructor(recipe: WorldRecipe, snapshot: WorldSnapshot);
    getManifest(): Promise<WorldManifest>;
    getEntity(id: string, observerId?: string): Promise<WorldEntity | null>;
    queryArea(query: AreaQuery): Promise<AreaProjection>;
    getKnowledge(holderId: string, subjectId?: string): Promise<KnowledgeRecord[]>;
    issueCommand(command: WorldCommand): Promise<CommandResult>;
    advance(request: AdvanceRequest): Promise<AdvanceResult>;
    exportAreaSnapshot(query: AreaQuery): Promise<WorldSnapshot>;
    exportSnapshot(detailRank?: number): Promise<WorldSnapshot>;
    collapseMaterializedDetail(): number;
}
export declare function snapshotDigest(snapshot: WorldSnapshot): string;
