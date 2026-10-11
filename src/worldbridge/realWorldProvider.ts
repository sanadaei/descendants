import type { WorldProvider, WorldSnapshot } from './contract.js';
import type { WorldClockPolicy } from './worldClock.js';

type ContentPack = { id: string; version: string; data: Record<string, unknown> };
type ParsedRecipe = {
  id: string;
  clock: { ticksPerDay: number };
  contentPacks?: Array<{ id: string; version: string }>;
};
type RuntimeModule = {
  ContentPackRegistry: new () => { register(pack: ContentPack): unknown };
  WorldgenEngine: new (registry?: unknown, content?: unknown) => {
    generate(recipe: unknown): Promise<WorldProvider>;
    fromSnapshot(recipe: unknown, snapshot: WorldSnapshot): WorldProvider;
  };
  parseWorldRecipe(input: string): ParsedRecipe;
};

export interface RealWorldProviderOptions {
  snapshot?: WorldSnapshot;
  recipeUrl?: string;
  runtimeUrl?: string;
}

export interface RealWorldRuntime {
  provider: WorldProvider;
  clockPolicy: WorldClockPolicy;
  recipeId: string;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Worldgen asset load failed: ${url} (${response.status})`);
  return response.json();
}

function resolveAssetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export async function createRealWorldRuntime(options: RealWorldProviderOptions = {}): Promise<RealWorldRuntime> {
  const runtimeUrl = options.runtimeUrl ?? resolveAssetUrl('./worldgen/dist/index.js');
  const recipeUrl = options.recipeUrl ?? resolveAssetUrl('./worldgen/setting-packs/descendants/default.recipe.json');
  const runtime = await import(/* @vite-ignore */ runtimeUrl) as RuntimeModule;
  const rawRecipe = await fetchJson(recipeUrl) as ParsedRecipe;
  const recipe = runtime.parseWorldRecipe(JSON.stringify(rawRecipe));
  const content = new runtime.ContentPackRegistry();
  const contentBase = new URL('./content-packs/', recipeUrl).href;
  for (const ref of rawRecipe.contentPacks ?? []) {
    const pack = await fetchJson(new URL(`${encodeURIComponent(ref.id)}.json`, contentBase).href) as ContentPack;
    if (pack.id !== ref.id || pack.version !== ref.version) {
      throw new Error(`Worldgen content-pack mismatch for ${ref.id}: expected ${ref.version}, got ${pack.id}@${pack.version}`);
    }
    content.register(pack);
  }
  const engine = new runtime.WorldgenEngine(undefined, content);
  const provider = options.snapshot ? engine.fromSnapshot(recipe, options.snapshot) : await engine.generate(recipe);
  const manifest = await provider.getManifest();
  if (manifest.recipeId !== rawRecipe.id) throw new Error(`Worldgen manifest recipe mismatch: ${manifest.recipeId} != ${rawRecipe.id}`);
  if (!Number.isSafeInteger(rawRecipe.clock?.ticksPerDay) || rawRecipe.clock.ticksPerDay <= 0) throw new Error('Worldgen recipe has invalid clock.ticksPerDay.');
  return {
    provider,
    recipeId: rawRecipe.id,
    clockPolicy: {
      worldTicksPerDay: rawRecipe.clock.ticksPerDay,
      activeRadiusKm: 25,
      activeDetailRank: 0,
      epochWorldTick: manifest.currentTick,
      epochGameMinute: 0,
    },
  };
}

export async function createRealWorldProvider(options: RealWorldProviderOptions = {}): Promise<WorldProvider> {
  return (await createRealWorldRuntime(options)).provider;
}
