import { researchWorkMultiplier } from './researchApplications.js';
import { legacyProjectMaterialDemand, simulateLegacyProjects } from './legacyProject.js';
import { simulateEducationInterval } from './educationSimulation.js';
import { generatePersonName } from './naming.js';
import { agentAbilityFactors } from './aging.js';
import { recordAgentDeath } from './lifeCourseSimulation.js';
import { adjustResourceStock } from './resourceLedger.js';
import { chance, choose, randomInt, scopedRandom } from './rng.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { finalizeDirectActivities, reserveDirectActivity, reservedHoursByKindDuringCurrentInterval, reservedHoursDuringCurrentInterval } from './directPlay.js';
import { addChronicle, agentAgeYears, clamp, findAgent, livingAgents, nextStateId, settlementAgents, effectiveSkill } from './stateUtils.js';
import type { AgentPlan, AgentSkills, LaborTask, PathologyCase, PregnancyState, SandboxAgent, SandboxGameState, SandboxStepSummary, SkillKey } from './types.js';
import { observedConflictGuardDemand } from './externalConflictSimulation.js';
import { consumeResourceLots, deterministicProductionPreference, distributeDailyConsumable, recordResourceProduction } from './resourceLedger.js';

const TASK_SKILL: Partial<Record<LaborTask, SkillKey>> = {
  forage: 'foraging', water: 'survival', medicine: 'medicine', repair: 'construction', sanitation: 'care', care: 'care', records: 'records', guard: 'combat', 'explore-prep': 'scouting',
};

const TASK_RESOURCE: Partial<Record<LaborTask, keyof SandboxGameState['settlement']['resources']>> = {
  forage: 'food', water: 'water', medicine: 'medicine', records: 'records', 'explore-prep': 'scrap',
};

// Labor output is measured in task-specific units. A generic skill-output number made
// subsistence unrealistically expensive (and medicine unrealistically plentiful), so
// conversion into stockpiles is explicit here rather than hidden in the planner.
const RESOURCE_PRODUCTIVITY: Partial<Record<LaborTask, number>> = {
  forage: 2.4,
  water: 3.2,
  medicine: 0.08,
  records: 0.35,
  'explore-prep': 0.3,
};

function resourceStockingFactor(state: SandboxGameState, task: LaborTask): number {
  // Specialist work does not have to stop just because the storeroom is full: medics can still
  // practice, recorders can maintain archives, and scouts can train/prepare. What must stop is
  // converting every hour of that work into unbounded physical stock. These soft/hard reserve
  // bands keep the role/experience simulation intact while saturating the stockpile output.
  const pop = Math.max(1, settlementAgents(state).length);
  const r = state.settlement.resources;
  const band = task === 'medicine'
    ? { actual: r.medicine, soft: Math.max(28, pop * 0.85), hard: Math.max(44, pop * 1.25) }
    : task === 'records'
      ? { actual: r.records, soft: Math.max(18, pop * 0.55, legacyProjectMaterialDemand(state,'records')), hard: Math.max(36, pop * 1.0, legacyProjectMaterialDemand(state,'records') + 8) }
      : task === 'explore-prep'
        ? { actual: r.scrap, soft: Math.max(24, pop * 0.75, legacyProjectMaterialDemand(state,'scrap')), hard: Math.max(48, pop * 1.5, legacyProjectMaterialDemand(state,'scrap') + 8) }
        : null;
  if (!band || band.actual <= band.soft) return 1;
  if (band.actual >= band.hard) return 0;
  return clamp((band.hard - band.actual) / Math.max(0.001, band.hard - band.soft), 0, 1);
}

function resourceNeed(target: number, actual: number, oversupplyFloor = -8): number {
  // Surplus must reduce demand rather than flattening at zero; otherwise skilled specialists
  // manufacture unlimited stock even while other settlement work is neglected.
  return actual <= target ? target - actual : Math.max(oversupplyFloor, target - actual);
}

function taskNeedPressure(state: SandboxGameState, task: LaborTask): number {
  const pop = Math.max(1, settlementAgents(state).length);
  const r = state.settlement.resources;
  const knownExternalConflict = state.externalActors.reduce((max, actor) => actor.confidence >= 0.45 ? Math.max(max, actor.conflictPressure) : max, 0);
  const housingBuffer = state.settlement.housingCapacity - pop;
  // Repair means capacity-building work in the current model, not free maintenance. Once a
  // settlement has a meaningful housing buffer, builders should stop consuming scarce timber.
  // Likewise, preserve a small emergency timber reserve and let salvage/gathering replenish it.
  const repairBase = housingBuffer < 5 ? 8 : housingBuffer < 8 ? 0 : -10;
  const timberDemand = legacyProjectMaterialDemand(state,'timber');
  const timberStarved = r.timber < Math.max(8,timberDemand);
  const exploreMaterialNeed = Math.max(0, (Math.max(pop * .75,timberDemand) - r.timber) / Math.max(4, pop / 8));
  const targets = {
    forage: resourceNeed(14, r.food / pop),
    water: resourceNeed(16, r.water / pop),
    medicine: resourceNeed(5, r.medicine / Math.max(1, pop / 6), -6),
    repair: timberStarved ? -12 : repairBase,
    sanitation: Math.max(0, (75 - state.settlement.sanitation) / 6),
    care: Math.max(0, livingAgents(state).filter((agent) => agent.health < 65 || agentAgeYears(state, agent) < 13).length / 2),
    records: resourceNeed(Math.max(4,legacyProjectMaterialDemand(state,'records') / 10), state.settlement.resources.records / 10, -6),
    guard: Math.max(0, (55 - state.settlement.defense) / 7) + knownExternalConflict / 24 + observedConflictGuardDemand(state),
    rest: 1,
    'explore-prep': Math.max(-3, 2 + exploreMaterialNeed - Math.max(0, r.scrap - pop) / Math.max(10, pop / 2)),
  } satisfies Record<LaborTask, number>;
  return targets[task] + state.settlement.laborPriorities[task] / 2;
}

