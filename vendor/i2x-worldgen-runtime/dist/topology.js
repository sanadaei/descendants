export class GeometryTopologyRegistry {
    #topologies = new Map();
    register(topology) {
        if (!topology.id)
            throw new Error('Geometry topology id is required');
        if (this.#topologies.has(topology.id))
            throw new Error(`Duplicate geometry topology: ${topology.id}`);
        this.#topologies.set(topology.id, topology);
        return this;
    }
    unregister(id) { return this.#topologies.delete(id); }
    get(id) { return this.#topologies.get(id); }
    require(id) {
        const topology = this.#topologies.get(id);
        if (!topology)
            throw new Error(`Geometry topology not registered: ${id}`);
        return topology;
    }
    list() { return [...this.#topologies.values()]; }
}
function scaledAxisDistance(a, b, extent, wrap, scale) {
    const raw = Math.abs(a - b);
    const wrapped = wrap ? Math.min(raw, Math.max(0, extent - raw)) : raw;
    return wrapped * scale;
}
export function createBuiltinGeometryTopologyRegistry() {
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
