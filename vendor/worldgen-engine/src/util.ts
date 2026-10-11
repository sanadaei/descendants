import type { JsonValue } from './contract.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stableId(namespace: string, ...parts: unknown[]): string {
  const material = parts.map(stableStringify).join('|');
  return `${namespace}_${hash32(`${namespace}|${material}`).toString(36).padStart(7, '0')}`;
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

/** Stable FNV-1a over the canonical JSON token stream without materializing the full JSON string. */
export function stableHash32(value: unknown): number {
  let h = 0x811c9dc5;
  const write = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object') { write(JSON.stringify(item)); return; }
    if (Array.isArray(item)) {
      write('[');
      for (let i = 0; i < item.length; i += 1) { if (i) write(','); visit(item[i]); }
      write(']');
      return;
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    write('{');
    for (let i = 0; i < keys.length; i += 1) {
      if (i) write(',');
      const key = keys[i]!; write(JSON.stringify(key)); write(':'); visit(record[key]);
    }
    write('}');
  };
  visit(value);
  return h >>> 0;
}
