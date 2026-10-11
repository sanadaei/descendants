import type { SandboxGameState } from './types.js';

export function legacyFacilityActive(state: SandboxGameState, kind: 'waterworks'|'archive'): boolean {
  return Boolean(state.legacyProjects?.some((project) => project.kind === kind && project.status === 'completed'
    && state.records.some((record) => record.id === project.recordId && record.integrity > .05 && record.copies > 0)
    && project.knowledgeIds.every((id) => state.settlement.localKnowledgeIds.includes(id) && state.knowledge.some((entry) => entry.id === id && !entry.lost))));
}
