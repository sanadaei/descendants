import type { SpatialRef, WorldEntity } from '../worldbridge/contract.js';
import type { KnowledgeEntry, SandboxGameState } from './types.js';

export interface KnownMapLocation {
  position?: SpatialRef;
  uncertaintyRadiusKm: number;
  estimated: boolean;
}

function claimPayload(entry: KnowledgeEntry): Record<string, unknown> | null {
  // Legacy provider claims are JSON. A research review may retain that exact payload in its text.
  const text = entry.claim.replace(/^Local research provisionally (?:supports|qualifies) the hypothesis: |^Local research provisionally reviews the available evidence: /, '');
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Map and navigation share observer knowledge; provider coordinates are never substituted for an estimate. */
export function knownMapLocation(state: SandboxGameState, observerId: string, entity: WorldEntity): KnownMapLocation {
  if (entity.id === state.world.originEntityId) return { position: structuredClone(state.settlement.position), uncertaintyRadiusKm: 0, estimated: false };
  const observer = state.agents.find((agent) => agent.id === observerId && agent.alive);
  if (!observer) return { uncertaintyRadiusKm: 0, estimated: false };
  const local = !observer.expeditionId && (!observer.residence || observer.residence === 'settlement');
  const accessible = state.knowledge.filter((entry) => !entry.lost && entry.subjectIds.includes(entity.id)
    && (observer.knowledgeIds.includes(entry.id) || (local && state.settlement.localKnowledgeIds.includes(entry.id))))
    .sort((a, b) => b.acquiredDay - a.acquiredDay || b.confidence - a.confidence || a.id.localeCompare(b.id));
  if (!accessible.length && !(local && state.externalActors.some((actor) => actor.entityId === entity.id))) {
    return { uncertaintyRadiusKm: 0, estimated: false };
  }
  const direct = accessible.find((entry) => entry.entityObservation?.entityId === entity.id && entry.entityObservation.position);
  if (direct?.entityObservation?.position) return { position: structuredClone(direct.entityObservation.position), uncertaintyRadiusKm: 0, estimated: false };
  const inquiry = (state.inquiries ?? []).slice().reverse().find((entry) => entry.targetEntityId === entity.id && accessible.some((evidence) => evidence.id === entry.knowledgeId));
  if (inquiry) return {position:structuredClone(inquiry.center),uncertaintyRadiusKm:inquiry.radiusKm,estimated:true};
  for (const entry of accessible) {
    const claim = claimPayload(entry);
    if (!claim && /^\s*\{/.test(entry.claim) && /"interpretation"\s*:\s*"cartographic-estimate"/.test(entry.claim)) return { uncertaintyRadiusKm: 0, estimated: true };
    if (claim?.interpretation !== 'cartographic-estimate' || claim.regionId !== entity.id) continue;
    const center = claim.estimatedCenter;
    const radius = claim.uncertaintyRadiusKm;
    if (!center || typeof center !== 'object' || Array.isArray(center) || typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || !entity.spatial) {
      return { uncertaintyRadiusKm: 0, estimated: true };
    }
    const point = center as Record<string, unknown>;
    if (typeof point.x !== 'number' || !Number.isFinite(point.x) || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
      return { uncertaintyRadiusKm: 0, estimated: true };
    }
    return {
      position: { frameId: entity.spatial.frameId, x: point.x, y: point.y, ...(entity.spatial.regionId ? { regionId: entity.spatial.regionId } : {}) },
      uncertaintyRadiusKm: radius, estimated: true,
    };
  }
  // Existing explicitly known locations retain their contract projection when no estimate is supplied.
  return { ...(entity.spatial ? { position: structuredClone(entity.spatial) } : {}), uncertaintyRadiusKm: 0, estimated: false };
}
