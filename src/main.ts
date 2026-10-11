import type { SandboxGameState } from './sandbox/types.js';
import type { SandboxPersistenceMode, SandboxRepository } from './sandbox/storage.js';
import type { WorldProvider } from './worldbridge/contract.js';
import type { WorldClockPolicy } from './worldbridge/worldClock.js';

type ProviderMode = 'real-worldgen' | 'snapshot-recovery' | 'mock-diagnostic';
type RecoveryAction = { id: string; label: string; primary?: boolean };

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function recoveryChoice(root: HTMLElement, title: string, detail: string, actions: RecoveryAction[]): Promise<string> {
  root.replaceChildren();
  const main = document.createElement('main');
  main.className = 'bootstrap-recovery-screen';
  main.setAttribute('role', 'alert');
  main.innerHTML = `<p class="bootstrap-recovery-eyebrow">DESCENDANTS / SAFE STARTUP RECOVERY</p><h1></h1><p class="bootstrap-recovery-detail"></p><div class="bootstrap-recovery-actions"></div><p class="bootstrap-recovery-note">No persistent save is overwritten merely because startup failed.</p>`;
  const heading = main.querySelector('h1'); if (heading) heading.textContent = title;
  const paragraph = main.querySelector<HTMLElement>('.bootstrap-recovery-detail'); if (paragraph) paragraph.textContent = detail;
  const buttons = main.querySelector<HTMLElement>('.bootstrap-recovery-actions');
  root.append(main);
  return new Promise((resolve) => {
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = action.label; button.dataset.recoveryAction = action.id;
      if (action.primary) button.classList.add('primary');
      button.addEventListener('click', () => resolve(action.id), { once: true });
      buttons?.append(button);
    }
    buttons?.querySelector<HTMLButtonElement>('button')?.focus();
  });
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app が見つかりません。');
  const params = new URLSearchParams(window.location.search);
  const [{ SandboxApp }, storage, { createInitialSandboxState }, { MockWorldProvider }, { acceptWorldProvider }, { createRealWorldRuntime }, { SnapshotWorldProvider }] = await Promise.all([
    import('./sandbox/app.js'),
    import('./sandbox/storage.js'),
    import('./sandbox/bootstrap.js'),
    import('./worldbridge/mockWorldProvider.js'),
    import('./worldbridge/providerGuard.js'),
    import('./worldbridge/realWorldProvider.js'),
    import('./worldbridge/snapshotWorldProvider.js'),
  ]);

  let repository: SandboxRepository = storage.sandboxRepository;
  let state: SandboxGameState | null = null;
  const startupNotices: string[] = [];
  const useMockWorld = params.get('mockWorld') === '1';

  if (useMockWorld) {
    // Development/mock worlds must never overwrite the user's real generated-world slot.
    repository = storage.createVolatileSandboxRepository();
    startupNotices.push('Diagnostic mockWorld session: persistence is temporary and the production save slot is untouched.');
  } else {
    while (true) {
      const loaded = await repository.loadRecoverable();
      if (loaded.warning) startupNotices.push(loaded.warning);
      if (loaded.mode !== 'unavailable') { state = loaded.state; break; }
      const action = await recoveryChoice(root, 'Persistent storage unavailable', loaded.warning ?? 'IndexedDB could not be opened safely.', [
        { id: 'retry', label: 'Retry persistent storage', primary: true },
        { id: 'temporary', label: 'Start temporary session (do not modify save slot)' },
      ]);
      if (action === 'retry') continue;
      repository = storage.createVolatileSandboxRepository();
      startupNotices.push('Temporary volatile session selected because persistent storage was unavailable. Export manually before closing if you want to keep this session.');
      break;
    }
  }

  let provider: WorldProvider;
  let clockPolicy: WorldClockPolicy | undefined;
  let providerMode: ProviderMode = useMockWorld ? 'mock-diagnostic' : 'real-worldgen';

  if (useMockWorld) {
    provider = new MockWorldProvider();
  } else {
    while (true) {
      try {
        const runtime = await createRealWorldRuntime(state?.world.providerSnapshot ? { snapshot: state.world.providerSnapshot } : {});
        provider = runtime.provider; clockPolicy = runtime.clockPolicy; providerMode = 'real-worldgen';
        break;
      } catch (error) {
        const detail = `Worldgen runtime/provider load failed: ${errorText(error)}`;
        if (state?.world.providerSnapshot) {
          const action = await recoveryChoice(root, 'Generated-world provider unavailable', `${detail}\n\nA validated save snapshot is available. Snapshot recovery preserves the saved contract projection but does not simulate new setting-specific physical outcomes, so it runs in a temporary session.`, [
            { id: 'retry', label: 'Retry Worldgen assets', primary: true },
            { id: 'snapshot', label: 'Continue from saved snapshot (temporary recovery mode)' },
          ]);
          if (action === 'retry') continue;
          provider = new SnapshotWorldProvider(state.world.providerSnapshot);
          clockPolicy = state.clockPolicy;
          providerMode = 'snapshot-recovery';
          repository = storage.createVolatileSandboxRepository(state);
          startupNotices.push(`${detail} Continuing from the saved WorldProvider snapshot in volatile recovery mode; the durable save is protected from degraded-provider writes.`);
          break;
        }
        const action = await recoveryChoice(root, 'Generated-world provider unavailable', `${detail}\n\nNo validated provider snapshot is available for recovery.`, [
          { id: 'retry', label: 'Retry Worldgen assets', primary: true },
          { id: 'diagnostic', label: 'Start temporary diagnostic mock world' },
        ]);
        if (action === 'retry') continue;
        provider = new MockWorldProvider();
        providerMode = 'mock-diagnostic';
        repository = storage.createVolatileSandboxRepository();
        state = null;
        startupNotices.push(`${detail} A temporary diagnostic mock world was started; it cannot overwrite the production save slot.`);
        break;
      }
    }
  }

  let accepted = await acceptWorldProvider(provider);
  if (state && (state.world.manifest.contractVersion !== accepted.manifest.contractVersion || state.world.providerRecipeId !== accepted.manifest.recipeId || state.world.providerEngineVersion !== accepted.manifest.engineVersion || state.clock.worldTick !== accepted.manifest.currentTick)) {
    // Provider identity mismatch is not permission to silently discard a valid save.
    if (providerMode === 'real-worldgen') {
      const action = await recoveryChoice(root, 'Saved world and active provider do not match', `Save: ${state.world.providerRecipeId}@${state.world.providerEngineVersion} tick ${state.clock.worldTick}\nProvider: ${accepted.manifest.recipeId}@${accepted.manifest.engineVersion} tick ${accepted.manifest.currentTick}`, [
        { id: 'snapshot', label: 'Open saved snapshot in temporary recovery mode', primary: true },
        { id: 'temporary-new', label: 'Start a new temporary world' },
        { id: 'retry', label: 'Retry provider load' },
      ]);
      if (action === 'retry') { window.location.reload(); return; }
      if (action === 'snapshot') {
        provider = new SnapshotWorldProvider(state.world.providerSnapshot);
        clockPolicy = state.clockPolicy;
        providerMode = 'snapshot-recovery';
        repository = storage.createVolatileSandboxRepository(state);
        accepted = await acceptWorldProvider(provider);
        startupNotices.push('Provider identity mismatch: opened the saved snapshot in temporary recovery mode. The durable slot was not modified.');
      } else {
        repository = storage.createVolatileSandboxRepository(); state = null;
        startupNotices.push('Provider identity mismatch: started a new temporary generated world. The durable save slot was not modified.');
      }
    } else {
      repository = storage.createVolatileSandboxRepository(); state = null;
      startupNotices.push('Recovery provider identity did not match the save; switched to a fresh temporary session rather than overwriting persistent data.');
    }
  }

  if (!state) state = await createInitialSandboxState(provider, clockPolicy ? { clockPolicy } : {});
  try { await repository.save(state); }
  catch (error) {
    const failedMode: SandboxPersistenceMode = repository.mode;
    repository = storage.createVolatileSandboxRepository(state);
    await repository.save(state);
    startupNotices.push(`Initial persistence failed in ${failedMode} mode. The world is running in volatile memory and the durable slot was not replaced: ${errorText(error)}`);
  }

  new SandboxApp(root, provider, repository, state, {
    startupNotices, persistenceMode: repository.mode, providerMode,
    recoverProvider: async (snapshot) => {
      if (!useMockWorld) {
        try {
          const runtime = await createRealWorldRuntime({ snapshot });
          return { provider: runtime.provider, providerMode: 'real-worldgen' as const };
        } catch { /* Fall back to the frozen snapshot projection below. */ }
      }
      return { provider: new SnapshotWorldProvider(snapshot), providerMode: 'snapshot-recovery' as const };
    },
  });
}

bootstrap().catch(async (error: unknown) => {
  const root = document.getElementById('app');
  if (root) {
    const action = await recoveryChoice(root, 'Startup could not complete safely', errorText(error), [
      { id: 'retry', label: 'Retry startup', primary: true },
    ]);
    if (action === 'retry') window.location.reload();
  }
  console.error(error);
});
