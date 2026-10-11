import type { CommandResult, WorldProvider } from '../worldbridge/contract.js';
import { addChronicle, clamp } from './stateUtils.js';
import type { SandboxGameState } from './types.js';
import { ProviderMutationUncertainError, restoreSandboxState } from './worldMutationSafety.js';
import { issueProviderCommandOnce, nextProviderCommandId } from './providerMutationJournal.js';
import { materializeNegotiatedMigration } from './migrationSimulation.js';
import { materializeProviderObservedConflict } from './externalConflictSimulation.js';
import { consumeResourceLots, recordTradeResourceGain } from './resourceLedger.js';

export type ExternalActionKind = 'trade' | 'migration' | 'diplomacy' | 'conflict';

export const EXTERNAL_ACTION_DURATION_MINUTES: Record<ExternalActionKind, number> = {
  trade: 120,
  diplomacy: 120,
  migration: 180,
  conflict: 60,
};

export function externalActionDurationMinutes(kind: ExternalActionKind): number {
  return EXTERNAL_ACTION_DURATION_MINUTES[kind];
}


export const EXTERNAL_ACTION_COOLDOWN_MINUTES: Record<ExternalActionKind, number> = {
  trade: 360,
  diplomacy: 720,
  migration: 1440,
  conflict: 360,
};

export interface ExternalActionAvailability {
  allowed: boolean;
  remainingMinutes: number;
  reason: string;
}

function absoluteMinute(day: number, minuteOfDay: number): number {
  return (Math.max(1, day) - 1) * 1440 + minuteOfDay;
}

export function externalActionAvailability(state: SandboxGameState, kind: ExternalActionKind, targetEntityId: string): ExternalActionAvailability {
  const now = absoluteMinute(state.clock.day, state.clock.minuteOfDay);
  const prefix = `${kind} instruction `;
  const previous = state.chronicle
    .filter((entry) => entry.kind === 'external' && entry.title.startsWith(prefix) && entry.entityIds.includes(targetEntityId))
    .map((entry) => absoluteMinute(entry.day, entry.minuteOfDay))
    .sort((a, b) => b - a)[0];
  if (previous === undefined) return { allowed: true, remainingMinutes: 0, reason: `${kind} coordination is available.` };
  const remainingMinutes = Math.max(0, EXTERNAL_ACTION_COOLDOWN_MINUTES[kind] - (now - previous));
  return remainingMinutes > 0
    ? { allowed: false, remainingMinutes, reason: `${kind} with this society needs ${remainingMinutes} more canonical minute(s) before another meaningful action.` }
    : { allowed: true, remainingMinutes: 0, reason: `${kind} coordination is available.` };
}

export interface ExternalActionRequest {
  kind: ExternalActionKind;
  targetEntityId: string;
  actorId?: string;
  detail: string;
  epistemicBasisIds?: string[];
  payload?: Record<string, string | number | boolean | null>;
}

export interface ExternalActionResult {
  result: CommandResult;
  unfounded: boolean;
}


const TRADE_UNIT: Record<'food'|'water'|'medicine'|'timber'|'scrap'|'fuel'|'cloth', number> = { food: 8, water: 12, medicine: 0.8, timber: 5, scrap: 4, fuel: 4, cloth: 3 };
const TRADE_TARGET: Record<keyof typeof TRADE_UNIT, number> = { food: 420, water: 620, medicine: 28, timber: 100, scrap: 55, fuel: 70, cloth: 45 };

function executeLocalTrade(state: SandboxGameState, targetEntityId: string, actorId: string): string {
  const relation = state.externalActors.find((entry) => entry.entityId === targetEntityId);
  if (!relation) return 'Trade event entered world history, but no current local projection is available to settle an exchange.';
  const actor = state.agents.find((entry) => entry.id === actorId);
  const keys = Object.keys(TRADE_UNIT) as Array<keyof typeof TRADE_UNIT>;
  const requested = [...keys].sort((a, b) => state.settlement.resources[a] / TRADE_TARGET[a] - state.settlement.resources[b] / TRADE_TARGET[b])[0] ?? 'food';
  const offerCandidates = keys.filter((key) => key !== requested && state.settlement.resources[key] >= TRADE_UNIT[key] * 1.5);
  const offered = offerCandidates.sort((a, b) => state.settlement.resources[b] / TRADE_TARGET[b] - state.settlement.resources[a] / TRADE_TARGET[a])[0];
  if (!offered) return 'Trade contact succeeded, but the settlement had no safe surplus to exchange.';
  const skill = actor?.skills.trade ?? 35;
  const trustFactor = clamp((relation.localTrust + 50) / 100, 0.35, 1.5);
  // TRADE_UNIT entries are one approximate local-value lot. Skill and trust may improve terms,
  // but without a simulated external inventory a 1.8x return becomes a repeatable wealth mint.
  // Keep favorable exchange meaningful yet bounded, and make experience a diminishing advantage.
  const experienceFactor = Math.min(0.06, relation.tradeExperience / 500);
  const gainFactor = clamp(0.78 + skill / 320 + experienceFactor + trustFactor * 0.06, 0.75, 1.15);
  consumeResourceLots(state,{resourceKey:offered,amount:TRADE_UNIT[offered]});
  const gained = TRADE_UNIT[requested] * gainFactor;
  recordTradeResourceGain(state,requested,gained,targetEntityId);
  relation.tradeExperience += 1;
  relation.localTrust = clamp(relation.localTrust + 1 + skill / 80, -100, 100);
  return `Exchanged ${TRADE_UNIT[offered].toFixed(1)} ${offered} for ${gained.toFixed(1)} ${requested}; local trust is now ${relation.localTrust.toFixed(1)}.`;
}