function personalPressure(state: SandboxGameState, agent: SandboxAgent, task: LaborTask): number {
  if (task === 'rest') return agent.fatigue / 8 + agent.needs.rest / 10;
  if (agent.health < 42 && task !== 'medicine' && task !== 'care') return -10;
  const skill = TASK_SKILL[task];
  const competence = skill ? agent.skills[skill] / 16 : 2;
  const roleAffinity: Partial<Record<SandboxAgent['role'], LaborTask>> = {
    medic: 'medicine', scout: 'explore-prep', builder: 'repair', forager: 'forage', water: 'water', caregiver: 'care', recorder: 'records', guard: 'guard', generalist: 'sanitation', child: 'rest', leader: 'guard',
  };
  let motive = 0;

  // Explicit motives and fears remain the strongest intentional inputs.
  if (agent.goals.includes('keep-family-alive') && ['forage','water','care'].includes(task)) motive += 1.8;
  if (agent.goals.includes('understand-outside') && task === 'explore-prep') motive += 3;
  if (agent.goals.includes('improve-settlement') && ['repair','sanitation'].includes(task)) motive += 2;
  if (agent.goals.includes('gain-respect') && task === 'guard') motive += 1.5;
  if (agent.goals.includes('protect-records') && task === 'records') motive += 3;
  if (agent.goals.includes('find-medicine') && task === 'medicine') motive += 2.5;
  if (agent.fears.includes('hunger') && task === 'forage') motive += agent.needs.hunger / 45;
  if (agent.fears.includes('illness') && ['medicine','sanitation'].includes(task)) motive += 1.4;
  if (agent.fears.includes('isolation') && task === 'care') motive += agent.needs.belonging / 55;
  if (agent.fears.includes('violence') && task === 'guard') motive += agent.needs.safety / 65;
  if (agent.fears.includes('forgetting-the-past') && task === 'records') motive += 2.2;

  // Body, pathology and inherited constitution alter what work is plausible/desirable.
  const activePathologySeverity = agent.pathology.filter((entry) => entry.status === 'active' || entry.status === 'chronic').reduce((sum, entry) => sum + entry.severity, 0);
  if (activePathologySeverity > 0) {
    if (task === 'medicine' || task === 'care') motive += Math.min(3, activePathologySeverity / 24);
    if (task === 'guard' || task === 'forage' || task === 'explore-prep') motive -= Math.min(4, activePathologySeverity / 18);
  }
  const resilience = agent.genetics.loci.resilience ?? 50;
  const metabolism = agent.genetics.loci.metabolism ?? 50;
  if (['guard','forage','explore-prep'].includes(task)) motive += (resilience - 50) / 65;
  if (task === 'forage' && agent.needs.hunger > 35) motive += (metabolism - 50) / 90;
  if (agent.genetics.anomalyTraits.length > 0 && ['medicine','records','explore-prep'].includes(task)) motive += Math.min(1.8, agent.genetics.anomalyTraits.length * 0.35);

  if (agent.personality) {
    if (task === 'explore-prep') motive += (agent.personality.curiosity - agent.personality.caution * 0.35) / 35;
    if (task === 'guard') motive += agent.personality.caution / 55;
    if (task === 'care') motive += agent.personality.empathy / 45;
  }
  if (agent.faith?.interpretationTags.includes('record-keeping') && task === 'records') motive += agent.faith.commitment / 65;
  if (agent.faith?.interpretationTags.includes('mutual-care') && task === 'care') motive += agent.faith.commitment / 65;

  // Beliefs and acquired knowledge affect decisions without revealing whether a claim is true.
  const epistemicText = agent.beliefs.filter((belief) => belief.confidence >= 0.35).map((belief) => `${belief.claim} ${belief.subjectIds.join(' ')}`).join(' ').toLowerCase();
  const heldKnowledge = state.knowledge.filter((entry) => agent.knowledgeIds.includes(entry.id) && !entry.lost);
  const knowledgeText = heldKnowledge.map((entry) => `${entry.claim} ${entry.subjectIds.join(' ')}`).join(' ').toLowerCase();
  const interpretedText = `${epistemicText} ${knowledgeText}`;
  if (/patholog|illness|disease|treatment|medicine|clinic|symptom/.test(interpretedText)) {
    if (task === 'medicine') motive += 1.4;
    if (task === 'records') motive += 0.5;
  }
  if (/outside|route|signal|terrain|anomal|mutation|transform|discontinu|time shift/.test(interpretedText)) {
    if (task === 'explore-prep') motive += 1.25;
    if (task === 'records') motive += 0.75;
  }

  // Salient memories change caution and priorities; memory remains subjective evidence.
  const salientMemories = agent.memories.filter((memory) => memory.salience >= 45).slice(-8);
  const traumaSalience = salientMemories.filter((memory) => memory.kind === 'trauma').reduce((sum, memory) => sum + memory.salience, 0);
  const knowledgeSalience = salientMemories.filter((memory) => memory.kind === 'knowledge' || memory.kind === 'event').reduce((sum, memory) => sum + memory.salience, 0);
  if (traumaSalience > 0) {
    if (task === 'guard') motive += Math.min(1.5, traumaSalience / 120);
    if (task === 'explore-prep') motive -= Math.min(1.4, traumaSalience / 140);
  }
  if (knowledgeSalience > 0 && task === 'records') motive += Math.min(1.4, knowledgeSalience / 140);

  // Family/relationship state creates actual care obligations rather than decorative links.
  const closeRelationIds = new Set(agent.relations.filter((relation) => relation.kind === 'kin' || relation.kind === 'partner' || relation.obligation >= 60).map((relation) => relation.targetId));
  const vulnerableClosePeople = settlementAgents(state).filter((other) => closeRelationIds.has(other.id) && (other.health < 62 || agentAgeYears(state, other) < 13));
  if (vulnerableClosePeople.length > 0) {
    // Care obligation scales with how vulnerable close people are, not just with a
    // binary vulnerable/not-vulnerable count. This matters for children as well:
    // a healthy child creates a baseline care obligation, while an injured child
    // should create additional urgency instead of being indistinguishable from
    // the same child at full health.
    const familyVulnerability = vulnerableClosePeople.reduce((sum, other) => {
      const childWeight = agentAgeYears(state, other) < 13 ? 0.5 : 0;
      const healthWeight = Math.max(0, 62 - other.health) / 20;
      return sum + childWeight + healthWeight;
    }, 0);
    if (task === 'care') motive += Math.min(2.4, familyVulnerability * 0.6);
    if (task === 'medicine') motive += Math.min(1.4, familyVulnerability * 0.35);
  }

  // Institutional affiliation and social position create duties, but never hard-lock a person to a job.
  const affiliatedInstitutions = state.settlement.institutions.filter((institution) => agent.affiliationIds?.includes(institution.id));
  for (const institution of affiliatedInstitutions) {
    if (institution.kind === 'clinic' && task === 'medicine') motive += 1.2;
    if (institution.kind === 'records' && task === 'records') motive += 1.2;
    if (institution.kind === 'childcare' && task === 'care') motive += 1.2;
    if ((institution.kind === 'watch' || institution.kind === 'assembly' || institution.kind === 'leadership') && task === 'guard') motive += 0.6;
  }
  const standing = agent.socialStatus?.standing ?? 40;
  const dependency = agent.socialStatus?.dependency ?? 35;
  const outsider = agent.socialStatus?.outsider ?? 20;
  if (task === 'care') motive += dependency / 180;
  if (task === 'records' || task === 'guard') motive += standing / 220;
  if (task === 'explore-prep') motive += outsider / 180;

  // Embodied experience is distinct from formal skill and reinforces learned practice.
  const taskExperience = agent.experience[task] ?? 0;
  motive += Math.min(2.5, taskExperience / 72);

  return competence + motive + (roleAffinity[agent.role] === task ? 4 : 0) - agent.fatigue / 28;
}

export function agentTaskScore(state: SandboxGameState, agent: SandboxAgent, task: LaborTask): number {
  return taskNeedPressure(state, task) + personalPressure(state, agent, task);
}

function planAgent(state: SandboxGameState, agent: SandboxAgent): AgentPlan {
  if (agent.health < 55) return { id: nextStateId(state, 'plan'), kind: 'seek-care', priority: 100, reason: 'health below safe working threshold' };
  const leader = findAgent(state, state.settlement.leaderId);
  const candidateTasks: LaborTask[] = ['forage','water','medicine','repair','sanitation','care','records','guard','rest','explore-prep'];
  const ranked = candidateTasks.map((task) => ({ task, score: agentTaskScore(state, agent, task) + randomInt(state, -2, 2) })).sort((a, b) => b.score - a.score);
  const selected = ranked[0]?.task ?? 'rest';
  const obedience = agent.authority.obedience + (leader ? agent.relations.find((relation) => relation.targetId === leader.id)?.trust ?? 0 : 0) * 0.15 - (agent.personality?.autonomy ?? 50) * 0.08;
  if (selected !== 'rest' && agent.fatigue > agent.authority.refusalThreshold && obedience < 58) {
    return { id: nextStateId(state, 'plan'), kind: 'refuse-order', priority: 85, reason: 'fatigue and weak social obligation outweigh assigned labor' };
  }
  return { id: nextStateId(state, 'plan'), kind: selected, priority: Math.round(ranked[0]?.score ?? 0), reason: `need=${taskNeedPressure(state, selected).toFixed(1)} role/skill=${personalPressure(state, agent, selected).toFixed(1)}` };
}

