import type { KnowledgeEntry, ResearchProject, SandboxGameState } from './types.js';

export type ResearchDomain = 'medicine' | 'water' | 'forage' | 'repair' | 'records' | 'explore-prep';
export interface ResearchApplication { projectId: string; knowledgeId: string; domain: ResearchDomain; strength: number; uses: number; }

const labels: Record<ResearchDomain,string> = {medicine:'観測に基づく診療手順',water:'水の採取・管理手順',forage:'採集手順',repair:'資材・修繕手順',records:'記録保存手順','explore-prep':'現地調査の準備手順'};
export function researchApplicationLabel(domain: ResearchDomain): string { return labels[domain]; }

/** An explicit subject/sample scope is required; a generic claim grants no universal technology. */
export function researchApplicationDomain(source: KnowledgeEntry): ResearchDomain | null {
  const text=source.subjectIds.join(' ').toLowerCase();
  if (/pathology:|treatment:/.test(text)) return 'medicine';
  if (/water|freshwater/.test(text)) return 'water';
  if (/food|flora|ecological-guild|biomass/.test(text)) return 'forage';
  if (/material|timber|construction/.test(text)) return 'repair';
  if (/record|archive/.test(text)) return 'records';
  if (source.requiresPhysicalSample || source.physicalEvidenceSourceEntityId) return 'explore-prep';
  return null;
}

export function applyCompletedResearch(state: SandboxGameState, project: ResearchProject, result: KnowledgeEntry, source: KnowledgeEntry): void {
  const domain=researchApplicationDomain(source);
  if (!domain || result.confidence<.35) { project.practicalOutcome='知識として保存。実用手順を確立するには対象を特定した追加の観測が必要です。'; return; }
  const applications=state.researchApplications??(state.researchApplications=[]);
  if (!applications.some((a)=>a.projectId===project.id)) applications.push({projectId:project.id,knowledgeId:result.id,domain,strength:Math.min(.15,result.confidence*.15),uses:0});
  project.practicalOutcome=`${labels[domain]}を確立。同じ分野の作業へ最大${Math.round(result.confidence*.15*100)}%の改善を適用。`;
}

/** Keep the strongest extant local practice, never stack copies of one hypothesis. */
export function researchWorkMultiplier(state: SandboxGameState, domain: string, recordUse = false): number {
  const practice=(state.researchApplications??[]).filter((a)=>a.domain===domain && state.settlement.localKnowledgeIds.includes(a.knowledgeId) && state.knowledge.some((k)=>k.id===a.knowledgeId&&!k.lost))
    .sort((a,b)=>b.strength-a.strength||a.projectId.localeCompare(b.projectId))[0];
  if (practice && recordUse) practice.uses++;
  return 1+(practice?.strength??0);
}
