import type { CommandResult, WorldCommand, WorldProvider } from '../worldbridge/contract.js';
import type { ProviderCommandReceipt, ProviderMutationJournal, SandboxGameState } from './types.js';
import { assertProviderAligned, ProviderMutationUncertainError } from './worldMutationSafety.js';

const MAX_DETAILED_ORDINAL_RECEIPTS = 256;

function emptyJournal(): ProviderMutationJournal {
  return {
    nextCommandOrdinal: 1,
    providerCommitGeneration: 0,
    retiredThroughOrdinal: 0,
    retiredReceiptCount: 0,
    retiredAcceptedCount: 0,
    retiredRejectedCount: 0,
    retiredEventCount: 0,
    retiredCausalRecordCount: 0,
    commandReceipts: [],
  };
}

function commandOrdinalForSave(saveId: string, commandId: string): number | null {
  const prefix = `game:${saveId}:`;
  if (!commandId.startsWith(prefix)) return null;
  const suffix = commandId.slice(commandId.lastIndexOf(':') + 1);
  if (!/^[0-9a-z]+$/i.test(suffix)) return null;
  const ordinal = Number.parseInt(suffix, 36);
  return Number.isSafeInteger(ordinal) && ordinal >= 1 ? ordinal : null;
}

function inferLegacyRetirementWatermark(state: SandboxGameState, journal: ProviderMutationJournal): number {
  if (journal.retiredThroughOrdinal > 0 || journal.nextCommandOrdinal <= 1) return journal.retiredThroughOrdinal;
  const ordinals = journal.commandReceipts
    .map((entry) => commandOrdinalForSave(state.saveId, entry.commandId))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (ordinals.length === 0) return journal.nextCommandOrdinal - 1;
  return Math.max(0, ordinals[0]! - 1);
}

export function ensureProviderMutationJournal(state: SandboxGameState): ProviderMutationJournal {
  const hadRetirementWatermark = Boolean(state.providerMutations && Number.isFinite(state.providerMutations.retiredThroughOrdinal));
  if (!state.providerMutations) state.providerMutations = emptyJournal();
  const journal = state.providerMutations;
  journal.nextCommandOrdinal = Math.max(1, Math.floor(journal.nextCommandOrdinal || 1));
  journal.providerCommitGeneration = Math.max(0, Math.floor(journal.providerCommitGeneration || 0));
  journal.retiredThroughOrdinal = Math.max(0, Math.floor(journal.retiredThroughOrdinal || 0));
  journal.retiredReceiptCount = Math.max(0, Math.floor(journal.retiredReceiptCount || 0));
  journal.retiredAcceptedCount = Math.max(0, Math.floor(journal.retiredAcceptedCount || 0));
  journal.retiredRejectedCount = Math.max(0, Math.floor(journal.retiredRejectedCount || 0));
  journal.retiredEventCount = Math.max(0, Math.floor(journal.retiredEventCount || 0));
  journal.retiredCausalRecordCount = Math.max(0, Math.floor(journal.retiredCausalRecordCount || 0));
  if (!Array.isArray(journal.commandReceipts)) journal.commandReceipts = [];
  if (!hadRetirementWatermark) journal.retiredThroughOrdinal = Math.max(journal.retiredThroughOrdinal, inferLegacyRetirementWatermark(state, journal));
  compactProviderCommandReceipts(state);
  return journal;
}

export function nextProviderCommandId(state: SandboxGameState, scope: string): string {
  const journal = ensureProviderMutationJournal(state);
  const ordinal = journal.nextCommandOrdinal++;
  const safeScope = scope.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'command';
  return `game:${state.saveId}:${safeScope}:${ordinal.toString(36).padStart(5, '0')}`;
}

export function providerCommandReceipt(state: SandboxGameState, commandId: string): ProviderCommandReceipt | null {
  return ensureProviderMutationJournal(state).commandReceipts.find((entry) => entry.commandId === commandId) ?? null;
}

export function isRetiredProviderCommand(state: SandboxGameState, commandId: string): boolean {
  const journal = ensureProviderMutationJournal(state);
  const ordinal = commandOrdinalForSave(state.saveId, commandId);
  return ordinal !== null && ordinal <= journal.retiredThroughOrdinal;
}

function receiptResult(receipt: ProviderCommandReceipt): CommandResult {
  return {
    commandId: receipt.commandId,
    accepted: receipt.accepted,
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    eventIds: [...receipt.eventIds],
    causalRecordIds: [...receipt.causalRecordIds],
  };
}

function retiredReceiptResult(commandId: string): CommandResult {
  return {
    commandId,
    accepted: false,
    reason: 'Terminal provider receipt details were compacted; replay was suppressed.',
    eventIds: [],
    causalRecordIds: [],
  };
}