function workOutput(state: SandboxGameState, agent: SandboxAgent, task: LaborTask): number {
  const skill = TASK_SKILL[task];
  const base = skill ? effectiveSkill(state, agent, skill) : 35;
  const jitter = randomInt(state, 75, 125) / 100;
  return Math.max(0, base * jitter / 18);
}

function executeTask(state: SandboxGameState, agent: SandboxAgent, task: LaborTask, hours: number): void {
  const factor = hours / 6;
  if (task === 'rest') {
    agent.fatigue = clamp(agent.fatigue - 24 * factor * agentAbilityFactors(state,agent).recovery);
    agent.needs.rest = clamp(agent.needs.rest - 18 * factor);
    agent.morale = clamp(agent.morale + 2 * factor);
    return;
  }
  const output = workOutput(state, agent, task) * factor * researchWorkMultiplier(state,task,true);
  const resource = TASK_RESOURCE[task];
  if (resource) {
    const amount = output * (RESOURCE_PRODUCTIVITY[task] ?? 1) * resourceStockingFactor(state, task);
    if (amount > 0) {
      try {
        recordResourceProduction(state, { resourceKey: resource, amount, harvesterIds: [agent.id], sourcePreference: deterministicProductionPreference(agent.id, resource, state.clock.day), note: `${agent.name} performed ${task} work.` });
      } catch { /* Depleted tracked sources produce no stock while labor/experience still occurs. */ }
    }
  }
  // Local gathering/salvage is the renewable timber route. Repair consumes this stock later;
  // keeping the routes separate prevents repair labor from creating its own input material.
  const timberTarget = Math.max(12, settlementAgents(state).length * 0.75, legacyProjectMaterialDemand(state,'timber'));
  if (state.settlement.resources.timber < timberTarget && task === 'forage') { try { recordResourceProduction(state,{resourceKey:'timber',amount:output*0.16,harvesterIds:[agent.id],sourcePreference:deterministicProductionPreference(agent.id,'timber',state.clock.day),note:`${agent.name} gathered woody material while foraging.`}); } catch {} }
  if (state.settlement.resources.timber < timberTarget && task === 'explore-prep') { try { recordResourceProduction(state,{resourceKey:'timber',amount:output*0.42,harvesterIds:[agent.id],sourcePreference:deterministicProductionPreference(agent.id,'timber',state.clock.day),note:`${agent.name} salvaged construction material during exploration preparation.`}); } catch {} }
  if (task === 'sanitation') state.settlement.sanitation = clamp(state.settlement.sanitation + output * 0.5);
  if (task === 'water') state.settlement.waterSafety = clamp(state.settlement.waterSafety + output * 0.14);
  if (task === 'care') {
    const patient = settlementAgents(state).filter((candidate) => candidate.id !== agent.id && candidate.health < 82).sort((a, b) => a.health - b.health)[0];
    if (patient) patient.health = clamp(patient.health + Math.min(5 * factor, output * 0.7));
    state.settlement.childcareCapacity = clamp(state.settlement.childcareCapacity + output * 0.05, 0, 30);
  }
  if (task === 'guard') state.settlement.defense = clamp(state.settlement.defense + output * 0.05);
  if (task === 'repair' && state.settlement.resources.timber > 2 * factor + legacyProjectMaterialDemand(state,'timber')) {
    consumeResourceLots(state,{resourceKey:'timber',amount:2*factor});
    if (chance(state, Math.min(0.35, output / 50))) state.settlement.housingCapacity += 1;
  }
  agent.fatigue = clamp(agent.fatigue + (task === 'guard' || task === 'forage' ? 11 : 8) * factor / Math.max(.3, agentAbilityFactors(state,agent).physical));
  agent.experience[task] = (agent.experience[task] ?? 0) + hours;
  const practicedSkill=TASK_SKILL[task];
  if (practicedSkill) agent.skills[practicedSkill]=Math.min(100,agent.skills[practicedSkill]+hours*.002*agentAbilityFactors(state,agent).learning);
}

function consume(state: SandboxGameState, hours: number, summary: SandboxStepSummary): void {
  const agents = settlementAgents(state);
  const factor = hours / 24;
  const foodNeeds: Record<string,number> = {};
  const waterNeeds: Record<string,number> = {};
  for (const agent of agents) {
    const child = agentAgeYears(state,agent) < 13;
    foodNeeds[agent.id] = (child ? 1.05 : 1.8) * factor;
    waterNeeds[agent.id] = (child ? 1.65 : 2.5) * factor;
  }
  const food = distributeDailyConsumable(state,'food',foodNeeds,hours);
  const water = distributeDailyConsumable(state,'water',waterNeeds,hours);
  let foodNeedTotal=0, foodAllocated=0, waterNeedTotal=0, waterAllocated=0;
  for (const agent of agents) {
    const foodFraction = food[agent.id]?.fraction ?? 0;
    const waterFraction = water[agent.id]?.fraction ?? 0;
    foodNeedTotal += food[agent.id]?.needed ?? 0; foodAllocated += food[agent.id]?.allocated ?? 0;
    waterNeedTotal += water[agent.id]?.needed ?? 0; waterAllocated += water[agent.id]?.allocated ?? 0;
    agent.needs.hunger = clamp(agent.needs.hunger + (1 - foodFraction) * 28 * factor - foodFraction * 8 * factor);
    agent.needs.thirst = clamp(agent.needs.thirst + (1 - waterFraction) * 42 * factor - waterFraction * 10 * factor);
    if (foodFraction < 0.55) agent.health = clamp(agent.health - (0.55 - foodFraction) * 12 * factor);
    if (waterFraction < 0.55) agent.health = clamp(agent.health - (0.55 - waterFraction) * 18 * factor);
  }
  const foodFraction = foodNeedTotal > 0 ? Math.min(1,foodAllocated/foodNeedTotal) : 1;
  const waterFraction = waterNeedTotal > 0 ? Math.min(1,waterAllocated/waterNeedTotal) : 1;
  if (foodFraction < 0.8) summary.settlementUpdates.push(`Food rationing pressure ${(foodFraction * 100).toFixed(0)}%.`);
  if (waterFraction < 0.8) summary.settlementUpdates.push(`Water rationing pressure ${(waterFraction * 100).toFixed(0)}%.`);
}

