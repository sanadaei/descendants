import { adjustResourceStock, reconcileResourceLedgerToAggregates } from './resourceLedger.js';
import type { WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { ProviderMutationUncertainError, restoreSandboxState } from './worldMutationSafety.js';
import { issueProviderCommandOnce, nextProviderCommandId } from './providerMutationJournal.js';
import { chance, randomInt } from './rng.js';
import { addChronicle, clamp, effectiveSkill, findAgent, nextStateId, settlementAgents } from './stateUtils.js';
import type { AnomalyUtilizationDomain, AnomalyUtilizationPractice, KnowledgeEntry, SandboxAgent, SandboxGameState } from './types.js';

function practices(state: SandboxGameState): AnomalyUtilizationPractice[] {
  return state.anomalyPractices ?? (state.anomalyPractices = []);
}

function anomalyVariableIds(state: SandboxGameState): Set<string> {
  const ids = new Set<string>();
  for (const definition of state.world.manifest.variableDefinitions) {
    const semantic = `${definition.id} ${definition.namespace} ${definition.semantic ?? ''}`.toLowerCase();
    if (semantic.includes('anomal')) {
      ids.add(definition.id);
      ids.add(`${definition.namespace}:${definition.id}`);
    }
  }
  return ids;
}

export function anomalyBasisForKnowledge(state: SandboxGameState, entry: KnowledgeEntry): { variableId: string | null; targetId: string | null } | null {
  if (entry.lost) return null;
  const anomalyVars = anomalyVariableIds(state);
  const variableId = entry.subjectIds.find((id) => anomalyVars.has(id)) ?? null;
  const claimLooksAnomalous = /anomal|impossible|discontinu|transformation|mutation|parasit|time[- ]?shift/i.test(entry.claim);
  if (!variableId && !claimLooksAnomalous) return null;
  const targetId = entry.subjectIds.find((id) => id !== variableId && !anomalyVars.has(id)) ?? null;
  return { variableId, targetId };
}

function operatorScore(state: SandboxGameState, agent: SandboxAgent, domain: AnomalyUtilizationDomain): number {
  const curiosity = agent.personality?.curiosity ?? 50;
  if (domain === 'medicine') return effectiveSkill(state,agent,'medicine') * 0.55 + effectiveSkill(state,agent,'records') * 0.2 + curiosity * 0.25;
  if (domain === 'communication') return effectiveSkill(state,agent,'records') * 0.35 + effectiveSkill(state,agent,'scouting') * 0.35 + curiosity * 0.3;
  if (domain === 'defense') return effectiveSkill(state,agent,'leadership') * 0.35 + effectiveSkill(state,agent,'scouting') * 0.35 + effectiveSkill(state,agent,'construction') * 0.3;
  return effectiveSkill(state,agent,'construction') * 0.45 + effectiveSkill(state,agent,'records') * 0.25 + curiosity * 0.3;
}

function selectOperators(state: SandboxGameState, domain: AnomalyUtilizationDomain, requested?: string[]): SandboxAgent[] {
  const requestedSet = requested?.length ? new Set(requested) : null;
  return settlementAgents(state)
    .filter((agent) => agent.alive && (!requestedSet || requestedSet.has(agent.id)) && agent.health >= 30 && agent.fatigue < 92)
    .sort((a, b) => operatorScore(state,b, domain) - operatorScore(state,a, domain))
    .slice(0, 3);
}

async function firstExistingTarget(provider: WorldProvider, state: SandboxGameState, source: KnowledgeEntry, variableId: string | null): Promise<WorldEntity | null> {
  for (const id of source.subjectIds) {
    if (id === variableId) continue;
    const entity = await provider.getEntity(id, state.world.originEntityId);
    if (entity) return entity;
  }
  const origin = await provider.getEntity(state.world.originEntityId, state.world.originEntityId);
  return origin;
}

function applyPracticalEffect(state: SandboxGameState, domain: AnomalyUtilizationDomain, efficacy: number): string {
  if (domain === 'medicine') {
    const active = state.agents.flatMap((agent) => agent.pathology.map((entry) => ({ agent, entry }))).filter(({ entry }) => entry.status === 'active').sort((a, b) => b.entry.severity - a.entry.severity)[0];
    if (active) {
      const reduction = Math.max(0.5, efficacy * 3.5);
      active.entry.severity = Math.max(0, active.entry.severity - reduction);
      if (active.entry.severity <= 1) active.entry.status = 'resolved';
      return `Clinical application changed an observed case by ${reduction.toFixed(1)} severity without establishing a universal cure.`;
    }
    return 'Clinical application produced no measurable patient effect in the current case mix.';
  }
  if (domain === 'production') {
    const yieldAmount = 0.5 + efficacy * 2;
    adjustResourceStock(state, 'fuel', yieldAmount, 'Observed anomaly production');
    return `A repeatable local process yielded ${yieldAmount.toFixed(1)} units of usable fuel-equivalent output.`;
  }
  if (domain === 'defense') {
    const gain = 0.2 + efficacy * 1.2;
    state.settlement.defense = clamp(state.settlement.defense + gain);
    return `Containment/defensive procedure increased local defense readiness by ${gain.toFixed(1)}.`;
  }
  return 'Communication application established a temporary, practice-dependent signal aid; its effect is reflected in future expedition communication checks.';
}

function applyFailure(state: SandboxGameState, operators: SandboxAgent[], domain: AnomalyUtilizationDomain): string {
  const operator = operators[randomInt(state, 0, Math.max(0, operators.length - 1))];
  if (!operator) return 'The attempt failed without a clearly attributable local consequence.';
  operator.fatigue = clamp(operator.fatigue + randomInt(state, 5, 16));
  if (chance(state, 0.28)) {
    operator.health = clamp(operator.health - randomInt(state, 2, 9));
    return `${operator.name} suffered a non-classified adverse bodily effect during the ${domain} attempt.`;
  }
  operator.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'trauma', text: `An anomaly-utilization attempt in ${domain} produced an effect the operator could not reliably reproduce.`, salience: 62, sourceIds: [] });
  return `The ${domain} attempt failed reproducibility and left an uncertain operator memory.`;
}

