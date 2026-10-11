export interface TerrainGrid {
    width: number;
    height: number;
    cellWidthKm: number;
    cellHeightKm: number;
    land: number[];
    continent: number[];
    elevation: number[];
    roughness: number[];
    temperature: number[];
    moisture: number[];
    rainfall: number[];
    coast: number[];
    flowAccumulation: number[];
    flowTo: number[];
    basin: number[];
    river: number[];
    lake: number[];
    floodplain: number[];
    plate: number[];
    crustAge: number[];
    rockHardness: number[];
    mineralPotential: number[];
    erosion: number[];
    sediment: number[];
    windX: number[];
    windY: number[];
    oceanCurrentX: number[];
    oceanCurrentY: number[];
}
export declare function fractalNoise(seed: number, x: number, y: number, salt: string, octaves?: number): number;
export interface TerrainStrategyContext {
    seed: number;
    x: number;
    y: number;
    width: number;
    height: number;
    baseField: number;
    seaLevel: number;
    noise(salt: string, octaves?: number): number;
}
export interface TerrainStrategy {
    id: string;
    evaluate(context: TerrainStrategyContext): number;
}
export declare class TerrainStrategyRegistry {
    #private;
    register(strategy: TerrainStrategy): this;
    require(id: string): TerrainStrategy;
    list(): TerrainStrategy[];
}
export declare function createBuiltinTerrainStrategyRegistry(): TerrainStrategyRegistry;
export declare const terrainStrategyRegistry: TerrainStrategyRegistry;
export interface TerrainGridOptions {
    seed: number;
    width: number;
    height: number;
    widthKm: number;
    heightKm: number;
    continentSeeds: Array<{
        x: number;
        y: number;
        radiusX: number;
        radiusY: number;
    }>;
    wrapX: boolean;
    wrapY: boolean;
    seaLevel: number;
    reliefStrength: number;
    riverThreshold: number;
    terrainStrategy?: string;
    terrainStrategies?: TerrainStrategyRegistry;
    plateCount?: number;
    erosionStrength?: number;
    climateModel?: 'simple' | 'wind-rain-shadow';
    oceanModel?: 'none' | 'gyre';
}
/** Deterministic, setting-agnostic physical substrate. Values are normalized fields rather than named Earth biomes. */
export declare function buildTerrainGrid(options: TerrainGridOptions): TerrainGrid;