function environmentalHealth(state: SandboxGameState, hours: number): void {
  const factor = hours / 24;
  const crowding = Math.max(0, settlementAgents(state).length - state.settlement.housingCapacity);
  const contamination = Math.max(0, (65 - state.settlement.sanitation) / 100 + (65 - state.settlement.waterSafety) / 130 + crowding * 0.012);
  const woundContamination = Math.max(0, (75 - state.settlement.sanitation) / 85 + crowding * 0.015);
  for (const agent of settlementAgents(state)) {
    const wound = agent.pathology.find((entry) => entry.pathologyId === 'traumatic-wound' && entry.status === 'active');
    const woundInfection = agent.pathology.find((entry) => entry.pathologyId === 'wound-infection' && entry.status === 'active');
    if (wound) {
      const resilience = agent.genetics.loci.resilience ?? 50;
      const resting = agent.currentTask === 'rest' || agent.currentPlan?.kind === 'seek-care';
      const infectionPenalty = woundInfection ? 0.35 : 1;
      const healingPerDay = (2.2 + resilience / 28 + (resting ? 2.4 : 0) + Math.max(0, state.settlement.sanitation - 55) / 30) * infectionPenalty;
      wound.severity = clamp(wound.severity - healingPerDay * factor, 0, 100);
      if (wound.severity <= 2) {
        wound.status = 'resolved';
        agent.health = clamp(agent.health + 2);
        addChronicle(state, { kind: 'medicine', title: `${agent.name}'s traumatic wound closed`, text: 'The recorded wound fell below the active-injury threshold after local recovery.', entityIds: [agent.id, wound.id] });
      } else if (!woundInfection && woundContamination > 0) {
        const infectionRisk = woundContamination * (0.018 + wound.severity / 3000) * factor;
        if (chance(state, infectionRisk)) {
          agent.pathology.push({ id: nextStateId(state, 'case'), pathologyId: 'wound-infection', onsetDay: state.clock.day, severity: randomInt(state, 10, 24) + Math.round(wound.severity / 12), contagious: false, observedSymptoms: ['inflamed wound / fever risk'], suspectedCauses: [wound.id], treatmentsTried: [], status: 'active' });
          addChronicle(state, { kind: 'medicine', title: `${agent.name}'s wound became infected`, text: 'Local observation linked the infection to an existing traumatic wound; the exact causal pathway remains uncertain.', entityIds: [agent.id, wound.id] });
        }
      }
    }
    if (contamination > 0 && chance(state, contamination * 0.03 * factor)) {
      const pathologyId = choose(state, ['gastroenteric-fever','respiratory-illness']);
      const existing = agent.pathology.find((entry) => entry.pathologyId === pathologyId && entry.status === 'active');
      if (existing) existing.severity = clamp(existing.severity + randomInt(state, 1, 5));
      else agent.pathology.push({ id: nextStateId(state, 'case'), pathologyId, onsetDay: state.clock.day, severity: randomInt(state, 8, 26), contagious: true, observedSymptoms: [], suspectedCauses: [], treatmentsTried: [], status: 'active' });
    }
    const activeSeverity = agent.pathology.filter((entry) => entry.status === 'active' && entry.pathologyId !== 'traumatic-wound').reduce((sum, entry) => sum + entry.severity, 0);
    if (activeSeverity > 0) agent.health = clamp(agent.health - activeSeverity / 260 * factor * 24);
  }
}

const FOLK_PRACTICES = ['supportive-care','boiled-water-rest','herbal-infusion','saline-wash','warm-compress','isolation-and-rest'] as const;
type FolkPractice = typeof FOLK_PRACTICES[number];

function treatmentSignal(state: SandboxGameState, pathologyId: string, practice: FolkPractice): number {
  const text = `${state.seed}:${pathologyId}:${practice}`;
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
  return (hash % 1601) / 1000 - 0.8;
}

function treatmentSubjects(pathologyId: string, practice: FolkPractice): [string, string] {
  return [`pathology:${pathologyId}`, `treatment:${practice}`];
}

function learnedTreatmentSupport(state: SandboxGameState, pathologyId: string, practice: FolkPractice, participantIds: string[]): number {
  const [pathologySubject, treatmentSubject] = treatmentSubjects(pathologyId, practice);
  const accessible = new Set([...state.settlement.localKnowledgeIds, ...participantIds.flatMap((id) => findAgent(state, id)?.knowledgeIds ?? [])]);
  let improvement = 0, worsening = 0;
  for (const entry of state.knowledge) {
    const observation = entry.treatmentObservation;
    if (entry.lost || !accessible.has(entry.id) || !observation || observation.pathologyId !== pathologyId || observation.practice !== practice
      || !entry.subjectIds.includes(pathologySubject) || !entry.subjectIds.includes(treatmentSubject)) continue;
    const delta = observation.severityBefore - observation.severityAfter;
    if (delta > .35) improvement = Math.max(improvement, entry.confidence);
    else if (delta < -.2) worsening = Math.max(worsening, entry.confidence);
  }
  // Copies of one report do not multiply support; a confident adverse outcome counts against use.
  return improvement - worsening;
}

function treatmentCandidates(pathologyId: string): FolkPractice[] {
  if (pathologyId.includes('wound')) return ['saline-wash','supportive-care','warm-compress','herbal-infusion'];
  if (pathologyId.includes('gastro')) return ['boiled-water-rest','supportive-care','herbal-infusion','isolation-and-rest'];
  if (pathologyId.includes('respiratory')) return ['isolation-and-rest','warm-compress','supportive-care','herbal-infusion'];
  return [...FOLK_PRACTICES];
}

function chooseTreatmentPractice(state: SandboxGameState, pathologyId: string, tried: string[], medic: SandboxAgent | undefined, patient: SandboxAgent): FolkPractice {
  const candidates = treatmentCandidates(pathologyId);
  const participants = [patient.id, ...(medic ? [medic.id] : [])];
  return [...candidates].sort((a, b) => {
    const learnedA = learnedTreatmentSupport(state, pathologyId, a, participants) * 100;
    const learnedB = learnedTreatmentSupport(state, pathologyId, b, participants) * 100;
    const noveltyA = tried.includes(a) ? 0 : 18;
    const noveltyB = tried.includes(b) ? 0 : 18;
    const embodiedA = medic ? (medic.experience[`treatment:${pathologyId}:${a}`] ?? 0) * 0.3 : 0;
    const embodiedB = medic ? (medic.experience[`treatment:${pathologyId}:${b}`] ?? 0) * 0.3 : 0;
    return (learnedB + noveltyB + embodiedB) - (learnedA + noveltyA + embodiedA) || a.localeCompare(b);
  })[0] ?? 'supportive-care';
}

function recordTreatmentInference(state: SandboxGameState, patient: SandboxAgent, medics: SandboxAgent[], pathology: PathologyCase, practice: FolkPractice, severityBefore: number): void {
  const pathologyId = pathology.pathologyId;
  const severityDelta = severityBefore - pathology.severity;
  const subjects = treatmentSubjects(pathologyId, practice);
  const holders = [...new Set([patient.id, ...medics.slice(0, 2).map((entry) => entry.id)])];
  const existing = state.knowledge.find((entry) => !entry.lost && subjects.every((subject) => entry.subjectIds.includes(subject)));
  const outcome = severityDelta > 0.35 ? 'improvement' : severityDelta < -0.2 ? 'worsening' : 'no clear change';
  const claim = `Practice observation: ${practice} was followed by ${outcome} in ${pathologyId}; repeated cases are needed before treating this as causal knowledge.`;
  const evidenceStrength = clamp(0.22 + Math.abs(severityDelta) / 18, 0.22, 0.62);
  const observation = { patientId: patient.id, caseId: pathology.id, pathologyId, practice, severityBefore, severityAfter: pathology.severity };
  if (existing) {
    existing.confidence = Math.min(0.92, existing.confidence * 0.78 + evidenceStrength * 0.22);
    existing.claim = claim;
    existing.treatmentObservation = observation;
    existing.holderIds = [...new Set([...existing.holderIds, ...holders])];
    for (const holderId of holders) {
      const holder = findAgent(state, holderId);
      if (holder && !holder.knowledgeIds.includes(existing.id)) holder.knowledgeIds.push(existing.id);
    }
  } else {
    const knowledge = addObservedKnowledge(state, holders, subjects, claim, evidenceStrength);
    knowledge.carrier = 'oral';
    knowledge.treatmentObservation = observation;
  }
}

