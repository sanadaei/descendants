import { addObservedKnowledge } from './knowledgeSimulation.js';
import { addChronicle, clamp, findAgent, nextStateId } from './stateUtils.js';
import type { SandboxGameState } from './types.js';

/** Game-side neutral carrier for provider/adapter supplied transformations. No field encodes moral value. */
export interface ProviderTransformation {
  agentId: string;
  sourceWorldEventId: string;
  sourceEntityIds?: string[];
  geneticTraitTags?: string[];
  locusDeltas?: Record<string, number>;
  pathology?: {
    pathologyId: string;
    severity: number;
    contagious?: boolean;
    observedSymptoms?: string[];
  };
  pregnancyTags?: string[];
  memoryText?: string;
  directlyObserved: boolean;
}

export function applyProviderTransformation(state: SandboxGameState, change: ProviderTransformation): void {
  const agent = findAgent(state, change.agentId);
  if (!agent?.alive) throw new Error(`Transformation target unavailable: ${change.agentId}`);
  for (const tag of change.geneticTraitTags ?? []) if (!agent.genetics.anomalyTraits.includes(tag)) agent.genetics.anomalyTraits.push(tag);
  for (const [locus, delta] of Object.entries(change.locusDeltas ?? {})) agent.genetics.loci[locus] = clamp((agent.genetics.loci[locus] ?? 50) + delta, -1000, 1000);
  if (change.pathology) {
    agent.pathology.push({
      id: nextStateId(state, 'case'), pathologyId: change.pathology.pathologyId, onsetDay: state.clock.day, severity: clamp(change.pathology.severity),
      contagious: change.pathology.contagious ?? false, observedSymptoms: [...(change.pathology.observedSymptoms ?? [])], suspectedCauses: [], treatmentsTried: [], status: 'active',
    });
  }
  for (const pregnancy of state.pregnancies.filter((entry) => entry.outcome === 'ongoing' && entry.pregnantAgentId === agent.id)) {
    pregnancy.anomalyTags.push(...(change.pregnancyTags ?? []).filter((tag) => !pregnancy.anomalyTags.includes(tag)));
  }
  if (change.memoryText) {
    agent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'event', text: change.memoryText, salience: 90, sourceIds: [change.sourceWorldEventId, ...(change.sourceEntityIds ?? [])] });
  }
  if (change.directlyObserved) {
    addObservedKnowledge(state, [agent.id], [agent.id, ...(change.sourceEntityIds ?? [])], `Observed transformation affecting ${agent.name}; mechanism remains undetermined.`, 0.72, undefined, [change.sourceWorldEventId], { promoteToSettlement: false });
  }
  addChronicle(state, { kind: 'medicine', title: `${agent.name}: transformation recorded`, text: 'The game stores effects and provenance without positive/negative classification.', entityIds: [agent.id, change.sourceWorldEventId, ...(change.sourceEntityIds ?? [])] });
}
