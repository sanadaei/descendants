import { recordAgentDeath } from './lifeCourseSimulation.js';
import { chance, randomInt } from './rng.js';
import { addExpeditionChronicle, clamp, effectiveSkill, findAgent, nextStateId } from './stateUtils.js';
import type { EncounterActorState, EncounterInstruction, EncounterQueueAction, EncounterState, ExpeditionState, SandboxGameState, SandboxStepSummary } from './types.js';

function actorInitiative(actor: EncounterActorState): number {
  return actor.actionState * 0.38 + actor.agility * 0.32 + actor.judgment * 0.22 + actor.morale * 0.08;
}

function actionForActor(state: SandboxGameState, encounter: EncounterState, actor: EncounterActorState): EncounterQueueAction {
  const allies = encounter.actors.filter((candidate) => candidate.side === actor.side && candidate.health > 0);
  const enemies = encounter.actors.filter((candidate) => candidate.side !== actor.side && candidate.health > 0);
  const woundedAlly = allies.filter((candidate) => candidate.health < 45).sort((a, b) => a.health - b.health)[0];
  const nearestEnemy = [...enemies].sort((a, b) => Math.hypot(a.x - actor.x, a.y - actor.y) - Math.hypot(b.x - actor.x, b.y - actor.y))[0];
  const instruction = actor.side === 'expedition' ? encounter.instruction : 'advance';
  if (instruction === 'break-contact' || instruction === 'withdraw' || instruction === 'avoid') {
    return { id: nextStateId(state, 'queue'), actorId: actor.agentId, order: 0, action: 'withdraw', reason: `instruction=${instruction}` };
  }
  if (instruction === 'protect-wounded' && woundedAlly && woundedAlly.agentId !== actor.agentId) {
    return { id: nextStateId(state, 'queue'), actorId: actor.agentId, order: 0, action: 'aid', targetId: woundedAlly.agentId, reason: 'protect wounded doctrine' };
  }
  if (!nearestEnemy) return { id: nextStateId(state, 'queue'), actorId: actor.agentId, order: 0, action: 'observe', reason: 'no viable opponent' };
  const distance = Math.hypot(nearestEnemy.x - actor.x, nearestEnemy.y - actor.y);
  if (distance > 1.6) return { id: nextStateId(state, 'queue'), actorId: actor.agentId, order: 0, action: 'move', targetX: nearestEnemy.x, targetY: nearestEnemy.y, reason: 'close distance under automatic action selection' };
  return { id: nextStateId(state, 'queue'), actorId: actor.agentId, order: 0, action: 'attack', targetId: nearestEnemy.agentId, reason: `target at ${distance.toFixed(1)} cells` };
}

export function buildEncounterQueue(state: SandboxGameState, encounter: EncounterState): EncounterQueueAction[] {
  const living = encounter.actors.filter((actor) => actor.health > 0);
  const sorted = [...living].sort((a, b) => actorInitiative(b) - actorInitiative(a) || a.agentId.localeCompare(b.agentId));
  return sorted.map((actor, index) => ({ ...actionForActor(state, encounter, actor), order: index + 1 }));
}