interface ClinicTreatmentResult { practice: FolkPractice; medicineUsed: number; severityBefore: number; severityAfter: number; resolved: boolean; medicId?: string }

function applyClinicTreatment(state: SandboxGameState, patient: SandboxAgent, entry: PathologyCase, medic: SandboxAgent | undefined, hours: number): ClinicTreatmentResult {
  const medics = medic ? [medic] : [];
  const efficacy = (medic ? effectiveSkill(state,medic,'medicine') : 36) / 100 * researchWorkMultiplier(state,'medicine',true);
  const medicineUsed = state.settlement.resources.medicine >= 0.25 ? 0.25 : 0;
  if (medicineUsed > 0) consumeResourceLots(state,{resourceKey:'medicine',amount:medicineUsed});
  const practice = chooseTreatmentPractice(state, entry.pathologyId, entry.treatmentsTried, medic, patient);
  const severityBefore = entry.severity;
  const practiceSignal = treatmentSignal(state, entry.pathologyId, practice);
  const traumaticWound = entry.pathologyId === 'traumatic-wound';
  const improvementPerDay = traumaticWound
    ? 8 + efficacy * 9 + medicineUsed * 7 + practiceSignal * 2
    : 0.6 + efficacy * 2.5 + medicineUsed * 5 + practiceSignal * 3;
  entry.severity = clamp(entry.severity - improvementPerDay * hours / 24, 0, 100);
  const severityDelta = severityBefore - entry.severity;
  if (traumaticWound) {
    const stabilizationHp = 1.5 + efficacy * 2 + medicineUsed * 3;
    patient.health = clamp(patient.health + stabilizationHp + severityDelta * 0.4);
  }
  if (entry.observedSymptoms.length === 0) entry.observedSymptoms.push(traumaticWound ? 'visible wound / pain-limited movement' : 'fever/malaise pattern recorded');
  if (!entry.treatmentsTried.includes(practice)) entry.treatmentsTried.push(practice);
  if (medic) medic.experience[`treatment:${entry.pathologyId}:${practice}`] = (medic.experience[`treatment:${entry.pathologyId}:${practice}`] ?? 0) + hours;
  recordTreatmentInference(state, patient, medics, entry, practice, severityBefore);
  const resolved = entry.severity <= 2;
  if (resolved) {
    entry.status = 'resolved'; patient.health = clamp(patient.health + 3);
    addChronicle(state, { kind: 'medicine', title: `${entry.pathologyId} case resolved`, text: `${practice} was part of the observed care history. The community stores experience as uncertain evidence, not guaranteed recipe truth.`, entityIds: [patient.id, entry.id, ...(medic ? [medic.id] : [])] });
  }
  return { practice, medicineUsed, severityBefore, severityAfter: entry.severity, resolved, ...(medic ? { medicId: medic.id } : {}) };
}

export function requestDirectClinicCare(state: SandboxGameState, patientId: string, durationMinutes = 60): { pathology?: ClinicTreatmentResult; healthBefore: number; healthAfter: number; medicId: string } {
  const patient = findAgent(state, patientId);
  if (!patient?.alive || patient.expeditionId || (patient.residence && patient.residence !== 'settlement')) throw new Error('Direct clinic care requires the controlled person to be alive and physically at the settlement.');
  const medic = settlementAgents(state).filter((agent) => agent.id !== patient.id && (agent.currentTask === 'medicine' || agent.role === 'medic')).sort((a, b) => b.skills.medicine - a.skills.medicine)[0]
    ?? settlementAgents(state).filter((agent) => agent.id !== patient.id).sort((a, b) => b.skills.medicine - a.skills.medicine)[0];
  if (!medic) throw new Error('No co-located person can provide clinic care.');
  if (state.settlement.clinicCapacity <= 0) throw new Error('No functioning local clinic capacity is available.');
  const minutes = Math.max(15, Math.min(240, Math.floor(durationMinutes)));
  const hours = minutes / 60;
  reserveDirectActivity(state, [patient.id, medic.id], 'clinic', minutes, `Direct clinic care for ${patient.name}.`);
  const healthBefore = patient.health;
  const active = patient.pathology.filter((entry) => entry.status === 'active').sort((a, b) => b.severity - a.severity)[0];
  let pathology: ClinicTreatmentResult | undefined;
  if (active) pathology = applyClinicTreatment(state, patient, active, medic, hours);
  else {
    const medicineUsed = state.settlement.resources.medicine >= 0.25 ? 0.25 : 0;
    if (medicineUsed > 0) consumeResourceLots(state,{resourceKey:'medicine',amount:medicineUsed});
    const recovery = 0.8 + medic.skills.medicine / 35 + medicineUsed * 4;
    patient.health = clamp(patient.health + recovery);
  }
  addChronicle(state, { kind: 'medicine', title: `Direct clinic care: ${patient.name}`, text: pathology ? `${pathology.practice} reduced ${active?.pathologyId ?? 'recorded pathology'} severity ${pathology.severityBefore.toFixed(1)} → ${pathology.severityAfter.toFixed(1)}${pathology.medicineUsed ? ' with medicine support' : ' without medicine stock'}.` : `Supportive care changed observed HP ${healthBefore.toFixed(1)} → ${patient.health.toFixed(1)}.`, entityIds: [patient.id, medic.id, ...(active ? [active.id] : [])] });
  return { ...(pathology ? { pathology } : {}), healthBefore, healthAfter: patient.health, medicId: medic.id };
}

function clinicCare(state: SandboxGameState, hours: number, summary: SandboxStepSummary): void {
  const medics = settlementAgents(state).filter((agent) => agent.currentTask === 'medicine' || agent.role === 'medic').sort((a, b) => b.skills.medicine - a.skills.medicine);
  const cases = settlementAgents(state).flatMap((agent) => agent.pathology.filter((entry) => entry.status === 'active').map((entry) => ({ agent, entry }))).filter(({agent})=>reservedHoursByKindDuringCurrentInterval(state,agent.id,'clinic',hours)<=0).sort((a, b) => b.entry.severity - a.entry.severity);
  const capacity = Math.max(0, Math.floor(Math.min(state.settlement.clinicCapacity, medics.length * 2 + 1) * hours / 24 + 0.5));
  for (const { agent, entry } of cases.slice(0, capacity)) {
    const result = applyClinicTreatment(state, agent, entry, medics[0], hours);
    if (result.resolved) summary.knowledgeUpdates.push(`${agent.name}'s ${entry.pathologyId} resolved after observed care.`);
  }
}

function mortality(state: SandboxGameState, summary: SandboxStepSummary): void {
  for (const agent of livingAgents(state)) {
    if (agent.health > 0.5) continue;
    recordAgentDeath(state, agent, agent.pathology.some((entry) => entry.status === 'active') ? 'illness and complications' : 'deprivation/injury', summary);
  }
}

function leadershipScore(state: SandboxGameState, agent: SandboxAgent): number {
  const socialTrust = settlementAgents(state).reduce((sum, other) => sum + (other.relations.find((relation) => relation.targetId === agent.id)?.trust ?? 0), 0) / Math.max(1, settlementAgents(state).length);
  return agent.skills.leadership * 0.4 + agent.authority.legitimacy * 0.3 + socialTrust * 0.2 + (agent.socialStatus?.standing ?? 40) * 0.1;
}

