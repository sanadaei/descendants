import { addChronicle } from './stateUtils.js';
import type { SandboxGameState } from './types.js';

export function registerGeneratedEnding(state: SandboxGameState, endingId: string, description: string, entityIds: string[] = []): void {
  if (state.generatedEndings.includes(endingId)) return;
  state.generatedEndings.push(endingId);
  state.status = 'post-ending';
  addChronicle(state, { kind: 'ending', title: `Generated ending: ${endingId}`, text: `${description} Simulation continuation remains enabled.`, entityIds });
}