export function createEncounter(
  state: SandboxGameState,
  expedition: ExpeditionState,
  instruction: EncounterInstruction,
  hostileCount = 2,
): EncounterState {
  const memberActors: EncounterActorState[] = expedition.memberIds.map((agentId, index) => {
    const agent = findAgent(state, agentId);
    return {
      agentId, side: 'expedition', x: 1, y: 1 + index, health: agent?.health ?? 50,
      actionState: agent ? clamp(100 - agent.fatigue) : 50,
      agility: agent ? Math.round((effectiveSkill(state,agent,'scouting') + effectiveSkill(state,agent,'combat')) / 2) : 50,
      judgment: agent ? Math.round((effectiveSkill(state,agent,'leadership') + effectiveSkill(state,agent,'survival')) / 2) : 50,
      morale: agent?.morale ?? 50,
    };
  });
  const hostileActors: EncounterActorState[] = Array.from({ length: Math.max(1, hostileCount) }, (_, index) => ({
    agentId: `encounter:${state.sequence + 1}:other:${index + 1}`, side: 'other' as const, x: 6, y: 1 + index * 2, health: randomInt(state, 48, 90),
    actionState: randomInt(state, 45, 88), agility: randomInt(state, 38, 82), judgment: randomInt(state, 30, 76), morale: randomInt(state, 40, 85),
  }));
  const encounter: EncounterState = {
    id: nextStateId(state, 'encounter'), expeditionId: expedition.id, day: state.clock.day, instruction, status: 'queued', width: 8, height: Math.max(6, memberActors.length + hostileActors.length + 1),
    actors: [...memberActors, ...hostileActors], queue: [], log: [], casualties: [],
  };
  encounter.queue = buildEncounterQueue(state, encounter);
  state.encounters.push(encounter);
  return encounter;
}

function moveToward(actor: EncounterActorState, x: number, y: number): void {
  const dx = x - actor.x; const dy = y - actor.y; const mag = Math.max(1, Math.hypot(dx, dy));
  actor.x = clamp(actor.x + dx / mag, 0, 7); actor.y = clamp(actor.y + dy / mag, 0, 20);
}

function applyAction(state: SandboxGameState, encounter: EncounterState, action: EncounterQueueAction): void {
  const actor = encounter.actors.find((candidate) => candidate.agentId === action.actorId); if (!actor || actor.health <= 0) return;
  if (action.action === 'move' && action.targetX !== undefined && action.targetY !== undefined) { moveToward(actor, action.targetX, action.targetY); encounter.log.push(`${actor.agentId} moved.`); return; }
  if (action.action === 'withdraw') { actor.x = Math.max(0, actor.x - (actor.side === 'expedition' ? 1.5 : -1.5)); actor.morale = clamp(actor.morale - 2); encounter.log.push(`${actor.agentId} withdrew.`); return; }
  if (action.action === 'aid' && action.targetId) { const target = encounter.actors.find((candidate) => candidate.agentId === action.targetId); if (target) target.health = clamp(target.health + 4, 0, 100); encounter.log.push(`${actor.agentId} aided ${action.targetId}.`); return; }
  if (action.action === 'attack' && action.targetId) {
    const target = encounter.actors.find((candidate) => candidate.agentId === action.targetId); if (!target || target.health <= 0) return;
    const hit = clamp(0.28 + actor.agility / 250 + actor.judgment / 400 - target.agility / 550, 0.12, 0.86);
    if (chance(state, hit)) { const damage = randomInt(state, 8, 20) + Math.floor(actor.actionState / 18); target.health = clamp(target.health - damage); encounter.log.push(`${actor.agentId} hit ${target.agentId} for ${damage}.`); }
    else encounter.log.push(`${actor.agentId} failed to hit ${target.agentId}.`);
  }
}

function sidesRemaining(encounter: EncounterState): Set<string> {
  return new Set(encounter.actors.filter((actor) => actor.health > 0 && actor.x >= 0.5 && actor.x <= encounter.width - 0.5).map((actor) => actor.side));
}

