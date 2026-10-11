import type { GeometryRecipe, SpatialRef } from './contract.js';
export interface GeometryTopologyContext {
    a: SpatialRef;
    b: SpatialRef;
    geometry: GeometryRecipe;
}
export interface GeometryTopology {
    id: string;
    distanceKm(context: GeometryTopologyContext): number;
}
export declare class GeometryTopologyRegistry {
    #private;
    register(topology: GeometryTopology): this;
    unregister(id: string): boolean;
    get(id: string): GeometryTopology | undefined;
    require(id: string): GeometryTopology;
    list(): GeometryTopology[];
}
export declare function createBuiltinGeometryTopologyRegistry(): GeometryTopologyRegistry;
export declare const geometryTopologyRegistry: GeometryTopologyRegistry;
