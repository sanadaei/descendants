import type { JsonValue } from './contract.js';
export declare function stableStringify(value: unknown): string;
export declare function hash32(text: string): number;
export declare function stableId(namespace: string, ...parts: unknown[]): string;
export declare function clamp(value: number, min?: number, max?: number): number;
export declare function deepClone<T>(value: T): T;
export declare function asRecord(value: JsonValue | undefined): Record<string, JsonValue>;
/** Stable FNV-1a over the canonical JSON token stream without materializing the full JSON string. */
export declare function stableHash32(value: unknown): number;
