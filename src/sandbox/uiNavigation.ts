export const PRIMARY_VIEWS = ['exploration','body','knowledge','inventory','chronicle'] as const;
export type PrimaryViewId = typeof PRIMARY_VIEWS[number];

const FUNCTION_KEY_VIEW: Readonly<Record<string, PrimaryViewId>> = Object.freeze({
  F1: 'exploration', F2: 'body', F3: 'knowledge', F4: 'inventory', F5: 'chronicle',
});

const BUSY_SAFE_ACTIONS = new Set(['stop-continuity','view','inspect-agent','daily-detail','daily-morning-toggle','select-local-entity','select-world-entity','map-scope','a11y-scale','a11y-contrast','a11y-motion','export','export-recovery-report','export-quarantine']);

export function viewForFunctionKey(key: string): PrimaryViewId | undefined { return FUNCTION_KEY_VIEW[key]; }

export function movePrimaryView(current: PrimaryViewId, key: string): PrimaryViewId {
  const currentIndex = Math.max(0, PRIMARY_VIEWS.indexOf(current));
  if (key === 'Home') return PRIMARY_VIEWS[0]!;
  if (key === 'End') return PRIMARY_VIEWS[PRIMARY_VIEWS.length - 1]!;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return current;
  const offset = key === 'ArrowRight' ? 1 : -1;
  return PRIMARY_VIEWS[(currentIndex + offset + PRIMARY_VIEWS.length) % PRIMARY_VIEWS.length]!;
}

export function isBusySafeUiAction(action: string | undefined): boolean { return Boolean(action && BUSY_SAFE_ACTIONS.has(action)); }