async function applyRelationshipConsequence(provider: WorldProvider, state: SandboxGameState, kind: ExternalActionKind, targetEntityId: string, actorId: string, sourceIds: string[] = []): Promise<string> {
  const relation = state.externalActors.find((entry) => entry.entityId === targetEntityId);
  const actor = state.agents.find((entry) => entry.id === actorId);
  if (!relation) return '';
  if (kind === 'trade') return executeLocalTrade(state, targetEntityId, actorId);
  if (kind === 'diplomacy') {
    const gain = 1.5 + (actor?.skills.leadership ?? 35) / 40 + (actor?.skills.trade ?? 35) / 80;
    relation.localTrust = clamp(relation.localTrust + gain, -100, 100);
    relation.conflictPressure = clamp(relation.conflictPressure - gain * 0.35, 0, 100);
    const observed = await materializeProviderObservedConflict(provider, state, targetEntityId, sourceIds);
    return `Diplomatic trust changed by +${gain.toFixed(1)} to ${relation.localTrust.toFixed(1)}.${observed.length ? ` ${observed.length} provider-observed external consequence${observed.length === 1 ? '' : 's'} entered local history.` : ''}`;
  }
  if (kind === 'migration') {
    const openness = clamp((relation.localTrust + 50) / 100, 0, 1.5);
    const negotiated = Math.max(0, Math.round(openness * (1 + (actor?.skills.leadership ?? 35) / 70)));
    const remainingKnownPopulation = relation.population === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(relation.population - relation.migrationBalance));
    const requested = Math.min(negotiated, remainingKnownPopulation);
    const movement = await materializeNegotiatedMigration(provider, state, targetEntityId, requested, sourceIds);
    relation.migrationBalance += movement.admitted;
    relation.localTrust = clamp(relation.localTrust + movement.admitted * 0.4, -100, 100);
    return `${movement.reason}${movement.admitted ? ` Local population is now ${state.agents.filter((entry) => entry.alive && entry.residence === 'settlement').length}; migration balance ${relation.migrationBalance}.` : ''}`;
  }
  const pressure = 2 + (actor?.skills.leadership ?? 35) / 45;
  relation.conflictPressure = clamp(relation.conflictPressure + pressure, 0, 100);
  relation.localTrust = clamp(relation.localTrust - pressure * 0.8, -100, 100);
  const observed = await materializeProviderObservedConflict(provider, state, targetEntityId, sourceIds);
  return `Conflict pressure rose by ${pressure.toFixed(1)}; local trust is now ${relation.localTrust.toFixed(1)}.${observed.length ? ` ${observed.length} provider-observed physical conflict consequence${observed.length === 1 ? '' : 's'} entered local history.` : ' No provider-observed physical consequence was asserted.'}`;
}
export async function issueExternalAction(provider: WorldProvider, state: SandboxGameState, request: ExternalActionRequest): Promise<ExternalActionResult> {
  const availability = externalActionAvailability(state, request.kind, request.targetEntityId);
  if (!availability.allowed) throw new Error(availability.reason);
  const actorId = request.actorId ?? state.settlement.leaderId;
  const actor = state.agents.find((entry) => entry.id === actorId);
  if (!actor?.alive) throw new Error('External action actor is unavailable.');
  const basis = [...new Set(request.epistemicBasisIds ?? [])];
  const known = new Set(actor.knowledgeIds);
  const targetKnown = state.knowledge.some((entry) => !entry.lost && entry.subjectIds.includes(request.targetEntityId) && (entry.holderIds.includes(actorId) || state.settlement.localKnowledgeIds.includes(entry.id)));
  const unfounded = !targetKnown || basis.some((id) => !known.has(id) && !state.settlement.localKnowledgeIds.includes(id));
  const committed = structuredClone(state);
  let providerTouched = false;
  try {
    providerTouched = true;
    const commandId = nextProviderCommandId(state, `external-${request.kind}`);
    const { result } = await issueProviderCommandOnce(provider, state, {
      id: commandId, issuedTick: state.clock.worldTick, issuerId: actorId, kind: `external.${request.kind}`,
      targets: [request.targetEntityId], location: structuredClone(state.settlement.position),
      payload: { detail: request.detail, unfounded, ...(request.payload ?? {}) }, epistemicBasisIds: basis,
    });
    const consequence = result.accepted ? await applyRelationshipConsequence(provider, state, request.kind, request.targetEntityId, actorId, [...result.eventIds, ...result.causalRecordIds]) : '';
    addChronicle(state, {
      kind: 'external', title: `${request.kind} instruction ${result.accepted ? 'accepted' : 'rejected'}`,
      text: `${request.detail}${unfounded ? ' [根拠不足]' : ''}${result.reason ? ` — ${result.reason}` : ''}${consequence ? ` — ${consequence}` : ''}`,
      entityIds: [actorId, request.targetEntityId, ...result.eventIds],
    });
    return { result, unfounded };
  } catch (error) {
    restoreSandboxState(state, committed);
    if (!providerTouched) throw error;
    if (error instanceof ProviderMutationUncertainError) throw new ProviderMutationUncertainError(`外部への指令送信が確定できませんでした。拠点側の変更は取り消されています。 ${error.message}`, error);
    throw new ProviderMutationUncertainError(`外部への指令送信が確定できませんでした。拠点側の変更は取り消されています。 ${error instanceof Error ? error.message : String(error)}`, error);
  }
}
