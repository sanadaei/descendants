import { agentAbilityFactors } from './aging.js';
import { copyKnowledge } from './knowledgeSimulation.js';
import { reservedHoursDuringCurrentInterval } from './directPlay.js';
import { agentAgeYears, effectiveSkill, findAgent, settlementAgents } from './stateUtils.js';
import type { SandboxGameState, SandboxStepSummary, SkillKey } from './types.js';

export function setEducationMentor(state: SandboxGameState, childId: string, mentorId: string | null, focus: SkillKey): void {
  const child=findAgent(state,childId); const mentor=mentorId?findAgent(state,mentorId):null;
  const locals=settlementAgents(state);
  if (!child?.alive || agentAgeYears(state,child)>=18 || !locals.includes(child)) throw new Error('Education requires a local child or apprentice.');
  if (!(focus in child.skills)) throw new Error('Unknown education skill.');
  if (mentorId && (!mentor || !locals.includes(mentor) || mentor.id===childId || agentAgeYears(state,mentor)<18)) throw new Error('Mentor must be a co-located adult.');
  child.education={mentorId,focus,hours:child.education?.hours??0,lastKnowledgeHour:child.education?.lastKnowledgeHour??0};
}

/** Tuition reserves teacher time; it cannot also count as ordinary labor. */
export function simulateEducationInterval(state: SandboxGameState, hours: number, summary: SandboxStepSummary): Map<string,number> {
  const local=settlementAgents(state); const reservations=new Map<string,number>();
  for (const child of local.filter((a)=>agentAgeYears(state,a)>=3 && agentAgeYears(state,a)<18)) {
    const lessonHours=hours/24;
    if (reservedHoursDuringCurrentInterval(state,child.id,hours)+lessonHours>hours) continue;
    const candidates=local.filter((a)=>agentAgeYears(state,a)>=18 && a.health>35 && a.fatigue<85 && (reservations.get(a.id)??0)+lessonHours<=hours*.25 && reservedHoursDuringCurrentInterval(state,a.id,hours)+(reservations.get(a.id)??0)+lessonHours<=hours)
      .sort((a,b)=>Number(child.parentIds.includes(b.id))-Number(child.parentIds.includes(a.id)) || b.skills.care-a.skills.care || a.id.localeCompare(b.id));
    const assigned=child.education?.mentorId?candidates.find((a)=>a.id===child.education?.mentorId):undefined;
    const mentor=assigned??candidates[0]; if (!mentor) continue;
    child.education??={mentorId:mentor.id,focus:'survival',hours:0,lastKnowledgeHour:0};
    if (!assigned) child.education.mentorId=mentor.id;
    reservations.set(mentor.id,(reservations.get(mentor.id)??0)+lessonHours);
    if (agentAgeYears(state,child)>=13) reservations.set(child.id,lessonHours);
    const focus=child.education.focus;
    const ceiling=Math.min(95,child.aptitude?.[focus]??75);
    const teaching=Math.max(.15, Math.min(1.4,effectiveSkill(state,mentor,focus)/60));
    const gain=lessonHours*.055*teaching*agentAbilityFactors(state,child).learning;
    child.skills[focus]=Math.min(ceiling,child.skills[focus]+gain);
    child.education.hours+=lessonHours; mentor.experience.teaching=(mentor.experience.teaching??0)+lessonHours;
    if (child.education.hours-child.education.lastKnowledgeHour>=24) {
      const entry=state.knowledge.find((k)=>!k.lost && mentor.knowledgeIds.includes(k.id) && !child.knowledgeIds.includes(k.id));
      if (entry && copyKnowledge(state,entry,mentor.id,child.id)) summary.knowledgeUpdates.push(`${mentor.name} taught ${child.name}: ${entry.claim}`);
      child.education.lastKnowledgeHour=child.education.hours;
    }
  }
  return reservations;
}