function ensureLeadership(state: SandboxGameState, summary: SandboxStepSummary): void {
  const current = findAgent(state, state.settlement.leaderId);
  const needsSuccession = !current?.alive || current.expeditionId !== null || current.authority.legitimacy < 22;
  if (!needsSuccession) return;
  const candidates = settlementAgents(state).filter((agent) => agentAgeYears(state, agent) >= 16).sort((a, b) => leadershipScore(state, b) - leadershipScore(state, a));
  const next = candidates[0]; if (!next) return;
  if (current) current.authority.offices = current.authority.offices.filter((office) => office !== 'settlement-leader');
  state.settlement.leaderId = next.id; next.authority.offices = [...new Set([...next.authority.offices, 'settlement-leader'])]; next.authority.legitimacy = Math.max(next.authority.legitimacy, 52);
  summary.leadershipChanges.push(next.id);
  addChronicle(state, { kind: 'leadership', title: `${next.name} became acting leader`, text: `Succession followed ${state.settlement.successionRule}; player convenience does not override social legitimacy.`, entityIds: [next.id, ...(current ? [current.id] : [])] });
}

function maybeConceive(state: SandboxGameState): void {
  if (state.clock.minuteOfDay !== 0 && state.clock.minuteOfDay !== 360) return;
  const adults = settlementAgents(state).filter((agent) => agentAgeYears(state, agent) >= 18 && agentAgeYears(state, agent) <= 43 && agent.health >= 55);
  const pregnantIds = new Set(state.pregnancies.filter((entry) => entry.outcome === 'ongoing').map((entry) => entry.pregnantAgentId));
  for (const female of adults.filter((agent) => agent.sex === 'female' && !pregnantIds.has(agent.id))) {
    const partner = female.partnerIds.map((id) => findAgent(state, id)).find((agent): agent is SandboxAgent => Boolean(agent?.alive && agent.sex === 'male' && (agent.residence ? agent.residence === 'settlement' : agent.expeditionId === null)));
    if (!partner) continue;
    const fertility = ((female.genetics.loci.fertility ?? 50) + (partner.genetics.loci.fertility ?? 50)) / 200;
    const scarcity = Math.min(1, state.settlement.resources.food / Math.max(1, settlementAgents(state).length * 8));
    if (!chance(state, 0.0009 * fertility * scarcity)) continue;
    const pregnancy: PregnancyState = { id: nextStateId(state, 'pregnancy'), parentIds: [female.id, partner.id], pregnantAgentId: female.id, conceptionDay: state.clock.day, expectedDay: state.clock.day + randomInt(state, 266, 286), outcome: 'ongoing', anomalyTags: [] };
    state.pregnancies.push(pregnancy);
  }
}

function makeChild(state: SandboxGameState, pregnancy: PregnancyState): SandboxAgent | null {
  const parentA = findAgent(state, pregnancy.parentIds[0]); const parentB = findAgent(state, pregnancy.parentIds[1]);
  if (!parentA || !parentB) return null;
  const sex = chance(state, 0.5) ? 'female' : 'male';
  const id = nextStateId(state, 'person');
  const naming = generatePersonName(state.seed,id,parentA.householdId,parentA.naming?.familyName);
  const name = naming.fullName;
  const skills = Object.fromEntries((Object.keys(parentA.skills) as SkillKey[]).map((key) => [key, clamp(Math.round((parentA.skills[key] + parentB.skills[key]) / 2 + randomInt(state, -15, 15)), 10, 90)])) as AgentSkills;
  return {
    id, identityOrigin:'lived-game-state', profileAuthority:{identity:'lived-game-state',name:'lived-game-state',household:'lived-game-state',age:'lived-game-state',sex:'lived-game-state',role:'lived-game-state',skills:'lived-game-state',genetics:'lived-game-state',healthBaseline:'lived-game-state',personality:'lived-game-state',faith:'lived-game-state'}, name, sex, bornDay: state.clock.day, alive: true, deathDay: null, causeOfDeath: '', role: 'child', householdId: parentA.householdId,
    parentIds: [parentA.id, parentB.id], partnerIds: [], genetics: { lineageMarker: chance(state, 0.5) ? parentA.genetics.lineageMarker : parentB.genetics.lineageMarker, loci: { resilience: Math.round(((parentA.genetics.loci.resilience ?? 50) + (parentB.genetics.loci.resilience ?? 50)) / 2 + randomInt(state, -8, 8)), metabolism: Math.round(((parentA.genetics.loci.metabolism ?? 50) + (parentB.genetics.loci.metabolism ?? 50)) / 2 + randomInt(state, -8, 8)), fertility: Math.round(((parentA.genetics.loci.fertility ?? 50) + (parentB.genetics.loci.fertility ?? 50)) / 2 + randomInt(state, -8, 8)) }, anomalyTraits: [...new Set([...parentA.genetics.anomalyTraits, ...parentB.genetics.anomalyTraits].filter(() => chance(state, 0.5)).concat(pregnancy.anomalyTags))] },
    naming, aptitude: skills, education: { mentorId: parentA.id, focus: 'survival', hours: 0, lastKnowledgeHour: 0 }, health: randomInt(state, 74, 96), fatigue: 12, morale: 60, needs: { hunger: 12, thirst: 10, rest: 28, safety: 8, belonging: 6 }, skills: Object.fromEntries(Object.keys(skills).map((key)=>[key,1])) as AgentSkills,
    goals: ['grow', 'stay-with-household'], fears: [], beliefs: [], memories: [], relations: [{ targetId: parentA.id, kind: 'kin', authority:'lived-game-state', affinity: 80, trust: 80, obligation: 65 }, { targetId: parentB.id, kind: 'kin', authority:'lived-game-state', affinity: 80, trust: 80, obligation: 65 }], knowledgeIds: [], pathology: [], authority: { offices: [], legitimacy: 10, obedience: 70, refusalThreshold: 65 }, currentPlan: null, currentTask: 'rest', expeditionId: null, residence: 'settlement', experience: {},
    personality: { curiosity: clamp(Math.round(((parentA.personality?.curiosity ?? 50) + (parentB.personality?.curiosity ?? 50)) / 2 + randomInt(state, -12, 12))), caution: clamp(Math.round(((parentA.personality?.caution ?? 50) + (parentB.personality?.caution ?? 50)) / 2 + randomInt(state, -12, 12))), sociability: clamp(Math.round(((parentA.personality?.sociability ?? 50) + (parentB.personality?.sociability ?? 50)) / 2 + randomInt(state, -12, 12))), autonomy: clamp(Math.round(((parentA.personality?.autonomy ?? 50) + (parentB.personality?.autonomy ?? 50)) / 2 + randomInt(state, -12, 12))), empathy: clamp(Math.round(((parentA.personality?.empathy ?? 50) + (parentB.personality?.empathy ?? 50)) / 2 + randomInt(state, -12, 12))) },
    faith: { commitment: clamp(Math.round(((parentA.faith?.commitment ?? 20) + (parentB.faith?.commitment ?? 20)) / 2 + randomInt(state, -16, 16))), interpretationTags: [...new Set([...(parentA.faith?.interpretationTags ?? []), ...(parentB.faith?.interpretationTags ?? [])])].filter(() => chance(state, 0.55)).slice(0, 2) },
    affiliationIds: [parentA.householdId], socialStatus: { standing: 10, dependency: 90, outsider: 5 },
  };
}

