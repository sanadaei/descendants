import { findAgent } from './stateUtils.js';
import type { KnowledgeEntry, SandboxGameState } from './types.js';

export function atSettlement(state: SandboxGameState, agentId: string): boolean {
  const agent = findAgent(state, agentId);
  return Boolean(agent?.alive && !agent.expeditionId && (!agent.residence || agent.residence === 'settlement'));
}

export function canReadEvidence(state: SandboxGameState, agentId: string, entry: KnowledgeEntry): boolean {
  const agent = findAgent(state, agentId);
  return Boolean(agent?.alive && !entry.lost && (agent.knowledgeIds.includes(entry.id)
    || (atSettlement(state, agentId) && state.settlement.localKnowledgeIds.includes(entry.id))));
}

export function accessibleEvidence(state: SandboxGameState, agentId: string): KnowledgeEntry[] {
  return state.knowledge.filter((entry) => canReadEvidence(state, agentId, entry));
}

export function parseEvidenceClaim(claim: string): Record<string, unknown> | null {
  const text = claim.replace(/^Local research provisionally (?:supports|qualifies) the hypothesis: |^Local research provisionally reviews the available evidence: /, '');
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
