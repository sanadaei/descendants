import type { JsonValue, WorldRecipe } from './contract.js';
export declare function assertWorldRecipe(recipe: WorldRecipe): void;
export declare function parseWorldRecipe(input: string | JsonValue): WorldRecipe;
