import { naturalDeathDay } from './aging.js';
import { addChronicle, addExpeditionChronicle, clamp, findAgent, nextStateId } from './stateUtils.js';
import type { SandboxAgent, SandboxGameState, SandboxStepSummary } from './types.js';

export function recordAgentDeath(state: SandboxGameState, agent: SandboxAgent, cause: string, summary?: SandboxStepSummary): void {
  if (!agent.alive) return;
  agent.alive = false; agent.deathDay = state.clock.day; agent.causeOfDeath = cause;
  agent.currentTask = 'rest'; agent.currentPlan = null;
  if (summary && !summary.deaths.includes(agent.id)) summary.deaths.push(agent.id);
  const event = { kind: 'death' as const, title: cause.startsWith('killed during')?`${agent.name} died during an encounter`:`${agent.name} died`, text: cause, entityIds: [agent.id] };
  if (agent.expeditionId) addExpeditionChronicle(state, agent.expeditionId, event);
  else addChronicle(state, event);
  for (const relation of agent.relations) {
    const survivor = findAgent(state, relation.targetId);
    if (!survivor?.alive || survivor.expeditionId!==agent.expeditionId || (survivor.residence??'settlement')!==(agent.residence??'settlement')) continue;
    survivor.morale = clamp(survivor.morale - Math.max(2, relation.affinity / 18));
    survivor.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'event', text: `${agent.name} died.`, salience: Math.round(relation.affinity), sourceIds: [agent.id] });
    if (survivor.memories.length > 80) survivor.memories.shift();
  }
  // An estate can only pass physically present belongings to a co-located survivor.
  const heir = state.agents.filter((a) => a.alive && a.expeditionId === agent.expeditionId && (a.residence ?? 'settlement') === (agent.residence ?? 'settlement'))
    .sort((a,b) => Number(b.parentIds.includes(agent.id)) - Number(a.parentIds.includes(agent.id)) || Number(b.householdId === agent.householdId) - Number(a.householdId === agent.householdId) || a.id.localeCompare(b.id))[0];
  if (heir) for (const item of [...(state.directPlay?.inventory ?? []), ...(state.directPlay?.equipment ?? [])]) {
    if (item.ownerId !== agent.id) continue;
    item.ownerId = heir.id; if ('equipped' in item) item.equipped = false;
    heir.memories.push({ id: nextStateId(state,'memory'),day:state.clock.day,kind:'event',text:`Inherited ${item.name} from ${agent.name}.`,salience:65,sourceIds:[agent.id,item.id] });
  }
}

export function simulateNaturalMortality(state: SandboxGameState, summary: SandboxStepSummary): void {
  for (const agent of state.agents) if (agent.alive && state.clock.day >= naturalDeathDay(state, agent)) recordAgentDeath(state, agent, 'old age / natural lifespan', summary);
}
