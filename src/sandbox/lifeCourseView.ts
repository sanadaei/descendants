import { agentAbilityFactors } from './aging.js';
import { agentAgeYears, findAgent, settlementAgents } from './stateUtils.js';
import type { SandboxAgent, SandboxGameState } from './types.js';

const escapeHtml=(value: string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function renderLifeCourse(state: SandboxGameState, agent: SandboxAgent, live: boolean): string {
  const family=agent.parentIds.map((id)=>findAgent(state,id)?.name??id).map(escapeHtml).join(' / ');
  const identity=agent.naming?`Neral · ${escapeHtml(agent.naming.familyName)}`:'';
  const factors=agentAbilityFactors(state,agent);
  const ability=live?`<p>身体 ${Math.round(factors.physical*100)}% · 判断 ${Math.round(factors.judgment*100)}% · 回復 ${Math.round(factors.recovery*100)}%</p><small>年齢による能力係数。習得した技能は別に保持します。</small>`:'<p>現在の身体状態は未確認です。</p>';
  const canLearn=live&&agent.alive&&agentAgeYears(state,agent)<18&&settlementAgents(state).some((a)=>a.id===agent.id);
  const mentors=settlementAgents(state).filter((a)=>a.id!==agent.id&&agentAgeYears(state,a)>=18);
  const skills=Object.keys(agent.skills);
  const controls=canLearn?`<label>指導者<select data-action="education-mentor" data-agent-id="${escapeHtml(agent.id)}"><option value="">自動選択</option>${mentors.map((m)=>`<option value="${escapeHtml(m.id)}" ${agent.education?.mentorId===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}</select></label><label>学ぶ技能<select data-action="education-focus" data-agent-id="${escapeHtml(agent.id)}">${skills.map((s)=>`<option value="${s}" ${(agent.education?.focus??'survival')===s?'selected':''}>${s}</option>`).join('')}</select></label><p>教育 ${Math.floor(agent.education?.hours??0)}時間 · ${escapeHtml(agent.education?.focus??'survival')} ${agent.skills[agent.education?.focus??'survival'].toFixed(1)}</p>`:'';
  return `<section class="desc-pda-life-course"><strong>生涯・家族・教育</strong><p>${identity}${family?` · 親 ${family}`:''}</p>${ability}${controls}${live&&!agent.alive?`<p>${escapeHtml(agent.causeOfDeath)} · ${agent.deathDay}日目</p>`:''}</section>`;
}