function recordEncounterTrauma(state: SandboxGameState, encounter: EncounterState, agentId: string, preEncounterHealth: number, postEncounterHealth: number): void {
  const agent = findAgent(state, agentId);
  if (!agent?.alive) return;
  const damage = Math.max(0, preEncounterHealth - postEncounterHealth);
  if (damage < 5) return;
  const woundSeverity = clamp(damage * 1.05 + (postEncounterHealth < 30 ? 10 : postEncounterHealth < 55 ? 5 : 0), 4, 96);
  const existing = agent.pathology.find((entry) => entry.pathologyId === 'traumatic-wound' && entry.status === 'active');
  const symptom = postEncounterHealth < 20 ? 'critical combat trauma' : postEncounterHealth < 45 ? 'deep wound / mobility impairment' : damage >= 20 ? 'open wound / heavy bruising' : 'minor laceration / bruising';
  if (existing) {
    existing.severity = clamp(existing.severity + woundSeverity * 0.55, 0, 100);
    if (!existing.observedSymptoms.includes(symptom)) existing.observedSymptoms.push(symptom);
    for (const cause of [encounter.id, encounter.expeditionId]) if (!existing.suspectedCauses.includes(cause)) existing.suspectedCauses.push(cause);
  } else {
    agent.pathology.push({
      id: nextStateId(state, 'case'), pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: woundSeverity,
      contagious: false, observedSymptoms: [symptom], suspectedCauses: [encounter.id, encounter.expeditionId], treatmentsTried: [], status: 'active',
    });
  }
  if (damage >= 20 && !agent.memories.some((memory) => memory.sourceIds.includes(encounter.id) && memory.kind === 'trauma')) {
    agent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'trauma', text: `I was badly wounded during ${encounter.id}.`, salience: Math.round(clamp(55 + damage * 0.45, 55, 96)), sourceIds: [encounter.id, encounter.expeditionId] });
    if (agent.memories.length > 80) agent.memories.splice(0, agent.memories.length - 80);
  }
  addExpeditionChronicle(state, encounter.expeditionId, {
    kind: 'medicine', title: `${agent.name} returned wounded`,
    text: `Encounter trauma reduced observed HP ${preEncounterHealth.toFixed(0)} → ${postEncounterHealth.toFixed(0)}; wound severity ${woundSeverity.toFixed(0)} was recorded for local care.`,
    entityIds: [agent.id, encounter.id, encounter.expeditionId],
  }, { witnessedByAgentIds: state.expeditions.find((candidate) => candidate.id === encounter.expeditionId)?.memberIds ?? [] });
}

export function setEncounterInstruction(state: SandboxGameState, encounterId: string, instruction: EncounterInstruction): EncounterState {
  const encounter = state.encounters.find((candidate) => candidate.id === encounterId);
  if (!encounter) throw new Error(`Encounter not found: ${encounterId}`);
  if (encounter.status === 'resolved') throw new Error('Resolved encounter instructions cannot be changed.');
  encounter.instruction = instruction;
  encounter.queue = buildEncounterQueue(state, encounter);
  encounter.log.push(`Instruction changed to ${instruction}.`);
  return encounter;
}

export function resolveEncounterRound(state: SandboxGameState, encounterId: string, summary?: SandboxStepSummary): EncounterState {
  const encounter = state.encounters.find((candidate) => candidate.id === encounterId);
  if (!encounter) throw new Error(`Encounter not found: ${encounterId}`);
  if (encounter.status === 'resolved') return encounter;
  encounter.status = 'active';
  for (const action of encounter.queue) applyAction(state, encounter, action);
  const activeSides = sidesRemaining(encounter);
  if (activeSides.size <= 1 || encounter.log.length >= 60) {
    encounter.status = 'resolved';
    for (const actor of encounter.actors.filter((candidate) => candidate.side === 'expedition')) {
      const agent = findAgent(state, actor.agentId); if (!agent?.alive) continue;
      const preEncounterHealth = agent.health;
      agent.health = clamp(Math.min(agent.health, actor.health));
      if (actor.health > 0) recordEncounterTrauma(state, encounter, agent.id, preEncounterHealth, agent.health);
      if (actor.health <= 0) {
        agent.health = 0; recordAgentDeath(state,agent,`killed during ${encounter.id}`);
        if (!encounter.casualties.includes(agent.id)) encounter.casualties.push(agent.id);
        if (summary && !summary.deaths.includes(agent.id)) summary.deaths.push(agent.id);
      }
    }
    summary?.encounterUpdates.push(`${encounter.id} resolved; casualties=${encounter.casualties.length}.`);
    return encounter;
  }
  encounter.queue = buildEncounterQueue(state, encounter);
  return encounter;
}
