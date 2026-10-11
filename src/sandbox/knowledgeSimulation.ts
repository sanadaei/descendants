import { chance, choose, randomInt } from './rng.js';
import { reserveDirectActivity } from './directPlay.js';
import { addChronicle, findAgent, nextStateId, settlementAgents } from './stateUtils.js';
import type { KnowledgeEntry, SandboxAgent, SandboxGameState, SandboxStepSummary, SocialRecord } from './types.js';
import { syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
import { recordResourceProduction } from './resourceLedger.js';

function upsertBelief(state: SandboxGameState, agent: SandboxAgent, entry: KnowledgeEntry, confidenceScale = 1): void {
  const confidence = Math.max(0, Math.min(1, entry.confidence * confidenceScale));
  const existing = agent.beliefs.find((belief) => belief.basisKnowledgeIds.includes(entry.id) || (belief.claim === entry.claim && belief.subjectIds.join('|') === entry.subjectIds.join('|')));
  if (existing) {
    existing.confidence = Math.max(existing.confidence, confidence);
    if (!existing.basisKnowledgeIds.includes(entry.id)) existing.basisKnowledgeIds.push(entry.id);
    return;
  }
  agent.beliefs.push({ id: nextStateId(state, 'belief'), subjectIds: [...entry.subjectIds], claim: entry.claim, confidence, basisKnowledgeIds: [entry.id] });
  if (agent.beliefs.length > 60) agent.beliefs.splice(0, agent.beliefs.length - 60);
}

export function copyKnowledge(state: SandboxGameState, entry: KnowledgeEntry, fromId: string, toId: string): boolean {
  const target = findAgent(state, toId);
  if (!target || target.knowledgeIds.includes(entry.id)) return false;
  target.knowledgeIds.push(entry.id);
  if (!entry.holderIds.includes(toId)) entry.holderIds.push(toId);
  upsertBelief(state, target, entry, 0.92);
  const source = findAgent(state, fromId);
  target.memories.push({
    id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'knowledge', text: `Received: ${entry.claim}`,
    salience: Math.round(40 + entry.confidence * 40), sourceIds: [fromId, entry.id],
  });
  if (target.memories.length > 80) target.memories.splice(0, target.memories.length - 80);
  if (source) source.experience['teaching'] = (source.experience['teaching'] ?? 0) + 1;
  return true;
}

function oralTransmission(state: SandboxGameState, hours: number, summary: SandboxStepSummary): boolean {
  const local = settlementAgents(state);
  if (!local.length) return false;
  let changed = false;
  const attempts = Math.max(1, Math.floor(local.length * hours / 48));
  for (let index = 0; index < attempts; index += 1) {
    const source = choose(state, local);
    if (!source.knowledgeIds.length) continue;
    const relation = source.relations.length ? choose(state, source.relations) : null;
    const target = relation ? findAgent(state, relation.targetId) : choose(state, local);
    if (!target?.alive || target.expeditionId !== null || target.id === source.id) continue;
    const entry = state.knowledge.find((candidate) => candidate.id === choose(state, source.knowledgeIds));
    if (!entry || entry.lost || target.knowledgeIds.includes(entry.id)) continue;
    const social = relation ? (relation.trust + relation.affinity) / 200 : 0.4;
    if (!chance(state, Math.min(0.75, (0.08 + social * 0.3 + source.skills.records / 400) * hours / 24))) continue;
    if (copyKnowledge(state, entry, source.id, target.id)) changed = true;
    summary.knowledgeUpdates.push(`${source.name} orally transmitted knowledge to ${target.name}.`);
  }
  return changed;
}

function recordKnowledge(state: SandboxGameState, hours: number, summary: SandboxStepSummary): boolean {
  let changed = false;
  const recorders = settlementAgents(state).filter((agent) => agent.currentTask === 'records' && agent.knowledgeIds.length > 0);
  for (const recorder of recorders) {
    if (!chance(state, Math.min(0.5, hours / 36 + recorder.skills.records / 500))) continue;
    const candidateIds = recorder.knowledgeIds.filter((id) => !state.records.some((record) => record.knowledgeIds.includes(id)));
    if (!candidateIds.length) continue;
    const knowledgeId = choose(state, candidateIds);
    const knowledge = state.knowledge.find((entry) => entry.id === knowledgeId); if (!knowledge) continue;
    const record: SocialRecord = {
      id: nextStateId(state, 'record'), title: `Record: ${knowledge.claim.slice(0, 42)}`, body: knowledge.claim,
      createdDay: state.clock.day, authorId: recorder.id, knowledgeIds: [knowledge.id], copies: 1 + Math.floor(recorder.skills.records / 35), integrity: 0.95,
    };
    state.records.push(record); state.settlement.activeRecordIds.push(record.id); knowledge.carrier = 'record';
    if (!state.settlement.localKnowledgeIds.includes(knowledge.id)) state.settlement.localKnowledgeIds.push(knowledge.id);
    recordResourceProduction(state,{resourceKey:'records',amount:record.copies,harvesterIds:[recorder.id],sourcePreference:['institutional','records'],label:`records · ${record.title}`,note:'Recorder created durable copies.'});
    const institution = state.settlement.institutions.find((entry) => entry.kind === 'records'); if (institution) institution.recordIds.push(record.id);
    summary.knowledgeUpdates.push(`${recorder.name} created a durable record.`);
    changed = true;
  }
  return changed;
}

function degradeRecords(state: SandboxGameState, hours: number): void {
  const factor = hours / (24 * 365);
  for (const record of state.records) {
    const protection = state.settlement.sanitation / 250 + Math.min(0.3, record.copies * 0.03);
    record.integrity = Math.max(0, record.integrity - Math.max(0.0001, (0.08 - protection * 0.05) * factor));
    if (record.integrity <= 0.05) state.settlement.activeRecordIds = state.settlement.activeRecordIds.filter((id) => id !== record.id);
  }
}

function detectLostKnowledge(state: SandboxGameState, summary: SandboxStepSummary): boolean {
  let changed = false;
  const living = new Set(state.agents.filter((agent) => agent.alive).map((agent) => agent.id));
  for (const entry of state.knowledge) {
    if (entry.lost) continue;
    const holders = entry.holderIds.filter((id) => living.has(id));
    if (holders.length !== entry.holderIds.length) changed = true;
    entry.holderIds = holders;
    const recordSurvives = state.records.some((record) => record.knowledgeIds.includes(entry.id) && record.integrity > 0.05 && record.copies > 0);
    if (!entry.holderIds.length && !recordSurvives) {
      entry.lost = true; changed = true; state.settlement.localKnowledgeIds = state.settlement.localKnowledgeIds.filter((id) => id !== entry.id);
      summary.knowledgeUpdates.push(`Knowledge lost: ${entry.claim.slice(0, 56)}.`);
      addChronicle(state, { kind: 'knowledge', title: 'Knowledge was lost', text: entry.claim, entityIds: entry.subjectIds });
    }
  }
  return changed;
}


function samePhysicalContext(state: SandboxGameState, aId: string, bId: string): boolean {
  const a = findAgent(state, aId); const b = findAgent(state, bId);
  if (!a?.alive || !b?.alive) return false;
  if (a.expeditionId || b.expeditionId) return Boolean(a.expeditionId && a.expeditionId === b.expeditionId);
  return (a.residence ?? 'settlement') === 'settlement' && (b.residence ?? 'settlement') === 'settlement';
}

export function conductDirectConversation(
  state: SandboxGameState,
  speakerId: string,
  listenerId: string,
  knowledgeId: string,
): KnowledgeEntry {
  if (speakerId === listenerId) throw new Error('Conversation requires another person.');
  const speaker = findAgent(state, speakerId); const listener = findAgent(state, listenerId);
  if (!speaker?.alive || !listener?.alive) throw new Error('Conversation participant is unavailable.');
  if (!samePhysicalContext(state, speakerId, listenerId)) throw new Error('Direct conversation requires both people to be in the same physical context.');
  const entry = state.knowledge.find((candidate) => candidate.id === knowledgeId && !candidate.lost);
  if (!entry || !speaker.knowledgeIds.includes(entry.id)) throw new Error('The speaker does not currently know that claim.');
  reserveDirectActivity(state, [speaker.id, listener.id], 'conversation', 20, `Discussed: ${entry.claim}`, entry.subjectIds[0]);
  copyKnowledge(state, entry, speaker.id, listener.id);
  syncLegacyKnowledgeShadow(state);
  speaker.memories.push({
    id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'social', text: `Discussed ${entry.claim} with ${listener.name}.`,
    salience: Math.round(30 + entry.confidence * 30), sourceIds: [listener.id, entry.id],
  });
  if (speaker.memories.length > 80) speaker.memories.splice(0, speaker.memories.length - 80);
  return entry;
}

export function institutionalizeKnowledgeRecord(state: SandboxGameState, authorId: string, knowledgeId: string): SocialRecord {
  const author = findAgent(state, authorId);
  if (!author?.alive || author.expeditionId || (author.residence && author.residence !== 'settlement')) throw new Error('Archive work requires the author to be physically present at the settlement.');
  const knowledge = state.knowledge.find((entry) => entry.id === knowledgeId && !entry.lost);
  if (!knowledge || !author.knowledgeIds.includes(knowledge.id)) throw new Error('The author does not possess that knowledge.');
  const recordInstitution = state.settlement.institutions.find((entry) => entry.kind === 'records');
  if (!recordInstitution) throw new Error('No Records / Archive institution is available.');
  const existing = state.records.find((record) => record.knowledgeIds.includes(knowledge.id) && record.integrity > 0.05 && record.copies > 0);
  if (existing) {
    if (!state.settlement.localKnowledgeIds.includes(knowledge.id)) state.settlement.localKnowledgeIds.push(knowledge.id);
    syncLegacyKnowledgeShadow(state);
    return existing;
  }
  reserveDirectActivity(state, [author.id], 'records', 60, `Archived claim: ${knowledge.claim}`, knowledge.subjectIds[0]);
  const copies = 1 + Math.floor(author.skills.records / 35);
  const record: SocialRecord = {
    id: nextStateId(state, 'record'), title: `Archive: ${knowledge.claim.slice(0, 42)}`, body: knowledge.claim,
    createdDay: state.clock.day, authorId: author.id, knowledgeIds: [knowledge.id], copies, integrity: 0.97,
  };
  state.records.push(record);
  if (!state.settlement.activeRecordIds.includes(record.id)) state.settlement.activeRecordIds.push(record.id);
  if (!recordInstitution.recordIds.includes(record.id)) recordInstitution.recordIds.push(record.id);
  if (!state.settlement.localKnowledgeIds.includes(knowledge.id)) state.settlement.localKnowledgeIds.push(knowledge.id);
  knowledge.carrier = 'record';
  recordResourceProduction(state,{resourceKey:'records',amount:copies,harvesterIds:[author.id],sourcePreference:['institutional','records'],label:`records · ${record.title}`,note:'Direct archive action created durable copies.'});
  syncLegacyKnowledgeShadow(state);
  author.experience['archive'] = (author.experience['archive'] ?? 0) + 1;
  addChronicle(state, {
    kind: 'knowledge', title: 'Claim entered the Archive',
    text: `${author.name} created a durable record of a personally held claim. Institutional access now exists because the record physically exists.`,
    entityIds: [record.id, knowledge.id, author.id, ...knowledge.subjectIds],
  });
  return record;
}

export function addObservedKnowledge(
  state: SandboxGameState,
  holderIds: string[],
  subjectIds: string[],
  claim: string,
  confidence: number,
  sourceWorldKnowledgeId?: string,
  truthLinkIds: string[] = [],
  options: { promoteToSettlement?: boolean } = {},
): KnowledgeEntry {
  const entry: KnowledgeEntry = {
    id: nextStateId(state, 'knowledge'), subjectIds: [...subjectIds], claim, confidence: Math.max(0, Math.min(1, confidence)), acquiredDay: state.clock.day,
    carrier: 'memory', holderIds: [...new Set(holderIds)], truthLinkIds: [...truthLinkIds], lost: false,
    ...(sourceWorldKnowledgeId ? { sourceWorldKnowledgeId } : {}),
  };
  state.knowledge.push(entry);
  if (options.promoteToSettlement !== false && !state.settlement.localKnowledgeIds.includes(entry.id)) state.settlement.localKnowledgeIds.push(entry.id);
  for (const holderId of entry.holderIds) {
    const holder = findAgent(state, holderId);
    if (holder && !holder.knowledgeIds.includes(entry.id)) holder.knowledgeIds.push(entry.id);
    if (holder) upsertBelief(state, holder, entry, 1);
  }
  syncLegacyKnowledgeShadow(state);
  return entry;
}

export function simulateKnowledgeInterval(state: SandboxGameState, hours: number, summary: SandboxStepSummary): void {
  const transmitted = oralTransmission(state, hours, summary);
  const recorded = recordKnowledge(state, hours, summary);
  degradeRecords(state, hours);
  const lostOrReassigned = detectLostKnowledge(state, summary);
  if (state.records.length > 300) {
    const removable = state.records.filter((record) => record.integrity <= 0.05).slice(0, state.records.length - 300);
    const ids = new Set(removable.map((record) => record.id)); state.records = state.records.filter((record) => !ids.has(record.id));
  }
  if (transmitted || recorded || lostOrReassigned) syncLegacyKnowledgeShadow(state);
}

// I1-A shadow foundation: exported through the existing knowledge seam but not yet used by F3/WORLD.
export { KnowledgeStore } from './knowledgeStore.js';
export type { EvidenceRecordV2, KnowledgeClaimV2, KnowledgeSourceKind, KnowledgeStoreSnapshotV1 } from './knowledgeStore.js';
export { buildLegacyKnowledgeShadow, hasLegacyKnowledgeShadow, legacyKnowledgeShadowSnapshot, syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
