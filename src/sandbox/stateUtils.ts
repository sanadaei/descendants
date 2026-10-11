import { ageSkillFactor } from './aging.js';
import type { SandboxAgent, SandboxChronicleEntry, SandboxGameState } from './types.js';

export function nextStateId(state: SandboxGameState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}:${state.sequence.toString(36).padStart(4, '0')}`;
}

export function agentAgeDays(state: SandboxGameState, agent: SandboxAgent): number {
  return Math.max(0, state.clock.day - agent.bornDay);
}

export function agentAgeYears(state: SandboxGameState, agent: SandboxAgent): number {
  return Math.floor(agentAgeDays(state, agent) / 365);
}

export function livingAgents(state: SandboxGameState): SandboxAgent[] {
  return state.agents.filter((agent) => agent.alive);
}

export function settlementAgents(state: SandboxGameState): SandboxAgent[] {
  return livingAgents(state).filter((agent) => agent.residence ? agent.residence === 'settlement' : agent.expeditionId === null);
}

export function awayAgents(state: SandboxGameState): SandboxAgent[] {
  return livingAgents(state).filter((agent) => agent.residence === 'external' || agent.residence === 'unknown' || agent.expeditionId !== null);
}

export function findAgent(state: SandboxGameState, id: string): SandboxAgent | null {
  return state.agents.find((agent) => agent.id === id) ?? null;
}

export function addChronicle(state: SandboxGameState, entry: Omit<SandboxChronicleEntry, 'id' | 'day' | 'minuteOfDay'>): SandboxChronicleEntry {
  const record: SandboxChronicleEntry = { id: nextStateId(state, 'chronicle'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, ...entry };
  state.chronicle.push(record);
  if (state.chronicle.length > 500) state.chronicle.splice(0, state.chronicle.length - 500);
  return record;
}

export function addExpeditionChronicle(
  state: SandboxGameState,
  expeditionId: string,
  entry: Omit<SandboxChronicleEntry, 'id' | 'day' | 'minuteOfDay' | 'epistemic'>,
  options: { witnessedByAgentIds?: string[]; reportableToSettlement?: boolean } = {},
): SandboxChronicleEntry {
  const expedition = state.expeditions.find((candidate) => candidate.id === expeditionId);
  const witnessedByAgentIds = options.witnessedByAgentIds ?? expedition?.memberIds ?? [];
  const reportableToSettlement = options.reportableToSettlement ?? true;
  const liveVerifiedRoute = reportableToSettlement && expedition?.communication === 'connected';
  return addChronicle(state, {
    ...entry,
    epistemic: {
      scope: 'expedition-internal',
      expeditionId,
      witnessedByAgentIds: [...new Set(witnessedByAgentIds)],
      reportableToSettlement,
      settlementVisible: liveVerifiedRoute,
      revealSourceIds: liveVerifiedRoute ? [`live-communication:${expeditionId}`] : [],
    },
  });
}

export function clamp(value: number, min = 0, max = 100): number { return Math.max(min, Math.min(max, value)); }

export function skillContribution(agent: SandboxAgent, skill: keyof SandboxAgent['skills']): number {
  const healthFactor = clamp(agent.health / 100, 0.15, 1);
  const fatigueFactor = clamp(1 - agent.fatigue / 130, 0.2, 1);
  const moraleFactor = clamp(0.55 + agent.morale / 220, 0.55, 1);
  const equipmentBonus = Number(agent.experience[`equipment:skill:${String(skill)}`] ?? 0);
  return Math.max(0, agent.skills[skill] + equipmentBonus) * healthFactor * fatigueFactor * moraleFactor;
}

export function effectiveSkill(state: SandboxGameState, agent: SandboxAgent, skill: keyof SandboxAgent['skills']): number {
  return skillContribution(agent, skill) * ageSkillFactor(state, agent, skill);
}
