import type { WorldProvider, WorldSnapshot } from '../../worldbridge/contract.js';
import type { SandboxGameState } from '../types.js';
import { type PrimaryViewId } from '../uiNavigation.js';

export const esc = (value: unknown): string => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);

export type ViewId = PrimaryViewId;

export type PdaTab = 'task'|'map'|'body'|'knowledge'|'inventory'|'chronicle'|'residents'|'system';

export type PdaTaskPanel = 'overview'|'expedition';

export type IncidentResponseDensity = 'standard'|'compact';

export const PDA_TABS: Array<[PdaTab, string, string]> = [
  ['task','行動','F1'],['map','地図',''],['body','身体','F2'],['knowledge','知識','F3'],
  ['inventory','所持品','F4'],['chronicle','年代記','F5'],['residents','住民',''],['system','システム','F10'],
];

export function authorityLabel(value: string | undefined): string {
  if (value === 'provider-projected') return 'ORIGIN RECORD';
  if (value === 'lived-game-state') return 'LOCAL HISTORY';
  return 'LOCAL INTERPRETATION';
}

export function knowledgeSourceLabel(entry: SandboxGameState['knowledge'][number]): string {
  if (entry.sourceWorldKnowledgeId) return 'OUTSIDE OBSERVATION RECORD · UNCONFIRMED BEYOND EVIDENCE';
  if (entry.physicalEvidenceSourceEntityId && entry.sourceKnowledgeId) return 'LOCAL RESEARCH FROM PHYSICAL / OBSERVED EVIDENCE';
  if (entry.physicalEvidenceSourceEntityId) return 'DIRECT FIELD OBSERVATION / PHYSICAL EVIDENCE';
  if (entry.sourceKnowledgeId) return 'LOCAL INFERENCE / RESEARCH';
  if (entry.carrier === 'record' || entry.carrier === 'institution') return 'LIVED RECORD / INSTITUTION';
  return 'LIVED MEMORY / ORAL TRANSMISSION';
}

export function incidentMinuteLabel(totalMinutes: number | undefined): string {
  if (totalMinutes === undefined || !Number.isFinite(totalMinutes)) return '—';
  const minute = Math.max(0, Math.floor(totalMinutes));
  const day = Math.floor(minute / 1440) + 1;
  const minuteOfDay = minute % 1440;
  return `D${day} ${String(Math.floor(minuteOfDay / 60)).padStart(2,'0')}:${String(minuteOfDay % 60).padStart(2,'0')}`;
}

export function compactText(value: string, maxChars = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function compactSubjectIds(ids: string[], visible = 5): string {
  if (!ids.length) return 'no explicit subject IDs';
  const head = ids.slice(0, visible).join(', ');
  return ids.length > visible ? `${head} · +${ids.length - visible} more` : head;
}

export function pdaKnowledgeClaimLabel(claim: string): string {
  const reviewPrefix = 'Local research provisionally reviews the available evidence: ';
  if (claim.startsWith(reviewPrefix)) return compactText(`証拠の検討: ${pdaKnowledgeClaimLabel(claim.slice(reviewPrefix.length))}`, 132);
  const normalized = claim.replace(/\s+/g, ' ').trim();
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return compactText(normalized, 132);
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const interpretation = typeof parsed.interpretation === 'string' ? parsed.interpretation : '';
    const labels: Record<string, string> = {
      'cartographic-estimate': '地図推定',
      'transmitted-trace-report': '伝達痕跡',
      'contested-transmitted-trace': '競合する伝達痕跡',
    };
    const parts: string[] = [];
    if (interpretation) parts.push(labels[interpretation] ?? interpretation);
    for (const key of ['regionId','historicalTraceId','traceType','assertedOriginClass']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) parts.push(value);
    }
    const center = parsed.estimatedCenter;
    if (center && typeof center === 'object') {
      const point = center as Record<string, unknown>;
      if (typeof point.x === 'number' && typeof point.y === 'number') parts.push(`中心 ${point.x.toFixed(1)}, ${point.y.toFixed(1)}`);
    }
    if (typeof parsed.uncertaintyRadiusKm === 'number' && Number.isFinite(parsed.uncertaintyRadiusKm)) parts.push(`誤差半径 ${parsed.uncertaintyRadiusKm.toFixed(1)} km`);
    if (parts.length) return compactText(parts.join(' · '), 132);
  } catch { /* preserve non-JSON or malformed evidence verbatim */ }
  return compactText(normalized, 132);
}

export function knowledgeEvidenceDisclosure(entry: SandboxGameState['knowledge'][number]): string {
  const longClaim = entry.claim.replace(/\s+/g, ' ').trim().length > 180;
  const manySubjects = entry.subjectIds.length > 5;
  if (!longClaim && !manySubjects) return '';
  return `<details class="knowledge-evidence-details"><summary>Full evidence payload · ${entry.subjectIds.length} subject${entry.subjectIds.length===1?'':'s'}</summary><div><strong>Claim</strong><p>${esc(entry.claim)}</p><strong>Subject IDs</strong><p>${esc(entry.subjectIds.join(', ') || 'none')}</p></div></details>`;
}

export const A11Y_STORAGE_KEY = 'descendants.sandbox.accessibility.v1';

export type SandboxAccessibility = { textScale: 1 | 1.25 | 1.5; highContrast: boolean; reduceMotion: boolean };

export function loadAccessibility(): SandboxAccessibility {
  const fallback: SandboxAccessibility = { textScale: 1, highContrast: false, reduceMotion: typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false };
  try {
    const raw = window.localStorage.getItem(A11Y_STORAGE_KEY); if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SandboxAccessibility>;
    return { textScale: parsed.textScale === 1.25 || parsed.textScale === 1.5 ? parsed.textScale : 1, highContrast: parsed.highContrast === true, reduceMotion: parsed.reduceMotion ?? fallback.reduceMotion };
  } catch { return fallback; }
}

export function storeAccessibility(value: SandboxAccessibility): void { try { window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(value)); } catch { /* presentation settings may be ephemeral */ } }

export const PDA_PRESENTATION_STORAGE_KEY = 'descendants.pda.presentation.v1';

export type PdaPresentation = { scanlines: boolean; flicker: boolean };

export function loadPdaPresentation(): PdaPresentation {
  try {
    const raw = window.localStorage.getItem(PDA_PRESENTATION_STORAGE_KEY);
    if (!raw) return { scanlines: true, flicker: true };
    const parsed = JSON.parse(raw) as Partial<PdaPresentation>;
    return { scanlines: parsed.scanlines !== false, flicker: parsed.flicker !== false };
  } catch { return { scanlines: true, flicker: true }; }
}

export function storePdaPresentation(value: PdaPresentation): void { try { window.localStorage.setItem(PDA_PRESENTATION_STORAGE_KEY, JSON.stringify(value)); } catch { /* presentation settings may be ephemeral */ } }

export interface SandboxAppOptions {
  startupNotices?: string[];
  persistenceMode?: 'durable' | 'volatile' | 'unavailable';
  providerMode?: 'real-worldgen' | 'snapshot-recovery' | 'mock-diagnostic';
  /** Reconstruct a clean provider from a committed provider snapshot after an uncertain mutation. */
  recoverProvider?: (snapshot: WorldSnapshot) => Promise<{ provider: WorldProvider; providerMode: 'real-worldgen' | 'snapshot-recovery' | 'mock-diagnostic' }>;
}