export interface AnomalyUtilizationRequest {
  sourceKnowledgeId: string;
  domain: AnomalyUtilizationDomain;
  operatorIds?: string[];
}

export interface AnomalyUtilizationResult {
  practice: AnomalyUtilizationPractice;
  accepted: boolean;
  success: boolean;
  outcome: string;
}

export async function attemptAnomalyUtilization(provider: WorldProvider, state: SandboxGameState, request: AnomalyUtilizationRequest): Promise<AnomalyUtilizationResult> {
  const committed = structuredClone(state);
  let providerTouched = false;
  try {

      const source = state.knowledge.find((entry) => entry.id === request.sourceKnowledgeId && !entry.lost);
      if (!source) throw new Error('Anomaly utilization requires extant in-world knowledge.');
      const basis = anomalyBasisForKnowledge(state, source);
      if (!basis) throw new Error('The selected claim does not provide an anomaly-facing epistemic basis.');
      const operators = selectOperators(state, request.domain, request.operatorIds);
      if (!operators.length) throw new Error('No available operator can attempt anomaly utilization.');
      if (!operators.some((agent) => agent.knowledgeIds.includes(source.id)) && !state.settlement.localKnowledgeIds.includes(source.id)) throw new Error('Operators lack an in-world basis for the attempt.');
      const target = await firstExistingTarget(provider, state, source, basis.variableId);
      if (!target) throw new Error('No provider-backed target can be associated with the selected anomaly claim.');
      reconcileResourceLedgerToAggregates(state, 'legacy anomaly stock');
      const costScrap = request.domain === 'production' || request.domain === 'defense' ? 1.5 : 0.6;
      const costFuel = request.domain === 'communication' ? 1.2 : 0.4;
      if (state.settlement.resources.scrap < costScrap || state.settlement.resources.fuel < costFuel) throw new Error('Insufficient local materials for a controlled anomaly-utilization attempt.');
      adjustResourceStock(state, 'scrap', -costScrap, 'Anomaly experiment materials');
      adjustResourceStock(state, 'fuel', -costFuel, 'Anomaly experiment fuel');

      let practice = practices(state).find((entry) => entry.sourceKnowledgeId === source.id && entry.domain === request.domain && entry.targetEntityId === target.id);
      if (!practice) {
        practice = { id: nextStateId(state, 'anomaly-practice'), sourceKnowledgeId: source.id, targetEntityId: target.id, inferredVariableId: basis.variableId, domain: request.domain, operatorIds: operators.map((agent) => agent.id), attempts: 0, mastery: 0, stability: 25, startedDay: state.clock.day, lastAttemptDay: state.clock.day, lastOutcome: '', providerEventIds: [] };
        practices(state).push(practice);
      } else {
        practice.operatorIds = [...new Set([...practice.operatorIds, ...operators.map((agent) => agent.id)])];
      }

      const providerBasis = source.sourceWorldKnowledgeId ? [source.sourceWorldKnowledgeId] : [];
      providerTouched = true;
      const commandId = nextProviderCommandId(state, `anomaly-${request.domain}`);
      const { result: command } = await issueProviderCommandOnce(provider, state, {
        id: commandId,
        issuedTick: state.clock.worldTick,
        ...(providerBasis.length ? { issuerId: state.world.originEntityId, epistemicBasisIds: providerBasis } : {}),
        kind: 'anomaly.utilize', targets: [target.id], location: structuredClone(state.settlement.position),
        payload: { domain: request.domain, localKnowledgeId: source.id, inferredVariableId: basis.variableId, confidence: source.confidence },
      });
      practice.attempts += 1;
      practice.lastAttemptDay = state.clock.day;
      practice.providerEventIds.push(...command.eventIds);
      if (!command.accepted) {
        practice.stability = clamp(practice.stability - 4);
        practice.lastOutcome = `Provider rejected intervention: ${command.reason ?? 'unknown reason'}`;
        addChronicle(state, { kind: 'knowledge', title: 'Anomaly-utilization attempt rejected', text: practice.lastOutcome, entityIds: [practice.id, target.id, ...operators.map((agent) => agent.id)] });
        return { practice, accepted: false, success: false, outcome: practice.lastOutcome };
      }

      const competence = operators.reduce((sum, agent) => sum + operatorScore(state,agent, request.domain), 0) / operators.length;
      const masteryBonus = practice.mastery / 250;
      const successChance = clamp(0.08 + source.confidence * 0.42 + competence / 260 + masteryBonus, 0.08, 0.9);
      const success = chance(state, successChance);
      for (const operator of operators) operator.experience[`anomaly-use:${request.domain}`] = (operator.experience[`anomaly-use:${request.domain}`] ?? 0) + 1;
      let outcome: string;
      if (success) {
        const efficacy = clamp(source.confidence * 0.45 + competence / 180 + practice.mastery / 220, 0.05, 1);
        outcome = applyPracticalEffect(state, request.domain, efficacy);
        practice.mastery = clamp(practice.mastery + 4 + efficacy * 7);
        practice.stability = clamp(practice.stability + 2 + efficacy * 4);
        const resultKnowledge = addObservedKnowledge(state, operators.map((agent) => agent.id), [target.id, ...(basis.variableId ? [basis.variableId] : [])], `Practice result (${request.domain}): ${outcome}`, clamp(0.28 + practice.mastery / 160, 0.28, 0.86), undefined, [...source.truthLinkIds], { promoteToSettlement: false });
        resultKnowledge.sourceKnowledgeId = source.id;
      } else {
        outcome = applyFailure(state, operators, request.domain);
        practice.mastery = clamp(practice.mastery + 1.2);
        practice.stability = clamp(practice.stability - 2.5);
      }
      practice.lastOutcome = outcome;
      addChronicle(state, { kind: 'knowledge', title: `Anomaly utilization: ${request.domain}`, text: `${success ? 'Operational effect observed' : 'Attempt failed'} — ${outcome}`, entityIds: [practice.id, target.id, ...operators.map((agent) => agent.id), ...command.eventIds] });
      return { practice, accepted: true, success, outcome };
  } catch (error) {
    restoreSandboxState(state, committed);
    if (!providerTouched) throw error;
    if (error instanceof ProviderMutationUncertainError) throw new ProviderMutationUncertainError(`Anomaly provider command failed after mutation may have begun; local consequences were rolled back. ${error.message}`, error);
    throw new ProviderMutationUncertainError(`Anomaly provider command failed after mutation may have begun; local consequences were rolled back. ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

export function anomalyCommunicationSupport(state: SandboxGameState): number {
  return practices(state).filter((entry) => entry.domain === 'communication' && entry.attempts > 0).reduce((best, entry) => Math.max(best, clamp(entry.mastery / 100, 0, 0.35)), 0);
}