function processPregnancies(state: SandboxGameState, summary: SandboxStepSummary): void {
  for (const pregnancy of state.pregnancies.filter((entry) => entry.outcome === 'ongoing' && entry.expectedDay <= state.clock.day)) {
    const pregnant = findAgent(state, pregnancy.pregnantAgentId);
    if (!pregnant?.alive || pregnant.health < 18) { pregnancy.outcome = 'loss'; continue; }
    const careFactor = state.settlement.childcareCapacity / 20 + state.settlement.clinicCapacity / 12;
    const lossRisk = Math.max(0.015, 0.08 - careFactor * 0.025);
    // Pregnancy outcome is a durable life-history event. Isolate its roll from unrelated labor
    // RNG consumption so planner/resource tuning cannot retroactively flip the same pregnancy.
    const outcomeRoll = scopedRandom(state.seed, `${pregnancy.id}:${pregnancy.expectedDay}:birth-outcome`);
    if (outcomeRoll < lossRisk) { pregnancy.outcome = 'loss'; pregnant.health = clamp(pregnant.health - randomInt(state, 3, 14)); continue; }
    const child = makeChild(state, pregnancy); if (!child) { pregnancy.outcome = 'loss'; continue; }
    pregnancy.outcome = 'birth'; state.agents.push(child); summary.births.push(child.id);
    const household = state.settlement.households.find((entry) => entry.id === child.householdId); if (household) household.memberIds.push(child.id);
    for (const parent of [findAgent(state, pregnancy.parentIds[0]), findAgent(state, pregnancy.parentIds[1])]) {
      if (!parent) continue;
      parent.relations.push({ targetId: child.id, kind: 'kin', authority:'lived-game-state', affinity: 82, trust: 78, obligation: 88 });
      parent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'event', text: `${child.name} was born.`, salience: 92, sourceIds: [child.id, pregnancy.id] });
      if (parent.memories.length > 80) parent.memories.splice(0, parent.memories.length - 80);
    }
    addChronicle(state, { kind: 'birth', title: `${child.name} was born`, text: `Inheritance included ${pregnancy.anomalyTags.length} pregnancy-linked transformation tag(s), without moral-value coding.`, entityIds: [child.id, ...pregnancy.parentIds] });
  }
}


function matureChildren(state: SandboxGameState): void {
  const roleBySkill: Partial<Record<SkillKey, SandboxAgent['role']>> = {
    medicine: 'medic', scouting: 'scout', construction: 'builder', foraging: 'forager', survival: 'water', care: 'caregiver', records: 'recorder', combat: 'guard',
  };
  for (const agent of settlementAgents(state)) {
    if (agent.role !== 'child' || agentAgeYears(state, agent) < 13) continue;
    const ranked = (Object.keys(agent.skills) as SkillKey[]).sort((a, b) => agent.skills[b] - agent.skills[a]);
    const selected = ranked.map((skill) => roleBySkill[skill]).find((role): role is SandboxAgent['role'] => Boolean(role)) ?? 'generalist';
    agent.role = selected;
    if (agent.profileAuthority) agent.profileAuthority.role = agent.identityOrigin === 'world-provider' ? 'game-derived' : 'lived-game-state';
    agent.goals = [...new Set([...agent.goals.filter((goal) => goal !== 'grow'), 'contribute-to-household'])];
    for (const institution of state.settlement.institutions) {
      const eligible = (institution.kind === 'clinic' && agent.skills.medicine >= 58) || (institution.kind === 'records' && agent.skills.records >= 55) || (institution.kind === 'childcare' && agent.skills.care >= 55) || (institution.kind === 'assembly' && agentAgeYears(state, agent) >= 16);
      if (eligible && !institution.memberIds.includes(agent.id)) institution.memberIds.push(agent.id);
      if (eligible && !agent.affiliationIds?.includes(institution.id)) (agent.affiliationIds ??= []).push(institution.id);
    }
    addChronicle(state, { kind: 'settlement', title: `${agent.name} entered the labor pool`, text: `Their emerging role is ${selected}, derived from aptitude rather than player assignment.`, entityIds: [agent.id] });
  }
}


function adaptSocialRelations(state: SandboxGameState, hours: number): void {
  const local = settlementAgents(state);
  if (local.length < 2) return;
  const factor = Math.min(1, hours / 24);
  for (const agent of local) {
    const peers = local.filter((candidate) => candidate.id !== agent.id && candidate.currentTask === agent.currentTask);
    if (!peers.length) continue;
    const peer = peers[randomInt(state, 0, peers.length - 1)];
    if (!peer) continue;
    let relation = agent.relations.find((entry) => entry.targetId === peer.id);
    if (!relation) {
      relation = { targetId: peer.id, kind: 'trust', authority:'lived-game-state', affinity: 30, trust: 28, obligation: 12 };
      agent.relations.push(relation);
    }
    const cooperative = agent.currentTask !== 'rest' && agent.currentPlan?.kind !== 'refuse-order';
    relation.trust = clamp(relation.trust + (cooperative ? 0.7 : 0.15) * factor);
    relation.affinity = clamp(relation.affinity + 0.35 * factor);
    const adultPair = agentAgeYears(state, agent) >= 18 && agentAgeYears(state, peer) >= 18;
    const closeKin = relation.kind === 'kin' || agent.parentIds.includes(peer.id) || peer.parentIds.includes(agent.id) || agent.parentIds.some((id) => peer.parentIds.includes(id));
    if (adultPair && !closeKin && relation.trust >= 55 && relation.affinity >= 55) {
      const key = `bond:${peer.id}`;
      agent.experience[key] = (agent.experience[key] ?? 0) + factor * Math.max(0.2, (relation.trust + relation.affinity - 90) / 18);
    }
  }
  const leader = findAgent(state, state.settlement.leaderId);
  if (!leader?.alive) return;
  for (const agent of local) {
    if (agent.id === leader.id || agent.currentPlan?.kind !== 'refuse-order') continue;
    let relation = agent.relations.find((entry) => entry.targetId === leader.id);
    if (!relation) {
      relation = { targetId: leader.id, kind: 'trust', authority:'lived-game-state', affinity: 25, trust: 25, obligation: 10 };
      agent.relations.push(relation);
    }
    relation.trust = clamp(relation.trust - 1.5 * factor);
    leader.authority.legitimacy = clamp(leader.authority.legitimacy - 0.08 * factor);
  }
}

function ensurePartnerRelation(agent: SandboxAgent, partner: SandboxAgent): void {
  let relation = agent.relations.find((entry) => entry.targetId === partner.id);
  if (!relation) {
    relation = { targetId: partner.id, kind: 'partner', authority:'lived-game-state', affinity: 65, trust: 58, obligation: 36 };
    agent.relations.push(relation);
  } else { relation.kind = 'partner'; relation.authority = 'lived-game-state'; }
  if (!agent.partnerIds.includes(partner.id)) agent.partnerIds.push(partner.id);
}

