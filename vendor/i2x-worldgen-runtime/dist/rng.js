import { hash32 } from './util.js';
export class DeterministicRng {
    #state;
    constructor(seed) {
        const value = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
        this.#state = value === 0 ? 0x9e3779b9 : value;
    }
    nextUint32() {
        let x = this.#state;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.#state = x >>> 0;
        return this.#state;
    }
    next() { return this.nextUint32() / 0x1_0000_0000; }
    float(min = 0, max = 1) { return min + (max - min) * this.next(); }
    int(min, maxInclusive) {
        if (maxInclusive < min)
            throw new Error('Invalid integer range');
        return min + Math.floor(this.next() * (maxInclusive - min + 1));
    }
    bool(probability = 0.5) { return this.next() < probability; }
    pick(values) {
        if (values.length === 0)
            throw new Error('Cannot pick from empty array');
        return values[this.int(0, values.length - 1)];
    }
    fork(label) {
        return new DeterministicRng(`${this.#state}:${label}`);
    }
}
export class RngStreams {
    rootSeed;
    constructor(rootSeed) {
        this.rootSeed = rootSeed;
    }
    stream(...path) {
        return new DeterministicRng(`${this.rootSeed}:${path.join('/')}`);
    }
}
