import { addExpeditionChronicle, nextStateId } from './stateUtils.js';
import type { ExpeditionRendezvousRequest, ExpeditionState, SandboxGameState } from './types.js';

export function requestFieldRendezvous(state: SandboxGameState, expeditionId: string): ExpeditionRendezvousRequest {
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  if (!expedition || !['outbound','exploring','returning'].includes(expedition.status)) throw new Error('An active field expedition is required for a rendezvous request.');
  if (expedition.controlMode !== 'expedition') throw new Error('Direct rendezvous requests require expedition control.');
  const existing = expedition.rendezvousRequest;
  if (existing && ['pending-link','transmitted'].includes(existing.status)) return existing;
  const request: ExpeditionRendezvousRequest = {
    id: nextStateId(state, 'rendezvous'),
    status: expedition.communication === 'connected' ? 'transmitted' : 'pending-link',
    requestedDay: state.clock.day, requestedMinute: state.clock.minuteOfDay, requestedTick: state.clock.worldTick,
    communicationAtRequest: expedition.communication,
    requestedPosition: structuredClone(expedition.position),
    ...(expedition.communication === 'connected'
      ? { transmittedDay: state.clock.day, transmittedMinute: state.clock.minuteOfDay, verifiedPosition: structuredClone(expedition.position) }
      : {}),
  };
  expedition.rendezvousRequest = request;
  addExpeditionChronicle(state, expedition.id, {
    kind: 'expedition',
    title: request.status === 'transmitted' ? 'Field rendezvous request transmitted' : 'Field rendezvous request pending link',
    text: request.status === 'transmitted'
      ? `${expedition.id} transmitted a rendezvous/rescue request from a currently verified field position.`
      : `${expedition.id} prepared a rendezvous/rescue request, but current communication does not justify exposing the party's exact field position to the settlement.`,
    entityIds: [expedition.id, request.id],
  });
  return request;
}

export function promoteRendezvousRequestAfterVerifiedLink(state: SandboxGameState, expedition: ExpeditionState): void {
  const request = expedition.rendezvousRequest;
  if (!request || request.status !== 'pending-link' || expedition.communication !== 'connected') return;
  request.status = 'transmitted';
  request.transmittedDay = state.clock.day;
  request.transmittedMinute = state.clock.minuteOfDay;
  request.verifiedPosition = structuredClone(expedition.position);
  addExpeditionChronicle(state, expedition.id, {
    kind: 'expedition', title: 'Pending rendezvous request transmitted',
    text: `${expedition.id} regained a verified communication link. The rendezvous request now carries the party's position at transmission time; earlier hidden movement is not reconstructed.`,
    entityIds: [expedition.id, request.id],
  });
}

export function transmittedRendezvousPosition(expedition: ExpeditionState) {
  const request = expedition.rendezvousRequest;
  return request?.status === 'transmitted' && request.verifiedPosition ? structuredClone(request.verifiedPosition) : undefined;
}

export function resolveRendezvousRequest(expedition: ExpeditionState, resolution: string): void {
  const request = expedition.rendezvousRequest;
  if (!request || !['pending-link','transmitted'].includes(request.status)) return;
  request.status = 'resolved';
  request.resolution = resolution;
}
