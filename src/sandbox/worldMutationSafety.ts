import type { WorldManifest, WorldProvider } from '../worldbridge/contract.js';
import type { SandboxGameState } from './types.js';

export class ProviderMutationUncertainError extends Error {
  readonly providerMayHaveMutated = true;
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderMutationUncertainError';
    this.cause = cause;
  }
}

export function isProviderMutationUncertainError(error: unknown): error is ProviderMutationUncertainError {
  return error instanceof ProviderMutationUncertainError || Boolean(error && typeof error === 'object' && (error as { providerMayHaveMutated?: unknown }).providerMayHaveMutated === true);
}

export function restoreSandboxState(target: SandboxGameState, committed: SandboxGameState): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, structuredClone(committed) as unknown as Record<string, unknown>);
}

export function assertImportedSaveProviderCompatible(state: SandboxGameState, manifest: WorldManifest): void {
  if (state.world.manifest.contractVersion !== manifest.contractVersion || state.world.providerRecipeId !== manifest.recipeId) {
    throw new Error('Save WorldProvider identity does not match the active provider.');
  }
}

export function assertProviderManifestAligned(state: SandboxGameState, manifest: WorldManifest): void {
  if (manifest.contractVersion !== state.world.manifest.contractVersion || manifest.recipeId !== state.world.providerRecipeId || manifest.engineVersion !== state.world.providerEngineVersion) {
    throw new ProviderMutationUncertainError(`WorldProvider identity changed during a game mutation: ${manifest.recipeId}@${manifest.engineVersion}.`);
  }
  if (manifest.currentTick !== state.clock.worldTick) {
    throw new ProviderMutationUncertainError(`WorldProvider/game clock divergence after mutation: provider ${manifest.currentTick}, game ${state.clock.worldTick}.`);
  }
  if (state.world.providerSnapshot.manifest.currentTick !== state.clock.worldTick) {
    throw new ProviderMutationUncertainError(`Committed provider snapshot/game clock divergence: snapshot ${state.world.providerSnapshot.manifest.currentTick}, game ${state.clock.worldTick}.`);
  }
}

export async function assertProviderAligned(provider: WorldProvider, state: SandboxGameState): Promise<void> {
  assertProviderManifestAligned(state, await provider.getManifest());
}
