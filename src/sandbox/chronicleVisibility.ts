import type { SandboxChronicleEntry, SandboxGameState } from './types.js';

export type ChronicleViewpoint =
  | { kind: 'settlement' }
  | { kind: 'expedition'; expeditionId: string; observerAgentId?: string };

/**
 * Player-facing projection of canonical Chronicle truth.
 *
 * The canonical state may contain events that occurred inside a remote expedition even when
 * the settlement has no epistemic route to them. This selector is the only supported path for
 * rendering Chronicle entries to a viewpoint.
 */
export function projectChronicle(state: SandboxGameState, viewpoint: ChronicleViewpoint): SandboxChronicleEntry[] {
  return state.chronicle.filter((entry) => {
    const epistemic = entry.epistemic;
    // Backward-compatible saves predate explicit Chronicle provenance; those entries were already
    // player-visible and therefore remain visible rather than being retroactively hidden.
    if (!epistemic || epistemic.scope === 'settlement-visible') return true;
    if (viewpoint.kind === 'settlement') return epistemic.settlementVisible;
    if (epistemic.expeditionId !== viewpoint.expeditionId) return epistemic.settlementVisible;
    if (!viewpoint.observerAgentId) return true;
    return epistemic.witnessedByAgentIds.includes(viewpoint.observerAgentId) || epistemic.settlementVisible;
  });
}

export interface RevealChronicleOptions {
  includeNonRoutine?: boolean;
  upToDay?: number;
  upToMinuteOfDay?: number;
}

/**
 * Marks already-recorded expedition truth as settlement-visible once an actual information route
 * exists. Canonical truth is retained; this only changes its visibility/provenance metadata.
 */
export function revealExpeditionChronicleToSettlement(
  state: SandboxGameState,
  expeditionId: string,
  sourceId: string,
  options: RevealChronicleOptions = {},
): number {
  let revealed = 0;
  const upToDay = options.upToDay ?? state.clock.day;
  const upToMinute = options.upToMinuteOfDay ?? state.clock.minuteOfDay;
  for (const entry of state.chronicle) {
    const epistemic = entry.epistemic;
    if (!epistemic || epistemic.scope !== 'expedition-internal' || epistemic.expeditionId !== expeditionId || epistemic.settlementVisible) continue;
    if (!options.includeNonRoutine && !epistemic.reportableToSettlement) continue;
    if (entry.day > upToDay || (entry.day === upToDay && entry.minuteOfDay > upToMinute)) continue;
    epistemic.settlementVisible = true;
    if (!epistemic.revealSourceIds.includes(sourceId)) epistemic.revealSourceIds.push(sourceId);
    revealed += 1;
  }
  return revealed;
}
