import type { KnowledgeEntry, ResearchProject, SandboxGameState } from './types.js';

export type ResearchDomain = 'medicine' | 'water' | 'forage' | 'repair' | 'records' | 'explore-prep';
export interface ResearchApplication { projectId: string; knowledgeId: string; domain: ResearchDomain; strength: number; uses: number; }

const labels: Record<ResearchDomain,string> = {medicine:'観測に基づく診療手順',water:'水の採取・管理手順',forage:'採集手順',repair:'資材・修繕手順',records:'記録保存手順','explore-prep':'現地調査の準備手順'};
export function researchApplicationLabel(domain: ResearchDomain): string { return labels[domain]; }

/** Classify observed semantics, not substrings in opaque WorldProvider identities. */
export function researchApplicationDomain(source: KnowledgeEntry): ResearchDomain | null {
  if (source.treatmentObservation || source.subjectIds.some((id) => /^(pathology|treatment):/.test(id))) return 'medicine';
  const observation = source.entityObservation;
  if (observation) {
    if (observation.resourceKeys.includes('water')) return 'water';
    if (observation.resourceKeys.includes('food')) return 'forage';
    if (observation.resourceKeys.includes('medicine')) return 'medicine';
    if (observation.resourceKeys.some((key) => ['timber', 'scrap', 'cloth'].includes(key))) return 'repair';
    if (observation.resourceKeys.includes('records') || ['archive-record', 'cartographic-record'].includes(observation.kind)) return 'records';
  }
  // Preserve explicit legacy semantic subjects; arbitrary entity/item IDs carry no semantics.
  for (const id of source.subjectIds) {
    const subject = /^(resource|material|record|archive):([a-z-]+)$/.exec(id);
    if (!subject) continue;
    const semantic = subject[2] ?? '';
    if (['water', 'freshwater'].includes(semantic)) return 'water';
    if (['food', 'flora', 'biomass'].includes(semantic)) return 'forage';
    if (['timber', 'scrap', 'cloth', 'construction'].includes(semantic)) return 'repair';
    if (subject[1] === 'record' || subject[1] === 'archive') return 'records';
  }
  if (source.requiresPhysicalSample || source.physicalEvidenceSourceEntityId) return 'explore-prep';
  return null;
}

function hasImprovedTreatment(source: KnowledgeEntry): boolean {
  const outcome = source.treatmentObservation;
  return Boolean(outcome && source.subjectIds.includes(`pathology:${outcome.pathologyId}`)
    && source.subjectIds.includes(`treatment:${outcome.practice}`) && outcome.severityBefore - outcome.severityAfter > .35);
}

export function applyCompletedResearch(state: SandboxGameState, project: ResearchProject, result: KnowledgeEntry, source: KnowledgeEntry): void {
  const domain=researchApplicationDomain(source);
  if (domain === 'medicine' && !hasImprovedTreatment(source)) {
    project.practicalOutcome = '診療の改善手順は未確立。悪化・不明な結果や未検証の主張は記録し、効果を確かめる追加の観測が必要です。';
    return;
  }
  if (!domain || result.confidence<.35) { project.practicalOutcome='知識として保存。実用手順を確立するには対象を特定した追加の観測が必要です。'; return; }
  const applications=state.researchApplications??(state.researchApplications=[]);
  if (!applications.some((a)=>a.projectId===project.id)) applications.push({projectId:project.id,knowledgeId:result.id,domain,strength:Math.min(.15,result.confidence*.15),uses:0});
  project.practicalOutcome=`${labels[domain]}を確立。同じ分野の作業へ最大${Math.round(result.confidence*.15*100)}%の改善を適用。`;
}

export function researchApplicationIsActive(state: SandboxGameState, application: ResearchApplication): boolean {
  const result = state.knowledge.find((entry) => entry.id === application.knowledgeId && !entry.lost);
  if (!result || !state.settlement.localKnowledgeIds.includes(result.id)) return false;
  // Old medicine bonuses without a recorded outcome remain saved but cannot improve treatment.
  if (application.domain === 'medicine' && !hasImprovedTreatment(result)) return false;
  return researchApplicationDomain(result) === application.domain && result.confidence >= .35;
}

/** Keep the strongest extant local practice, never stack copies of one hypothesis. */
export function researchWorkMultiplier(state: SandboxGameState, domain: string, recordUse = false): number {
  const practice=(state.researchApplications??[]).filter((a)=>a.domain===domain && researchApplicationIsActive(state,a))
    .sort((a,b)=>b.strength-a.strength||a.projectId.localeCompare(b.projectId))[0];
  if (practice && recordUse) practice.uses++;
  return 1+(practice?.strength??0);
}
