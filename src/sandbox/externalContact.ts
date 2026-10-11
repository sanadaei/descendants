import type { WorldEntity } from '../worldbridge/contract.js';
import { entityName, reserveDirectActivity } from './directPlay.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { addChronicle, addExpeditionChronicle, findAgent, nextStateId } from './stateUtils.js';
import type { ExternalPersonContact, SandboxGameState } from './types.js';

function contactStore(state: SandboxGameState): ExternalPersonContact[] {
  return state.externalContacts ??= [];
}

export function externalSocietyForPerson(state: SandboxGameState, personId: string): string | undefined {
  return state.externalActors.find((actor) => actor.fineActorIds?.includes(personId))?.entityId;
}

export function conductExternalPersonContact(
  state: SandboxGameState,
  speakerId: string,
  person: WorldEntity,
): { contact: ExternalPersonContact; knowledgeId: string } {
  const speaker = findAgent(state, speakerId);
  if (!speaker?.alive) throw new Error('Controlled person is unavailable.');
  if (!speaker.expeditionId || speaker.residence !== 'expedition') throw new Error('Direct outside-person contact requires a field-controlled expedition member.');
  if (person.kind !== 'individual') throw new Error('Direct person-to-person contact requires a projected individual.');
  if (state.agents.some((agent) => agent.id === person.id)) throw new Error('This person belongs to the player community, not an outside society.');
  const expedition = state.expeditions.find((entry) => entry.id === speaker.expeditionId && entry.memberIds.includes(speaker.id));
  if (!expedition) throw new Error('Controlled expedition context is unavailable.');
  if (!person.spatial || person.spatial.frameId !== expedition.position.frameId || Math.hypot(person.spatial.x-expedition.position.x, person.spatial.y-expedition.position.y, (person.spatial.z??0)-(expedition.position.z??0)) > 0.35) throw new Error('Direct outside-person contact requires physical proximity.');

  const societyEntityId = externalSocietyForPerson(state, person.id);
  const label = entityName(person);
  reserveDirectActivity(state, [speaker.id], 'conversation', 20, `Direct contact with outside individual ${label}.`, person.id);
  const knowledge = addObservedKnowledge(
    state,
    [speaker.id],
    [person.id, ...(societyEntityId ? [societyEntityId] : [])],
    `Direct contact occurred with ${label}, a provider-materialized outside individual.${societyEntityId ? ` The person was observed in association with ${societyEntityId}.` : ''}`,
    0.86,
    undefined,
    [...person.provenanceIds],
    { promoteToSettlement: false },
  );

  let contact = contactStore(state).find((entry) => entry.externalPersonId === person.id);
  if (!contact) {
    contact = {
      externalPersonId: person.id,
      name: label,
      ...(societyEntityId ? { societyEntityId } : {}),
      provenanceIds: [...person.provenanceIds],
      firstContactDay: state.clock.day,
      firstContactMinute: state.clock.minuteOfDay,
      lastContactDay: state.clock.day,
      lastContactMinute: state.clock.minuteOfDay,
      interactionCount: 0,
      speakerIds: [],
      knowledgeIds: [],
    };
    contactStore(state).push(contact);
  }
  contact.lastContactDay = state.clock.day;
  contact.lastContactMinute = state.clock.minuteOfDay;
  contact.interactionCount += 1;
  if (!contact.speakerIds.includes(speaker.id)) contact.speakerIds.push(speaker.id);
  if (!contact.knowledgeIds.includes(knowledge.id)) contact.knowledgeIds.push(knowledge.id);
  contact.provenanceIds = [...new Set([...contact.provenanceIds, ...person.provenanceIds])];

  speaker.memories.push({
    id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'social',
    text: `Spoke directly with ${label}.`, salience: 58, sourceIds: [person.id, knowledge.id],
  });
  if (speaker.memories.length > 80) speaker.memories.splice(0, speaker.memories.length - 80);

  const chronicle = {
    kind: 'external' as const,
    title: `Direct contact: ${label}`,
    text: `The contact record is anchored to provider individual ${person.id}; no hidden beliefs, motives or undisclosed World Truth were inferred from the encounter.`,
    entityIds: [speaker.id, person.id, ...(societyEntityId ? [societyEntityId] : [])],
  };
  if (speaker.expeditionId) addExpeditionChronicle(state, speaker.expeditionId, chronicle, { witnessedByAgentIds: expedition.memberIds, reportableToSettlement: true });
  else addChronicle(state, chronicle);
  return { contact, knowledgeId: knowledge.id };
}
