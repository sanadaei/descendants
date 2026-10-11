export function normalizeSeed(seed: number): number {
  const value = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 1;
  return value || 0x9e3779b9;
}

export function nextRandomState(state: { rngState: number }): number {
  let x = normalizeSeed(state.rngState);
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState = x >>> 0;
  return (state.rngState >>> 0) / 0x100000000;
}

export function randomInt(state: { rngState: number }, min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return lo + Math.floor(nextRandomState(state) * Math.max(1, hi - lo + 1));
}

export function chance(state: { rngState: number }, probability: number): boolean {
  return nextRandomState(state) < Math.max(0, Math.min(1, probability));
}

/**
 * Deterministic random draw for an event whose outcome should not depend on how many
 * unrelated simulation systems happened to consume the shared RNG beforehand.
 * The draw is still seed-bound and reproducible, but scoped to a durable event key.
 */
export function scopedRandom(seed: number, scope: string): number {
  let hash = (2166136261 ^ normalizeSeed(seed)) >>> 0;
  for (let index = 0; index < scope.length; index += 1) {
    hash ^= scope.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const scratch = { rngState: hash || 0x9e3779b9 };
  return nextRandomState(scratch);
}

export function choose<T>(state: { rngState: number }, values: readonly T[]): T {
  if (!values.length) throw new Error('Cannot choose from an empty collection.');
  return values[Math.min(values.length - 1, Math.floor(nextRandomState(state) * values.length))]!;
}

export function shuffle<T>(state: { rngState: number }, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomInt(state, 0, index);
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}
