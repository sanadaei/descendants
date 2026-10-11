import { clamp, hash32 } from './util.js';
function unitHash(seed, x, y, salt) {
    return hash32(`${seed}|${salt}|${x}|${y}`) / 0xffffffff;
}
function fade(t) { return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }
function valueNoise(seed, x, y, frequency, salt) {
    const fx = x * frequency;
    const fy = y * frequency;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fade(fx - x0);
    const ty = fade(fy - y0);
    const a = lerp(unitHash(seed, x0, y0, salt), unitHash(seed, x0 + 1, y0, salt), tx);
    const b = lerp(unitHash(seed, x0, y0 + 1, salt), unitHash(seed, x0 + 1, y0 + 1, salt), tx);
    return lerp(a, b, ty);
}
export function fractalNoise(seed, x, y, salt, octaves = 4) {
    let sum = 0;
    let amplitude = 1;
    let total = 0;
    let frequency = 1 / 12;
    for (let octave = 0; octave < Math.max(1, octaves); octave += 1) {
        sum += valueNoise(seed, x, y, frequency, `${salt}:${octave}`) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
    }
    return total > 0 ? sum / total : 0.5;
}
function axisDistance(a, b, size, wrap) {
    const raw = Math.abs(a - b);
    return wrap ? Math.min(raw, size - raw) : raw;
}
function neighbors(index, width, height, wrapX, wrapY) {
    const x = index % width;
    const y = Math.floor(index / width);
    const result = [];
    for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0)
                continue;
            let nx = x + dx;
            let ny = y + dy;
            if (wrapX)
                nx = (nx + width) % width;
            if (wrapY)
                ny = (ny + height) % height;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height)
                continue;
            result.push(ny * width + nx);
        }
    return result;
}
class MinHeap {
    a = [];
    push(item) { this.a.push(item); let i = this.a.length - 1; while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.a[p][0] <= item[0])
            break;
        this.a[i] = this.a[p];
        i = p;
    } this.a[i] = item; }
    pop() { if (!this.a.length)
        return undefined; const root = this.a[0]; const last = this.a.pop(); if (this.a.length) {
        let i = 0;
        while (true) {
            let c = i * 2 + 1;
            if (c >= this.a.length)
                break;
            if (c + 1 < this.a.length && this.a[c + 1][0] < this.a[c][0])
                c += 1;
            if (this.a[c][0] >= last[0])
                break;
            this.a[i] = this.a[c];
            i = c;
        }
        this.a[i] = last;
    } return root; }
    get length() { return this.a.length; }
}
export class TerrainStrategyRegistry {
    #strategies = new Map();
    register(strategy) {
        if (!strategy.id)
            throw new Error('Terrain strategy id is required');
        if (this.#strategies.has(strategy.id))
            throw new Error(`Duplicate terrain strategy: ${strategy.id}`);
        this.#strategies.set(strategy.id, strategy);
        return this;
    }
    require(id) {
        const strategy = this.#strategies.get(id);
        if (!strategy)
            throw new Error(`Terrain strategy not registered: ${id}`);
        return strategy;
    }
    list() { return [...this.#strategies.values()]; }
}
export function createBuiltinTerrainStrategyRegistry() {
    return new TerrainStrategyRegistry()
        .register({ id: 'radial-noise', evaluate: ({ baseField, noise }) => baseField + (noise('landmass', 5) - 0.5) * 0.7 })
        .register({ id: 'ridge-noise', evaluate: ({ baseField, noise }) => baseField + (noise('landmass', 5) - 0.5) * 0.5 + (1 - Math.abs(noise('ridge', 5) * 2 - 1)) * 0.18 })
        .register({ id: 'archipelago', evaluate: ({ baseField, noise }) => baseField - Math.abs(noise('archipelago-cut', 5) - 0.5) * 0.7 + (noise('landmass', 5) - 0.5) * 0.7 });
}
export const terrainStrategyRegistry = createBuiltinTerrainStrategyRegistry();
/** Deterministic, setting-agnostic physical substrate. Values are normalized fields rather than named Earth biomes. */
export function buildTerrainGrid(options) {
    const { seed, width, height, widthKm, heightKm, continentSeeds, wrapX, wrapY } = options;
    const length = width * height;
    const make = (v = 0) => new Array(length).fill(v);
    const land = make();
    const continent = make(-1);
    const elevation = make();
    const roughness = make();
    const temperature = make();
    const moisture = make();
    const rainfall = make();
    const coast = make();
    const flowAccumulation = make();
    const flowTo = make(-1);
    const basin = make(-1);
    const river = make();
    const lake = make();
    const floodplain = make();
    const plate = make(-1);
    const crustAge = make();
    const rockHardness = make();
    const mineralPotential = make();
    const erosion = make();
    const sediment = make();
    const windX = make();
    const windY = make();
    const oceanCurrentX = make();
    const oceanCurrentY = make();
    const strategyId = options.terrainStrategy ?? 'radial-noise';
    const strategy = (options.terrainStrategies ?? terrainStrategyRegistry).require(strategyId);
    const plateCount = Math.max(1, Math.round(options.plateCount ?? Math.max(4, continentSeeds.length * 3)));
    const plateSeeds = Array.from({ length: plateCount }, (_, p) => ({
        x: unitHash(seed, p, 0, 'plate-x') * width, y: unitHash(seed, p, 0, 'plate-y') * height,
        age: unitHash(seed, p, 0, 'plate-age'), hardness: 0.35 + unitHash(seed, p, 0, 'plate-hardness') * 0.6,
    }));
    for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1) {
            const i = y * width + x;
            let best = -Infinity;
            let bestContinent = -1;
            for (let c = 0; c < continentSeeds.length; c += 1) {
                const s = continentSeeds[c];
                const dx = axisDistance(x, s.x, width, wrapX) / Math.max(1, s.radiusX);
                const dy = axisDistance(y, s.y, height, wrapY) / Math.max(1, s.radiusY);
                let field = 1 - Math.sqrt(dx * dx + dy * dy);
                if (field > best) {
                    best = field;
                    bestContinent = c;
                }
            }
            const macro = strategy.evaluate({
                seed, x, y, width, height, baseField: best, seaLevel: options.seaLevel,
                noise: (salt, octaves = 4) => fractalNoise(seed, x, y, salt, octaves),
            });
            const isLand = continentSeeds.length > 0 && macro > options.seaLevel;
            land[i] = isLand ? 1 : 0;
            continent[i] = isLand ? bestContinent : -1;
            let nearestPlate = 0;
            let nearest = Infinity;
            let second = Infinity;
            for (let p = 0; p < plateSeeds.length; p += 1) {
                const ps = plateSeeds[p];
                const dx = axisDistance(x, ps.x, width, wrapX);
                const dy = axisDistance(y, ps.y, height, wrapY);
                const d = dx * dx + dy * dy;
                if (d < nearest) {
                    second = nearest;
                    nearest = d;
                    nearestPlate = p;
                }
                else if (d < second)
                    second = d;
            }
            plate[i] = nearestPlate;
            crustAge[i] = plateSeeds[nearestPlate].age;
            rockHardness[i] = plateSeeds[nearestPlate].hardness;
            const boundary = clamp(1 - Math.abs(Math.sqrt(second) - Math.sqrt(nearest)) / Math.max(2, Math.min(width, height) * 0.18));
            const relief = (fractalNoise(seed, x, y, 'relief', 5) - 0.5) * options.reliefStrength + boundary * options.reliefStrength * 0.28;
            elevation[i] = isLand ? clamp(0.08 + Math.max(0, macro - options.seaLevel) * 0.95 + relief) : clamp(0.08 + macro * 0.08, 0, 0.09);
            mineralPotential[i] = clamp(0.12 + boundary * 0.5 + Math.abs(fractalNoise(seed, x, y, 'mineral', 4) - 0.5) * 0.55 + (1 - crustAge[i]) * 0.18);
        }
    for (let i = 0; i < length; i += 1) {
        const x = i % width;
        const y = Math.floor(i / width);
        const ns = neighbors(i, width, height, wrapX, wrapY);
        coast[i] = land[i] === 1 && ns.some((n) => land[n] === 0) ? 1 : 0;
        const avg = ns.length ? ns.reduce((sum, n) => sum + elevation[n], 0) / ns.length : elevation[i];
        roughness[i] = clamp(Math.abs(elevation[i] - avg) * 5 + Math.abs(fractalNoise(seed, x, y, 'micro-relief', 3) - 0.5) * 0.35);
        const latitude = height <= 1 ? 0.5 : y / (height - 1);
        const equatorial = 1 - Math.abs(latitude * 2 - 1);
        temperature[i] = clamp(0.15 + equatorial * 0.82 - elevation[i] * 0.38 + (fractalNoise(seed, x, y, 'temperature', 3) - 0.5) * 0.16);
        const westToEast = latitude > 0.28 && latitude < 0.72 ? (latitude < 0.5 ? -1 : 1) : (latitude < 0.5 ? 1 : -1);
        windX[i] = westToEast;
        windY[i] = clamp((0.5 - latitude) * 0.7 + (fractalNoise(seed, x, y, 'wind-y', 2) - 0.5) * 0.25, -1, 1);
        const oceanBoost = coast[i] ? 0.18 : 0;
        const baseMoisture = clamp(0.12 + fractalNoise(seed, x, y, 'moisture', 4) * 0.65 + oceanBoost - elevation[i] * 0.08);
        moisture[i] = baseMoisture;
        if (!land[i] && (options.oceanModel ?? 'gyre') === 'gyre') {
            const latBand = latitude * 2 - 1;
            oceanCurrentX[i] = clamp(Math.cos(latBand * Math.PI) * (latBand < 0 ? -0.75 : 0.75), -1, 1);
            oceanCurrentY[i] = clamp(-Math.sin(latBand * Math.PI) * 0.35, -1, 1);
        }
    }
    // Wind/rain-shadow model: trace a few upwind cells and penalize lee-side rainfall behind high relief.
    for (let i = 0; i < length; i += 1) {
        const x = i % width;
        const y = Math.floor(i / width);
        let shadow = 0;
        let cursorX = x;
        let cursorY = y;
        if ((options.climateModel ?? 'wind-rain-shadow') === 'wind-rain-shadow' && land[i]) {
            const sx = windX[i] >= 0 ? -1 : 1;
            const sy = windY[i] >= 0.25 ? -1 : windY[i] <= -0.25 ? 1 : 0;
            for (let k = 1; k <= 5; k += 1) {
                cursorX += sx;
                cursorY += sy;
                if (wrapX)
                    cursorX = (cursorX + width) % width;
                if (wrapY)
                    cursorY = (cursorY + height) % height;
                if (cursorX < 0 || cursorX >= width || cursorY < 0 || cursorY >= height)
                    break;
                const j = cursorY * width + cursorX;
                shadow = Math.max(shadow, elevation[j] - elevation[i] + roughness[j] * 0.12);
            }
        }
        rainfall[i] = clamp(moisture[i] - Math.max(0, shadow) * 0.55 + coast[i] * 0.08);
        moisture[i] = clamp(moisture[i] * 0.45 + rainfall[i] * 0.55);
    }
    // Priority-flood depression filling gives every interior land cell a drainage route without deleting closed basins.
    const filled = [...elevation];
    const visited = new Array(length).fill(false);
    const heap = new MinHeap();
    for (let i = 0; i < length; i += 1) {
        const x = i % width;
        const y = Math.floor(i / width);
        const boundary = !wrapX && (x === 0 || x === width - 1) || !wrapY && (y === 0 || y === height - 1);
        if (!land[i] || coast[i] || boundary) {
            visited[i] = true;
            heap.push([filled[i], i]);
        }
    }
    while (heap.length) {
        const [, i] = heap.pop();
        for (const n of neighbors(i, width, height, wrapX, wrapY))
            if (!visited[n]) {
                visited[n] = true;
                filled[n] = Math.max(filled[n], filled[i] + 1e-7);
                heap.push([filled[n], n]);
            }
    }
    for (let i = 0; i < length; i += 1) {
        if (!land[i])
            continue;
        const ns = neighbors(i, width, height, wrapX, wrapY);
        let target = -1;
        let targetHeight = filled[i];
        for (const n of ns) {
            const h = land[n] ? filled[n] : -1;
            if (h < targetHeight - 1e-10 || (Math.abs(h - targetHeight) <= 1e-10 && n < target)) {
                target = n;
                targetHeight = h;
            }
        }
        flowTo[i] = target;
        flowAccumulation[i] = 1 + rainfall[i] * 2;
    }
    const order = Array.from({ length }, (_, i) => i).filter((i) => land[i] === 1).sort((a, b) => filled[b] - filled[a] || b - a);
    for (const i of order) {
        const target = flowTo[i];
        if (target >= 0 && land[target])
            flowAccumulation[target] = flowAccumulation[target] + flowAccumulation[i];
    }
    const terminalMemo = new Map();
    const terminal = (start) => {
        const known = terminalMemo.get(start);
        if (known !== undefined)
            return known;
        const seen = [];
        let cur = start;
        const guard = new Set();
        while (cur >= 0 && land[cur] && !guard.has(cur)) {
            const memo = terminalMemo.get(cur);
            if (memo !== undefined) {
                cur = memo;
                break;
            }
            guard.add(cur);
            seen.push(cur);
            const next = flowTo[cur];
            if (next < 0 || !land[next]) {
                cur = next < 0 ? cur : next;
                break;
            }
            cur = next;
        }
        const id = cur >= 0 && !land[cur] ? -(cur + 2) : Math.max(0, cur);
        for (const s of seen)
            terminalMemo.set(s, id);
        return id;
    };
    for (let i = 0; i < length; i += 1)
        if (land[i])
            basin[i] = terminal(i);
    const landCells = Math.max(1, land.reduce((a, b) => a + b, 0));
    const threshold = Math.max(4, landCells * options.riverThreshold);
    for (let i = 0; i < length; i += 1) {
        if (!land[i])
            continue;
        if (flowAccumulation[i] >= threshold && elevation[i] > 0.1)
            river[i] = 1;
        if (flowTo[i] === -1 && rainfall[i] > 0.52 && elevation[i] > 0.1)
            lake[i] = 1;
        const ns = neighbors(i, width, height, wrapX, wrapY);
        if (river[i] || (ns.some((n) => river[n]) && roughness[i] < 0.28 && elevation[i] < 0.5))
            floodplain[i] = 1;
        const slope = Math.max(0, elevation[i] - (flowTo[i] >= 0 ? elevation[flowTo[i]] : 0));
        erosion[i] = clamp((roughness[i] * 0.45 + slope * 0.8) * rainfall[i] * (options.erosionStrength ?? 0.7) / Math.max(0.35, rockHardness[i]));
        sediment[i] = clamp(flowAccumulation[i] / Math.max(8, threshold * 3) * (1 - roughness[i] * 0.5) + floodplain[i] * 0.25);
    }
    return { width, height, cellWidthKm: widthKm / width, cellHeightKm: heightKm / height, land, continent, elevation, roughness, temperature, moisture, rainfall, coast, flowAccumulation, flowTo, basin, river, lake, floodplain, plate, crustAge, rockHardness, mineralPotential, erosion, sediment, windX, windY, oceanCurrentX, oceanCurrentY };
}