function adaptPartnerships(state: SandboxGameState): void {
  const adults = settlementAgents(state).filter((agent) => agentAgeYears(state, agent) >= 18 && agent.health > 35);
  const eligible = adults.filter((agent) => !agent.partnerIds.some((id) => findAgent(state, id)?.alive));
  const pairCandidates: Array<{ a: SandboxAgent; b: SandboxAgent; score: number }> = [];
  for (let i = 0; i < eligible.length; i += 1) {
    const agent = eligible[i]; if (!agent) continue;
    for (let j = i + 1; j < eligible.length; j += 1) {
      const candidate = eligible[j]; if (!candidate) continue;
      const relation = agent.relations.find((entry) => entry.targetId === candidate.id);
      const reverse = candidate.relations.find((entry) => entry.targetId === agent.id);
      if (!relation || !reverse || relation.kind === 'kin' || reverse.kind === 'kin') continue;
      if (agent.parentIds.includes(candidate.id) || candidate.parentIds.includes(agent.id) || agent.parentIds.some((id) => candidate.parentIds.includes(id))) continue;
      const forwardBond = agent.experience[`bond:${candidate.id}`] ?? 0;
      const reverseBond = candidate.experience[`bond:${agent.id}`] ?? 0;
      if (relation.affinity < 62 || relation.trust < 58 || reverse.affinity < 55 || reverse.trust < 50 || forwardBond + reverseBond < 18) continue;
      const temperament = ((agent.personality?.sociability ?? 50) + (candidate.personality?.sociability ?? 50) + (agent.personality?.empathy ?? 50) + (candidate.personality?.empathy ?? 50)) / 100;
      const score = forwardBond + reverseBond + (relation.affinity + relation.trust + reverse.affinity + reverse.trust) / 20 + temperament;
      pairCandidates.push({ a: agent, b: candidate, score });
    }
  }
  pairCandidates.sort((left, right) => right.score - left.score || `${left.a.id}:${left.b.id}`.localeCompare(`${right.a.id}:${right.b.id}`));
  const paired = new Set<string>();
  for (const pair of pairCandidates) {
    if (paired.has(pair.a.id) || paired.has(pair.b.id)) continue;
    if (pair.a.partnerIds.some((id) => findAgent(state, id)?.alive) || pair.b.partnerIds.some((id) => findAgent(state, id)?.alive)) continue;
    ensurePartnerRelation(pair.a, pair.b); ensurePartnerRelation(pair.b, pair.a);
    paired.add(pair.a.id); paired.add(pair.b.id);
    pair.a.needs.belonging = clamp(pair.a.needs.belonging - 12); pair.b.needs.belonging = clamp(pair.b.needs.belonging - 12);
    addChronicle(state, { kind: 'settlement', title: `${pair.a.name} and ${pair.b.name} formed a partnership`, text: 'Partnership emerged from accumulated affinity and trust. It is a social relation, not a player-assigned reproduction flag.', entityIds: [pair.a.id, pair.b.id] });
  }
  for (const agent of adults) {
    for (const partnerId of [...agent.partnerIds]) {
      const partner = findAgent(state, partnerId); if (!partner?.alive) continue;
      const relation = agent.relations.find((entry) => entry.targetId === partnerId); if (!relation || relation.kind !== 'partner') continue;
      if (relation.trust >= 12 || relation.affinity >= 12) continue;
      const fractureKey = `bond-fracture:${partnerId}`;
      agent.experience[fractureKey] = (agent.experience[fractureKey] ?? 0) + 1;
      if (agent.experience[fractureKey] < 8) continue;
      agent.partnerIds = agent.partnerIds.filter((id) => id !== partnerId); relation.kind = 'trust'; relation.authority = 'lived-game-state';
      partner.partnerIds = partner.partnerIds.filter((id) => id !== agent.id);
      const reverse = partner.relations.find((entry) => entry.targetId === agent.id); if (reverse?.kind === 'partner') { reverse.kind = 'trust'; reverse.authority = 'lived-game-state'; }
      addChronicle(state, { kind: 'settlement', title: `${agent.name} and ${partner.name} ended their partnership`, text: 'Relationship dissolution followed persistent low affinity/trust rather than a scripted event.', entityIds: [agent.id, partner.id] });
    }
  }
}

function dailyDecay(state: SandboxGameState, hours: number): void {
  const factor = hours / 24;
  state.settlement.sanitation = clamp(state.settlement.sanitation - 2.4 * factor);
  state.settlement.waterSafety = clamp(state.settlement.waterSafety - 1.2 * factor);
  state.settlement.defense = clamp(state.settlement.defense - 0.5 * factor);
  adjustResourceStock(state, 'medicine', -state.settlement.resources.medicine * 0.002 * factor, 'Medicine deterioration');
  for (const agent of settlementAgents(state)) {
    agent.needs.safety = clamp(agent.needs.safety + Math.max(0, 50 - state.settlement.defense) * 0.01 * factor);
    agent.needs.belonging = clamp(agent.needs.belonging + 1.2 * factor);
    agent.morale = clamp(agent.morale - Math.max(0, agent.needs.hunger - 55) * 0.008 * factor - Math.max(0, agent.needs.thirst - 55) * 0.01 * factor);
  }
}

export function simulateSettlementInterval(state: SandboxGameState, hours: number, summary: SandboxStepSummary): void {
  matureChildren(state);
  const educationHours = simulateEducationInterval(state,hours,summary);
  const projectHours = simulateLegacyProjects(state,hours,summary,educationHours);
  const local = settlementAgents(state);
  for (const agent of local) {
    const reservedHours = reservedHoursDuringCurrentInterval(state, agent.id, hours);
    const laborHours = Math.max(0, hours - reservedHours - (educationHours.get(agent.id) ?? 0) - (projectHours.get(agent.id) ?? 0));
    if (reservedHours >= hours - 1e-9) {
      agent.currentPlan = { id: nextStateId(state, 'plan'), kind: 'rest', priority: 100, reason: 'time reserved by direct player activity' };
      agent.currentTask = 'rest';
      continue;
    }
    if (agentAgeYears(state, agent) < 13) { agent.currentPlan = { id: nextStateId(state, 'plan'), kind: 'rest', priority: 70, reason: 'child schedule' }; agent.currentTask = 'rest'; continue; }
    const explicitAssignment = state.dailyLoop?.phase === 'executing'
      ? state.dailyLoop.currentPlan.assignments.find((entry) => entry.agentId === agent.id)
      : undefined;
    const medicallyUnable = agent.health <= 25 || agent.pathology.some((entry) => (entry.status === 'active' || entry.status === 'chronic') && entry.severity >= 80);
    const plan = explicitAssignment && !medicallyUnable
      ? { id: nextStateId(state, 'plan'), kind: explicitAssignment.task, priority: 100, reason: explicitAssignment.note ?? 'explicit daily settlement assignment' }
      : planAgent(state, agent);
    agent.currentPlan = plan;
    agent.currentTask = plan.kind === 'seek-care' || plan.kind === 'refuse-order' || plan.kind === 'socialize' ? 'rest' : plan.kind;
    if (laborHours > 0) executeTask(state, agent, agent.currentTask, laborHours);
  }
  consume(state, hours, summary);
  dailyDecay(state, hours);
  environmentalHealth(state, hours);
  clinicCare(state, hours, summary);
  adaptSocialRelations(state, hours);
  adaptPartnerships(state);
  maybeConceive(state);
  processPregnancies(state, summary);
  mortality(state, summary);
  ensureLeadership(state, summary);
  const localPopulation = settlementAgents(state).length;
  if (localPopulation === 0) state.status = 'local-collapse';
  if (localPopulation > state.settlement.housingCapacity) summary.settlementUpdates.push(`Housing crowding: ${localPopulation}/${state.settlement.housingCapacity}.`);
  finalizeDirectActivities(state);
}
