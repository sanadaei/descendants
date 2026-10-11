import { hash32 } from './util.js';

export class DeterministicRng {
  #state: number;
  constructor(seed: number | string) {
    const value = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
    this.#state = value === 0 ? 0x9e3779b9 : value;
  }
  nextUint32(): number {
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x >>> 0;
    return this.#state;
  }
  next(): number { return this.nextUint32() / 0x1_0000_0000; }
  float(min = 0, max = 1): number { return min + (max - min) * this.next(); }
  int(min: number, maxInclusive: number): number {
    if (maxInclusive < min) throw new Error('Invalid integer range');
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  bool(probability = 0.5): boolean { return this.next() < probability; }
  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('Cannot pick from empty array');
    return values[this.int(0, values.length - 1)]!;
  }
  fork(label: string): DeterministicRng {
    return new DeterministicRng(`${this.#state}:${label}`);
  }
}

export class RngStreams {
  constructor(readonly rootSeed: number) {}
  stream(...path: Array<string | number>): DeterministicRng {
    return new DeterministicRng(`${this.rootSeed}:${path.join('/')}`);
  }
}