/**
 * Retain detailed results for the most recent ordinal commands while compacting older terminal
 * receipts into one monotonic retirement watermark plus O(1) diagnostic counters. Non-ordinal
 * legacy receipts are deliberately retained because they cannot be represented by the watermark.
 */
export function compactProviderCommandReceipts(state: SandboxGameState): void {
  const journal = state.providerMutations;
  if (!journal || !Array.isArray(journal.commandReceipts)) return;
  const ordinalIndexes: number[] = [];
  for (let index = 0; index < journal.commandReceipts.length; index += 1) {
    if (commandOrdinalForSave(state.saveId, journal.commandReceipts[index]!.commandId) !== null) ordinalIndexes.push(index);
  }
  const removeCount = Math.max(0, ordinalIndexes.length - MAX_DETAILED_ORDINAL_RECEIPTS);
  if (!removeCount) return;
  const removeIndexes = new Set(ordinalIndexes.slice(0, removeCount));
  const kept: ProviderCommandReceipt[] = [];
  for (let index = 0; index < journal.commandReceipts.length; index += 1) {
    const receipt = journal.commandReceipts[index]!;
    if (!removeIndexes.has(index)) { kept.push(receipt); continue; }
    const ordinal = commandOrdinalForSave(state.saveId, receipt.commandId);
    if (ordinal !== null) journal.retiredThroughOrdinal = Math.max(journal.retiredThroughOrdinal, ordinal);
    journal.retiredReceiptCount += 1;
    if (receipt.accepted) journal.retiredAcceptedCount += 1; else journal.retiredRejectedCount += 1;
    journal.retiredEventCount += receipt.eventIds.length;
    journal.retiredCausalRecordCount += receipt.causalRecordIds.length;
  }
  journal.commandReceipts = kept;
}

/**
 * Issue one provider command exactly once per game command ID.
 *
 * A recent terminal receipt (accepted OR rejected) is authoritative for that ID. Older ordinal
 * receipts may be compacted; their retirement watermark is still authoritative and suppresses
 * replay without growing the save indefinitely. A compacted result intentionally does not
 * reconstruct the old accepted/rejected payload, so callers cannot accidentally re-apply old
 * local consequences.
 */
export async function issueProviderCommandOnce(provider: WorldProvider, state: SandboxGameState, command: WorldCommand): Promise<{ result: CommandResult; replayed: boolean }> {
  const existing = providerCommandReceipt(state, command.id);
  if (existing) return { result: receiptResult(existing), replayed: true };
  if (isRetiredProviderCommand(state, command.id)) return { result: retiredReceiptResult(command.id), replayed: true };

  let result: CommandResult;
  try {
    result = await provider.issueCommand(command);
    const snapshot = await provider.exportSnapshot(2);
    state.world.providerSnapshot = snapshot;
    state.world.manifest = structuredClone(snapshot.manifest);
    await assertProviderAligned(provider, state);
  } catch (error) {
    if (error instanceof ProviderMutationUncertainError) throw error;
    throw new ProviderMutationUncertainError(`Provider command ${command.id} may have begun but no aligned receipt snapshot was committed. ${error instanceof Error ? error.message : String(error)}`, error);
  }

  if (result.commandId !== command.id) throw new ProviderMutationUncertainError(`Provider returned mismatched command receipt ${result.commandId} for ${command.id}.`);
  const journal = ensureProviderMutationJournal(state);
  journal.providerCommitGeneration += 1;
  journal.commandReceipts.push({
    commandId: command.id,
    kind: command.kind,
    issuedTick: command.issuedTick,
    providerTick: state.world.providerSnapshot.manifest.currentTick,
    accepted: result.accepted,
    ...(result.reason ? { reason: result.reason } : {}),
    eventIds: [...result.eventIds],
    causalRecordIds: [...result.causalRecordIds],
  });
  compactProviderCommandReceipts(state);
  const retained = journal.commandReceipts.find((entry) => entry.commandId === command.id);
  return { result: retained ? receiptResult(retained) : receiptResult({
    commandId: command.id, kind: command.kind, issuedTick: command.issuedTick,
    providerTick: state.world.providerSnapshot.manifest.currentTick, accepted: result.accepted,
    ...(result.reason ? { reason: result.reason } : {}), eventIds: [...result.eventIds], causalRecordIds: [...result.causalRecordIds],
  }), replayed: false };
}

export function recordAlignedProviderSnapshotCommit(state: SandboxGameState): void {
  ensureProviderMutationJournal(state).providerCommitGeneration += 1;
}
