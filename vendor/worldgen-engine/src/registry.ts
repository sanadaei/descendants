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

export class ModuleRegistry {
  readonly #modules = new Map<string, WorldgenModule>();
  register(module: WorldgenModule): this {
    if (this.#modules.has(module.id)) throw new Error(`Duplicate module: ${module.id}`);
    this.#modules.set(module.id, module);
    return this;
  }
  require(id: string): WorldgenModule {
    const value = this.#modules.get(id);
    if (!value) throw new Error(`Worldgen module not registered: ${id}`);
    return value;
  }
  list(): WorldgenModule[] { return [...this.#modules.values()]; }
}
