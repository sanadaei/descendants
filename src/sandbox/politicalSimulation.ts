import { addChronicle, clamp, findAgent, nextStateId } from './stateUtils.js';
import type { LaborTask, SandboxAgent, SandboxGameState, SettlementPolicyProposal } from './types.js';

function proposals(state: SandboxGameState): SettlementPolicyProposal[] { return state.policyProposals ?? (state.policyProposals = []); }


export interface LaborPriorityProposalAvailability {
  allowed: boolean;
  reason: string;
}

export function laborPriorityProposalAvailability(state: SandboxGameState, task: LaborTask): LaborPriorityProposalAvailability {
  const alreadyConsidered = proposals(state).some((entry) => entry.task === task && entry.day === state.clock.day);
  return alreadyConsidered
    ? { allowed: false, reason: `${task} was already considered by the assembly on Day ${state.clock.day}.` }
    : { allowed: true, reason: `The assembly has not yet considered ${task} on Day ${state.clock.day}.` };
}

export function assemblyPreferenceSignal(voter: SandboxAgent, task: LaborTask, delta: number): number {
  const raw = voter.experience[`assembly:preference:${task}`] ?? 0;
  return clamp(raw, -6, 6) * Math.sign(delta);
}

function relationTrust(voter: SandboxAgent, proposerId: string): number {
  if (voter.id === proposerId) return 100;
  const relation = voter.relations.find((entry) => entry.targetId === proposerId);
  return relation ? (relation.trust * 0.65 + relation.affinity * 0.35) : 35;
}

function stake(agent: SandboxAgent, task: LaborTask): number {
  if (task === 'medicine') return agent.skills.medicine * 0.75 + (100 - agent.health) * 0.25;
  if (task === 'guard') return agent.skills.combat * 0.55 + (agent.personality?.caution ?? 50) * 0.45;
  if (task === 'records') return agent.skills.records * 0.6 + (agent.personality?.curiosity ?? 50) * 0.4;
  if (task === 'care') return agent.skills.care * 0.6 + (agent.personality?.empathy ?? 50) * 0.4;
  if (task === 'repair') return agent.skills.construction * 0.7 + (agent.personality?.caution ?? 50) * 0.3;
  if (task === 'forage') return agent.skills.foraging * 0.65 + agent.skills.survival * 0.35;
  if (task === 'water' || task === 'sanitation') return agent.skills.survival * 0.55 + agent.skills.medicine * 0.2 + (agent.personality?.caution ?? 50) * 0.25;
  if (task === 'explore-prep') return agent.skills.scouting * 0.65 + (agent.personality?.curiosity ?? 50) * 0.35;
  return 50 + (100 - agent.fatigue) * 0.2;
}

export function proposeLaborPriority(state: SandboxGameState, task: LaborTask, delta: number, proposerId = state.settlement.leaderId): SettlementPolicyProposal {
  if (!Number.isFinite(delta) || delta === 0) throw new Error('Policy proposal requires a non-zero priority change.');
  const availability = laborPriorityProposalAvailability(state, task);
  if (!availability.allowed) throw new Error(availability.reason);
  const proposer = findAgent(state, proposerId);
  if (!proposer?.alive || (proposer.residence ?? 'settlement') !== 'settlement') throw new Error('Policy proposer is unavailable to local institutions.');
  const assembly = state.settlement.institutions.find((entry) => entry.kind === 'assembly');
  const voters = (assembly?.memberIds ?? state.agents.map((entry) => entry.id)).map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent?.alive && (agent.residence ?? 'settlement') === 'settlement'));
  if (!voters.length) throw new Error('No local institution can decide the proposal.');
  const supporters: string[] = [];
  const opponents: string[] = [];
  let supportWeight = 0;
  let opposeWeight = 0;
  for (const voter of voters) {
    const localStake = stake(voter, task);
    const trust = relationTrust(voter, proposerId);
    const legitimacy = proposer.authority.legitimacy;
    const autonomy = voter.personality?.autonomy ?? 50;
    const directionStake = delta > 0 ? localStake : 100 - localStake;
    const politicalMemory = assemblyPreferenceSignal(voter, task, delta);
    const score = trust * 0.3 + legitimacy * 0.25 + directionStake * 0.3 + (100 - autonomy) * 0.15 + politicalMemory * 0.5;
    const weight = 0.5 + (voter.socialStatus?.standing ?? 50) / 100 + (voter.authority.offices.length ? 0.25 : 0);
    if (score >= 50) { supporters.push(voter.id); supportWeight += weight; }
    else { opponents.push(voter.id); opposeWeight += weight; }
  }
  const accepted = supportWeight > opposeWeight;
  if (accepted) state.settlement.laborPriorities[task] = clamp(state.settlement.laborPriorities[task] + Math.sign(delta) * Math.min(3, Math.abs(Math.round(delta))), 0, 12);
  const proposal: SettlementPolicyProposal = {
    id: nextStateId(state, 'policy'), proposerId, task, delta: Math.sign(delta) * Math.min(3, Math.abs(Math.round(delta))), day: state.clock.day,
    supporterIds: supporters, opponentIds: opponents, status: accepted ? 'accepted' : 'rejected',
    rationale: `${supporters.length} supported / ${opponents.length} opposed; weighted support ${supportWeight.toFixed(2)} vs ${opposeWeight.toFixed(2)}.`,
  };
  proposals(state).push(proposal);
  if (proposals(state).length > 160) proposals(state).splice(0, proposals(state).length - 160);
  const direction = Math.sign(proposal.delta);
  for (const voter of voters) {
    const supported = supporters.includes(voter.id);
    const preferenceKey = `assembly:preference:${task}`;
    const stance = supported ? direction : -direction;
    voter.experience[preferenceKey] = clamp((voter.experience[preferenceKey] ?? 0) + stance, -6, 6);
    voter.memories.push({
      id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'social',
      text: `Assembly: ${supported ? 'supported' : 'opposed'} ${proposal.delta > 0 ? 'increasing' : 'decreasing'} ${task}; the proposal was ${proposal.status}.`,
      salience: proposal.status === 'accepted' ? 46 : 52, sourceIds: [proposal.id, proposerId],
    });
    if (voter.memories.length > 80) voter.memories.splice(0, voter.memories.length - 80);
  }
  addChronicle(state, { kind: 'settlement', title: `Policy proposal ${proposal.status}: ${task}`, text: `${proposal.rationale} Priority ${accepted ? `is now ${state.settlement.laborPriorities[task]}` : 'was unchanged'}.`, entityIds: [proposal.id, proposerId, ...supporters, ...opponents] });
  return proposal;
}
