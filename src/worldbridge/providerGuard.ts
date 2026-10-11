import type { WorldManifest, WorldProvider, WorldSnapshot } from './contract.js';

export const FROZEN_WORLD_CONTRACT_VERSION = '1.0.0' as const;

export interface WorldProviderAcceptance {
  manifest: WorldManifest;
  variableIds: Set<string>;
  capabilities: Set<string>;
}

export async function acceptWorldProvider(provider: WorldProvider): Promise<WorldProviderAcceptance> {
  const manifest = await provider.getManifest();
  if (manifest.contractVersion !== FROZEN_WORLD_CONTRACT_VERSION) {
    throw new Error(`WorldProvider contract mismatch: expected ${FROZEN_WORLD_CONTRACT_VERSION}, got ${manifest.contractVersion}`);
  }
  if (!Number.isFinite(manifest.currentTick) || manifest.currentTick < 0) {
    throw new Error(`WorldProvider returned invalid currentTick: ${manifest.currentTick}`);
  }
  if (!manifest.recipeId.trim() || !manifest.engineVersion.trim()) {
    throw new Error('WorldProvider manifest must include recipeId and engineVersion.');
  }
  const variableIds = new Set(manifest.variableDefinitions.map((definition) => definition.id));
  const capabilities = new Set(manifest.capabilities);
  return { manifest: structuredClone(manifest), variableIds, capabilities };
}

export function assertSnapshotIdentity(before: WorldSnapshot, after: WorldSnapshot): void {
  const beforeIds = new Map(before.entities.map((entity) => [entity.id, entity.provenanceIds.join('|')]));
  for (const entity of after.entities) {
    const provenance = beforeIds.get(entity.id);
    if (provenance !== undefined && provenance !== entity.provenanceIds.join('|')) {
      throw new Error(`World entity provenance changed for stable id ${entity.id}.`);
    }
  }
  const beforeCausal = new Set(before.causalRecords.map((record) => record.id));
  for (const knowledge of after.knowledge) {
    for (const truthId of knowledge.truthLinkIds ?? []) {
      if (!beforeCausal.has(truthId) && !after.causalRecords.some((record) => record.id === truthId)) {
        throw new Error(`Knowledge ${knowledge.id} references missing causal record ${truthId}.`);
      }
    }
  }
}
