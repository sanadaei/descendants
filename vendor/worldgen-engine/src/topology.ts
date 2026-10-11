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

export class GeometryTopologyRegistry {
  readonly #topologies = new Map<string, GeometryTopology>();
  register(topology: GeometryTopology): this {
    if (!topology.id) throw new Error('Geometry topology id is required');
    if (this.#topologies.has(topology.id)) throw new Error(`Duplicate geometry topology: ${topology.id}`);
    this.#topologies.set(topology.id, topology);
    return this;
  }
  unregister(id: string): boolean { return this.#topologies.delete(id); }
  get(id: string): GeometryTopology | undefined { return this.#topologies.get(id); }
  require(id: string): GeometryTopology {
    const topology = this.#topologies.get(id);
    if (!topology) throw new Error(`Geometry topology not registered: ${id}`);
    return topology;
  }
  list(): GeometryTopology[] { return [...this.#topologies.values()]; }
}

function scaledAxisDistance(a: number, b: number, extent: number, wrap: boolean, scale: number): number {
  const raw = Math.abs(a - b);
  const wrapped = wrap ? Math.min(raw, Math.max(0, extent - raw)) : raw;
  return wrapped * scale;
}

export function createBuiltinGeometryTopologyRegistry(): GeometryTopologyRegistry {
  return new GeometryTopologyRegistry()
    .register({
      id: 'euclidean',
      distanceKm: ({ a, b, geometry }) => {
        const config = geometry.config ?? {};
        const xScale = typeof config.xDistanceScale === 'number' ? config.xDistanceScale : 1;
        const yScale = typeof config.yDistanceScale === 'number' ? config.yDistanceScale : 1;
        const zScale = typeof config.zDistanceScale === 'number' ? config.zDistanceScale : 1;
        const dx = scaledAxisDistance(a.x, b.x, geometry.extent.widthKm, Boolean(geometry.wrapX), xScale);
        const dy = scaledAxisDistance(a.y, b.y, geometry.extent.heightKm, Boolean(geometry.wrapY), yScale);
        const dz = Math.abs((a.z ?? 0) - (b.z ?? 0)) * zScale;
        return Math.hypot(dx, dy, dz);
      },
    })
    .register({
      id: 'manhattan',
      distanceKm: ({ a, b, geometry }) => {
        const config = geometry.config ?? {};
        const xScale = typeof config.xDistanceScale === 'number' ? config.xDistanceScale : 1;
        const yScale = typeof config.yDistanceScale === 'number' ? config.yDistanceScale : 1;
        const zScale = typeof config.zDistanceScale === 'number' ? config.zDistanceScale : 1;
        const dx = scaledAxisDistance(a.x, b.x, geometry.extent.widthKm, Boolean(geometry.wrapX), xScale);
        const dy = scaledAxisDistance(a.y, b.y, geometry.extent.heightKm, Boolean(geometry.wrapY), yScale);
        const dz = Math.abs((a.z ?? 0) - (b.z ?? 0)) * zScale;
        return dx + dy + dz;
      },
    })
    .register({
      id: 'toroidal-euclidean',
      distanceKm: ({ a, b, geometry }) => {
        const config = geometry.config ?? {};
        const xScale = typeof config.xDistanceScale === 'number' ? config.xDistanceScale : 1;
        const yScale = typeof config.yDistanceScale === 'number' ? config.yDistanceScale : 1;
        const dx = scaledAxisDistance(a.x, b.x, geometry.extent.widthKm, true, xScale);
        const dy = scaledAxisDistance(a.y, b.y, geometry.extent.heightKm, true, yScale);
        return Math.hypot(dx, dy, (a.z ?? 0) - (b.z ?? 0));
      },
    });
}

export const geometryTopologyRegistry = createBuiltinGeometryTopologyRegistry();
