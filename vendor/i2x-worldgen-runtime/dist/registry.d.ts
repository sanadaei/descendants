import type { GenerationPassRecipe, JsonValue, WorldRecipe, WorldSnapshot } from './contract.js';
import type { RngStreams } from './rng.js';
import type { ContentPackRegistry } from './content.js';
export interface GenerationContext {
    recipe: WorldRecipe;
    state: Map<string, JsonValue>;
    snapshot: WorldSnapshot;
    rng: RngStreams;
    content: ContentPackRegistry;
    pass: GenerationPassRecipe;
    provenance(passId: string, payload?: Record<string, JsonValue>): string;
}
export interface WorldgenModule {
    id: string;
    version: string;
    capabilities?: string[];
    runPass(passId: string, config: Record<string, JsonValue>, context: GenerationContext): Promise<void> | void;
}
export declare class ModuleRegistry {
    #private;
    register(module: WorldgenModule): this;
    require(id: string): WorldgenModule;
    list(): WorldgenModule[];
}
