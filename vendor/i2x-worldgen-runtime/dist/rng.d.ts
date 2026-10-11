export declare class DeterministicRng {
    #private;
    constructor(seed: number | string);
    nextUint32(): number;
    next(): number;
    float(min?: number, max?: number): number;
    int(min: number, maxInclusive: number): number;
    bool(probability?: number): boolean;
    pick<T>(values: readonly T[]): T;
    fork(label: string): DeterministicRng;
}
export declare class RngStreams {
    readonly rootSeed: number;
    constructor(rootSeed: number);
    stream(...path: Array<string | number>): DeterministicRng;
}
