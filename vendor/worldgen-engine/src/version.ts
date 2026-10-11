export const WORLDGEN_ENGINE_VERSION = '1.5.0';
export const WORLDGEN_SCHEMA_VERSION = '1.0.0';

function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    const delta = a[i]! - b[i]!;
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function satisfiesEngineRequirement(currentVersion: string, requirement: string): boolean {
  const current = parse(currentVersion);
  if (!current) return false;
  const trimmed = requirement.trim();
  const operatorMatch = /^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (!operatorMatch) return false;
  const target = parse(operatorMatch[2]!);
  if (!target) return false;
  const operator = operatorMatch[1] ?? '=';
  const cmp = compare(current, target);
  if (operator === '>=') return cmp >= 0;
  if (operator === '<=') return cmp <= 0;
  if (operator === '>') return cmp > 0;
  if (operator === '<') return cmp < 0;
  if (operator === '=') return cmp === 0;
  if (operator === '^') return current[0] === target[0] && cmp >= 0;
  return current[0] === target[0] && current[1] === target[1] && cmp >= 0;
}
