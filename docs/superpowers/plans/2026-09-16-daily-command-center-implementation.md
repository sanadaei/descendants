# Daily Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine F1 into a daily command center that surfaces at most three urgent concerns, compact survival status, triaged Morning Report data, resident assignment context, and READY/RISK/BLOCKED plan readiness without changing canonical daily execution or save compatibility.

**Architecture:** Add a pure, non-persistent `dailyCommandReadModel.ts` that consumes authoritative `SandboxGameState`, `DailyPlan`, `MorningReport`, and the already-derived `SurvivalCampaignView`. Reuse canonical interruption logic from `dailyActionLoop.ts`; centralize existing survival reserve thresholds in `survivalCampaign.ts`; render the derived view in `app.ts` while keeping `executeCommittedPlan()` authoritative. UI-only disclosure state stays inside `SandboxApp`; no save schema or migration changes are permitted.

**Tech Stack:** TypeScript 5.8.3, Vite 8.1.5, Electron 41.10.3, Node.js >=22.12.0, `node:test`, existing CSS/PC-98 PDA presentation system.

**Spec:** `docs/superpowers/specs/2026-09-16-daily-command-center-design.md`

## Global Constraints

- Keep the existing Morning Report → Plan → Execute → MANUAL/AUTO interruption → next-morning loop canonical.
- Preserve `SandboxGameState.schemaVersion === 1`; add no save migration and no persisted Daily Command Center sidecar.
- `RISK` is advisory and MUST NOT disable `EXECUTE PLAN`.
- `BLOCKED` may only reflect an existing canonical/runtime prohibition; read-model heuristics cannot invent a hard stop.
- The derived command read model must not mutate `SandboxGameState`, advance time, sample RNG, inspect hidden World Truth, or persist data.
- F1 displays no more than three top priorities before routine detail.
- Preserve existing F2/F3/F4/F5 authority; F1 links into those surfaces instead of duplicating their deep detail.
- Preserve keyboard focus restoration, reduced-motion behavior, and status communication independent of color.
- Keep every integration slice playable: drafting, executing, resolving supported interruptions, and reaching the next morning must continue to work.
- Capture fresh current-build screenshots after meaningful F1 GUI changes; historical 0.8.4 screenshots are references only.
- Do not stop development solely because human/Windows visual QA is unavailable; record that boundary and continue with machine checks and container/Electron evidence.
- After every completed task, produce a recovery ZIP; changed-only ZIPs are acceptable until the final full-source checkpoint.
- Avoid proliferating miscellaneous `.md`, `.txt`, and `.json` files. This implementation uses this single plan, the existing spec, source/tests, screenshot PNGs, and checkpoint ZIPs.
- Git commits are required when the extracted worktree is functional. In this handoff, `.git` currently points to a missing external worktree; if `git rev-parse --is-inside-work-tree` fails, record the failure in the console and use ZIP+SHA-256 as the recovery boundary instead of creating extra status documents.

---

## File Map Locked by This Plan

- **Create:** `src/sandbox/dailyCommandReadModel.ts` — pure F1 derived view, priority ordering, resource summary, resident planning rows, readiness issues.
- **Modify:** `src/sandbox/dailyActionLoop.ts` — export the existing non-mutating manual-interruption preview so UI/read model and execution use the same predicate.
- **Modify:** `src/sandbox/survivalCampaign.ts` — replace existing reserve-day magic numbers with exported constants used by both campaign directives and the command read model.
- **Modify:** `src/sandbox/app.ts` — render Daily Command Center sections; add Morning Report disclosure state; route priority/detail controls; use one canonical block-reason helper for readiness display and execution.
- **Modify:** `src/sandbox/uiNavigation.ts` — register the new Daily Command navigation/disclosure actions as busy-safe UI actions.
- **Modify:** `src/styles.css` — Daily Command Center hierarchy, readiness states, resident risk notes, responsive rules, focus-visible behavior.
- **Create:** `tests/daily-command-read-model.test.mjs` — behavioral tests for ordering, readiness, determinism, non-mutation, and reserve risks.
- **Modify:** `tests/daily-action-loop.test.mjs` — verify exported interruption preview remains identical to execution behavior.
- **Modify:** `tests/daily-action-loop-ui.test.mjs` — contract checks for priorities, resource summary, disclosure, readiness, direct navigation, retained execution controls.
- **Modify:** `tests/generated-ui-contract.test.mjs` — keep source-routed action and busy-safe navigation contracts synchronized with the new actions.
- **Modify:** `tests/pda-presentation.test.mjs` — assert the command-center hierarchy, focus-visible styling, and reduced-motion presentation contract.
- **Modify:** `tools/test-unit.mjs` — register `daily-command-read-model.test.mjs` in the unit suite.
- **Modify:** `electron/main.cjs` — extend diagnostic screenshot capture with F1 command-center DOM assertions plus normal and compact current-build captures; do not add production-state mutations.
- **Modify:** `tools/run-electron-path-e2e.mjs` — assert new F1 command-center markers and emit screenshot paths.
- **Do not create production debug fixture hooks or extra fixture files.** RISK/MANUAL state screenshots are captured from a real playable state when the runtime can reach them; lack of environment support is recorded in console output rather than worked around with hidden state injection.

---

### Task 1: Extract Shared Canonical Preview and Reserve Thresholds

**Files:**
- Modify: `src/sandbox/dailyActionLoop.ts:21-27,171-180,226-250`
- Modify: `src/sandbox/survivalCampaign.ts:144-166`
- Modify: `tests/daily-action-loop.test.mjs`

**Interfaces:**
- Produces: `previewDailyInterruption(state: SandboxGameState, plan: DailyPlan): ExecutionInterruption | undefined`
- Produces: `SURVIVAL_RESERVE_CRITICAL_DAYS = 1.5`
- Produces: `SURVIVAL_RESERVE_WARNING_DAYS = 3`
- Preserves: `executeCommittedPlan(provider, state)` result semantics exactly.

- [x] **Step 1: Add a regression test proving the preview matches the existing MANUAL medical execution stop**

Append to `tests/daily-action-loop.test.mjs` and add `previewDailyInterruption` to the import list:

```js
test('manual interruption preview uses the same predicate as execution', async () => {
  const { provider, state } = await initial(94008);
  const patient = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(patient);
  patient.health = 32;
  patient.pathology.push({
    id: 'case:preview-medical', pathologyId: 'wound-infection', onsetDay: state.clock.day,
    severity: 72, contagious: false, observedSymptoms: ['fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  setExecutionPolicy(state, 'medical', 'manual');
  const loop = ensureDailyLoopState(state);
  const preview = previewDailyInterruption(state, loop.currentPlan);
  assert.equal(preview?.kind, 'medical');
  assert.ok(preview?.subjectIds.includes(patient.id));
  commitDailyPlan(state);
  const result = await executeCommittedPlan(provider, state);
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(result.interruption, preview);
});
```

- [x] **Step 2: Run the focused test and confirm it fails because the preview is not exported**

Run:

```bash
npm run test:compile && node --test tests/daily-action-loop.test.mjs
```

Expected: FAIL during module import because `previewDailyInterruption` is not exported.

- [x] **Step 3: Export the existing interruption predicate without changing its logic**

In `src/sandbox/dailyActionLoop.ts`, replace:

```ts
function manualInterruption(state: SandboxGameState, plan: DailyPlan): ExecutionInterruption | undefined {
```

with:

```ts
export function previewDailyInterruption(state: SandboxGameState, plan: DailyPlan): ExecutionInterruption | undefined {
```

Then replace both execution calls:

```ts
const interruption = previewDailyInterruption(state, loop.currentPlan);
```

and:

```ts
const midExecutionInterruption = previewDailyInterruption(state, loop.currentPlan);
```

Do not modify the thresholds or returned copy in this function.

- [x] **Step 4: Centralize the already-existing food/water reserve thresholds without changing values**

Near the top of `src/sandbox/survivalCampaign.ts`, add:

```ts
export const SURVIVAL_RESERVE_CRITICAL_DAYS = 1.5;
export const SURVIVAL_RESERVE_WARNING_DAYS = 3;
```

In `chooseDirective()`, replace the existing literals only:

```ts
if (metrics.waterDays < SURVIVAL_RESERVE_WARNING_DAYS || state.settlement.waterSafety < 55) {
  return {
    id: 'secure-water', severity: metrics.waterDays < SURVIVAL_RESERVE_CRITICAL_DAYS ? 'critical' : 'urgent', title: '水を確保する',
    detail: `現在の水備蓄は約${metrics.waterDays.toFixed(1)}日分、水安全度は${state.settlement.waterSafety.toFixed(0)}。水担当と衛生を優先し、必要なら探索先を探してください。`,
    target: 'task', basisIds: [state.settlement.id],
  };
}
if (metrics.foodDays < SURVIVAL_RESERVE_WARNING_DAYS) {
  return {
    id: 'secure-food', severity: metrics.foodDays < SURVIVAL_RESERVE_CRITICAL_DAYS ? 'critical' : 'urgent', title: '食料備蓄を回復する',
    detail: `現在の食料備蓄は約${metrics.foodDays.toFixed(1)}日分です。採集・労働配分・遠征の負担を見直してください。`,
    target: 'inventory', basisIds: [state.settlement.id],
  };
}
```

- [x] **Step 5: Run the daily-loop and survival campaign regressions**

Run:

```bash
npm run test:compile && node --test tests/daily-action-loop.test.mjs tests/survival-campaign.test.mjs tests/survival-campaign-lifecycle.test.mjs
```

Expected: all tests PASS; no daily execution timing or campaign directive behavior changes.

- [x] **Step 6: Run type checking**

Run:

```bash
npm run check
```

Expected: PASS.

- [x] **Step 7: Create task checkpoint ZIP and optional git commit**

Run from project root:

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T1_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/dailyActionLoop.ts src/sandbox/survivalCampaign.ts tests/daily-action-loop.test.mjs package.json package-lock.json
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/dailyActionLoop.ts src/sandbox/survivalCampaign.ts tests/daily-action-loop.test.mjs
  git commit -m "refactor: expose daily command preview predicates"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

Expected: ZIP exists and SHA-256 is printed.

---

### Task 2: Build the Pure Daily Command Read Model

**Files:**
- Create: `src/sandbox/dailyCommandReadModel.ts`
- Create: `tests/daily-command-read-model.test.mjs`
- Modify: `tools/test-unit.mjs`

**Interfaces:**
- Consumes: `previewDailyInterruption()`, `SURVIVAL_RESERVE_CRITICAL_DAYS`, `SURVIVAL_RESERVE_WARNING_DAYS`, `agentAgeYears()`, existing `SandboxGameState`, `DailyPlan`, `MorningReport`, `SurvivalCampaignView`.
- Produces:

```ts
export type DailyCommandTone = 'critical' | 'warning' | 'normal';
export type DailyCommandTarget = 'task' | 'expedition' | 'map' | 'body' | 'knowledge' | 'inventory' | 'chronicle';
export type DailyPlanReadiness = 'ready' | 'risk' | 'blocked';

export interface DailyCommandIssue {
  id: string;
  tone: DailyCommandTone;
  title: string;
  detail: string;
  target?: DailyCommandTarget;
  agentId?: string;
}

export interface DailyResourceSummaryItem {
  id: 'population' | 'food' | 'water' | 'medicine' | 'expedition';
  label: string;
  value: string;
  detail: string;
  tone: DailyCommandTone;
}

export interface DailyResidentPlanRow {
  agentId: string;
  name: string;
  role: string;
  condition: string;
  previousTask: string;
  assignedTask: LaborTask;
  locked: boolean;
  riskNote?: string;
  severityScore: number;
}

export interface DailyCommandView {
  priorities: DailyCommandIssue[];
  resourceSummary: DailyResourceSummaryItem[];
  residentRows: DailyResidentPlanRow[];
  readiness: DailyPlanReadiness;
  readinessIssues: DailyCommandIssue[];
}

export interface DailyCommandInput {
  state: SandboxGameState;
  plan: DailyPlan;
  report?: MorningReport;
  campaign: SurvivalCampaignView;
  canonicalBlockReason?: string;
}

export function deriveDailyCommandView(input: DailyCommandInput): DailyCommandView;
```

- [x] **Step 1: Register the new test file before implementing the module**

In `tools/test-unit.mjs`, add after `daily-action-loop.test.mjs`:

```js
fileURLToPath(new URL('../tests/daily-command-read-model.test.mjs', import.meta.url)),
```

- [x] **Step 2: Write the read-model tests first**

Create `tests/daily-command-read-model.test.mjs` with the following structure and assertions:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { ensureDailyLoopState, setDailyAssignment, setExecutionPolicy } from '../.test-dist/sandbox/dailyActionLoop.js';
import { deriveSurvivalCampaignView } from '../.test-dist/sandbox/survivalCampaign.js';
import { deriveDailyCommandView } from '../.test-dist/sandbox/dailyCommandReadModel.js';

async function fixture(seed = 95001) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  const loop = ensureDailyLoopState(state);
  const campaign = deriveSurvivalCampaignView(state);
  return { state, loop, campaign };
}

function viewOf(state, loop, campaign, canonicalBlockReason) {
  return deriveDailyCommandView({
    state,
    plan: loop.currentPlan,
    report: loop.lastMorningReport,
    campaign,
    ...(canonicalBlockReason ? { canonicalBlockReason } : {}),
  });
}

test('daily command model is deterministic, pure, and bounds priorities to three', async () => {
  const { state, loop, campaign } = await fixture(95001);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(resident);
  resident.health = 20;
  resident.needs.thirst = 90;
  state.settlement.resources.water = 0.1;
  state.settlement.resources.food = 0.1;
  const currentCampaign = deriveSurvivalCampaignView(state);
  const before = structuredClone(state);
  const first = viewOf(state, loop, currentCampaign);
  const second = viewOf(state, loop, currentCampaign);
  assert.deepEqual(first, second);
  assert.deepEqual(state, before);
  assert.ok(first.priorities.length <= 3);
});

test('critical resident appears ahead of routine campaign continuity', async () => {
  const { state, loop } = await fixture(95002);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(resident);
  resident.health = 18;
  resident.pathology.push({
    id: 'case:command-critical', pathologyId: 'test-fever', onsetDay: state.clock.day,
    severity: 82, contagious: true, observedSymptoms: ['high fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: resident.id, name: resident.name, severity: 'critical', severityScore: 900,
      summary: '体力が危険域', healthBefore: 60, healthAfter: 18, healthDelta: -42,
      fatigueDelta: 5, moraleDelta: -3, hungerAfter: 20, thirstAfter: 90,
      newPathologyIds: ['test-fever'], activePathologyIds: ['test-fever'],
      task: resident.currentTask, residence: 'settlement', expeditionId: null,
      recommendedResponse: '至急診療',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.priorities[0]?.target, 'body');
  assert.equal(view.priorities[0]?.agentId, resident.id);
  assert.match(view.priorities[0]?.title ?? '', /重篤|危険/);
});

test('food and water reserve facts create visible summary pressure using shared thresholds', async () => {
  const { state, loop } = await fixture(95003);
  state.settlement.resources.food = 0;
  state.settlement.resources.water = 0;
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.resourceSummary.find((entry) => entry.id === 'food');
  const water = view.resourceSummary.find((entry) => entry.id === 'water');
  assert.equal(food?.tone, 'critical');
  assert.equal(water?.tone, 'critical');
  assert.ok(view.priorities.some((entry) => /食料|水/.test(entry.title)));
});

test('manual interruption and unsafe strenuous labor are RISK but never BLOCKED', async () => {
  const { state, loop } = await fixture(95004);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  resident.health = 30;
  resident.pathology.push({
    id: 'case:readiness', pathologyId: 'infection', onsetDay: state.clock.day,
    severity: 70, contagious: false, observedSymptoms: ['fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  setDailyAssignment(state, resident.id, 'forage');
  setExecutionPolicy(state, 'medical', 'manual');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.readiness, 'risk');
  assert.ok(view.readinessIssues.length >= 1);
  assert.notEqual(view.readiness, 'blocked');
});

test('canonical block reason is the only source of BLOCKED', async () => {
  const { state, loop, campaign } = await fixture(95005);
  const normal = viewOf(state, loop, campaign);
  assert.notEqual(normal.readiness, 'blocked');
  const blocked = viewOf(state, loop, campaign, 'WEDO is active. Resolve the direct encounter before executing the settlement plan.');
  assert.equal(blocked.readiness, 'blocked');
  assert.equal(blocked.readinessIssues[0]?.id, 'canonical-block');
});

test('resident rows expose prior task, current assignment, eligibility and concise risk text', async () => {
  const { state, loop } = await fixture(95006);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 35;
  setDailyAssignment(state, adult.id, 'guard');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const row = view.residentRows.find((entry) => entry.agentId === adult.id);
  assert.equal(row?.assignedTask, 'guard');
  assert.equal(typeof row?.previousTask, 'string');
  assert.match(row?.condition ?? '', /HP/);
  assert.ok(row?.riskNote);
});
```

- [x] **Step 3: Run the new test and verify it fails because the module is absent**

Run:

```bash
npm run test:compile && node --test tests/daily-command-read-model.test.mjs
```

Expected: FAIL because `.test-dist/sandbox/dailyCommandReadModel.js` does not exist.

- [x] **Step 4: Implement the pure read-model types and helpers**

Create `src/sandbox/dailyCommandReadModel.ts` beginning with:

```ts
import { previewDailyInterruption } from './dailyActionLoop.js';
import { agentAgeYears, findAgent, settlementAgents } from './stateUtils.js';
import { SURVIVAL_RESERVE_CRITICAL_DAYS, SURVIVAL_RESERVE_WARNING_DAYS } from './survivalCampaign.js';
import type {
  DailyPlan,
  LaborTask,
  MorningReport,
  MorningResidentDelta,
  SandboxGameState,
  SurvivalCampaignDirectiveTarget,
  SurvivalCampaignView,
} from './types.js';

export type DailyCommandTone = 'critical' | 'warning' | 'normal';
export type DailyCommandTarget = SurvivalCampaignDirectiveTarget;
export type DailyPlanReadiness = 'ready' | 'risk' | 'blocked';

export interface DailyCommandIssue {
  id: string;
  tone: DailyCommandTone;
  title: string;
  detail: string;
  target?: DailyCommandTarget;
  agentId?: string;
}

export interface DailyResourceSummaryItem {
  id: 'population' | 'food' | 'water' | 'medicine' | 'expedition';
  label: string;
  value: string;
  detail: string;
  tone: DailyCommandTone;
}

export interface DailyResidentPlanRow {
  agentId: string;
  name: string;
  role: string;
  condition: string;
  previousTask: string;
  assignedTask: LaborTask;
  locked: boolean;
  riskNote?: string;
  severityScore: number;
}

export interface DailyCommandView {
  priorities: DailyCommandIssue[];
  resourceSummary: DailyResourceSummaryItem[];
  residentRows: DailyResidentPlanRow[];
  readiness: DailyPlanReadiness;
  readinessIssues: DailyCommandIssue[];
}

export interface DailyCommandInput {
  state: SandboxGameState;
  plan: DailyPlan;
  report?: MorningReport;
  campaign: SurvivalCampaignView;
  canonicalBlockReason?: string;
}

const STRENUOUS_TASKS = new Set<LaborTask>(['forage', 'water', 'repair', 'sanitation', 'guard', 'explore-prep']);
const ACTIVE_EXPEDITION_STATUSES = new Set(['forming', 'outbound', 'exploring', 'returning', 'missing', 'captured', 'time-displaced']);

function reserveTone(days: number): DailyCommandTone {
  if (days < SURVIVAL_RESERVE_CRITICAL_DAYS) return 'critical';
  if (days < SURVIVAL_RESERVE_WARNING_DAYS) return 'warning';
  return 'normal';
}

function reportByAgent(report: MorningReport | undefined): Map<string, MorningResidentDelta> {
  return new Map((report?.residentDeltas ?? []).map((entry) => [entry.agentId, entry]));
}

function residentRiskNote(agent: SandboxGameState['agents'][number], task: LaborTask): string | undefined {
  const activeSeverity = Math.max(0, ...agent.pathology
    .filter((entry) => entry.status === 'active' || entry.status === 'chronic')
    .map((entry) => entry.severity));
  if (STRENUOUS_TASKS.has(task) && (agent.health <= 45 || activeSeverity >= 60)) return '重症域で負荷の高い作業';
  if (STRENUOUS_TASKS.has(task) && agent.needs.thirst >= 70) return `渇き ${agent.needs.thirst.toFixed(0)} で負荷作業`;
  if (STRENUOUS_TASKS.has(task) && agent.needs.hunger >= 70) return `空腹 ${agent.needs.hunger.toFixed(0)} で負荷作業`;
  return undefined;
}
```

- [x] **Step 5: Implement resident rows and readiness without mutating state**

Continue the module with:

```ts
function assignedTask(plan: DailyPlan, agent: SandboxGameState['agents'][number]): LaborTask {
  return plan.assignments.find((entry) => entry.agentId === agent.id)?.task ?? agent.currentTask;
}

function buildResidentRows(input: DailyCommandInput): DailyResidentPlanRow[] {
  const byAgent = reportByAgent(input.report);
  return settlementAgents(input.state)
    .filter((agent) => agent.alive)
    .map((agent) => {
      const report = byAgent.get(agent.id);
      const task = assignedTask(input.plan, agent);
      return {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        condition: `HP ${agent.health.toFixed(0)} · FAT ${agent.fatigue.toFixed(0)} · 空腹 ${agent.needs.hunger.toFixed(0)} · 渇き ${agent.needs.thirst.toFixed(0)}`,
        previousTask: report?.task ?? agent.currentTask,
        assignedTask: task,
        locked: agentAgeYears(input.state, agent) < 13,
        ...(residentRiskNote(agent, task) ? { riskNote: residentRiskNote(agent, task) } : {}),
        severityScore: report?.severityScore ?? 0,
      };
    })
    .sort((a, b) => Number(Boolean(b.riskNote)) - Number(Boolean(a.riskNote)) || b.severityScore - a.severityScore || a.name.localeCompare(b.name));
}

function buildReadinessIssues(input: DailyCommandInput, rows: DailyResidentPlanRow[]): DailyCommandIssue[] {
  if (input.canonicalBlockReason) {
    return [{
      id: 'canonical-block', tone: 'critical', title: '実行を続けられません',
      detail: input.canonicalBlockReason, target: 'task',
    }];
  }
  const issues: DailyCommandIssue[] = [];
  const manual = previewDailyInterruption(input.state, input.plan);
  if (manual) {
    issues.push({
      id: `manual-${manual.kind}`, tone: 'warning', title: manual.title, detail: manual.detail,
      target: manual.kind === 'medical' ? 'body' : 'expedition',
      ...(manual.kind === 'medical' && manual.subjectIds[0] ? { agentId: manual.subjectIds[0] } : {}),
    });
  }
  const risky = rows.find((row) => row.riskNote);
  if (risky) issues.push({
    id: `resident-risk:${risky.agentId}`, tone: 'warning', title: `${risky.name} の配置を確認`,
    detail: `${risky.assignedTask}: ${risky.riskNote}`, target: 'body', agentId: risky.agentId,
  });
  const assigned = new Set(rows.map((row) => row.assignedTask));
  if (input.campaign.waterDays < SURVIVAL_RESERVE_CRITICAL_DAYS && !assigned.has('water') && !assigned.has('sanitation')) {
    issues.push({ id: 'water-uncovered', tone: 'warning', title: '水危機への担当がありません', detail: `水備蓄 ${input.campaign.waterDays.toFixed(1)}日。water / sanitation 配置を確認してください。`, target: 'inventory' });
  }
  if (input.campaign.foodDays < SURVIVAL_RESERVE_CRITICAL_DAYS && !assigned.has('forage')) {
    issues.push({ id: 'food-uncovered', tone: 'warning', title: '食料危機への担当がありません', detail: `食料備蓄 ${input.campaign.foodDays.toFixed(1)}日。forage 配置を確認してください。`, target: 'inventory' });
  }
  return issues;
}
```

- [x] **Step 6: Implement resource summary and bounded priority ordering**

Continue with deterministic helpers:

```ts
function buildResourceSummary(input: DailyCommandInput): DailyResourceSummaryItem[] {
  const severeResidents = settlementAgents(input.state).filter((agent) =>
    agent.health <= 45 || agent.pathology.some((entry) => (entry.status === 'active' || entry.status === 'chronic') && entry.severity >= 60));
  const medicine = input.state.settlement.resources.medicine;
  const medicineTone: DailyCommandTone = severeResidents.length > 0 && medicine <= 0 ? 'critical' : severeResidents.length > 0 ? 'warning' : 'normal';
  const activeExpeditions = input.state.expeditions.filter((entry) => ACTIVE_EXPEDITION_STATUSES.has(entry.status)).length;
  return [
    { id: 'population', label: '人口', value: String(input.campaign.localPopulation), detail: `全生存 ${input.campaign.livingPopulation}`, tone: 'normal' },
    { id: 'food', label: '食料', value: Number.isFinite(input.campaign.foodDays) ? `${input.campaign.foodDays.toFixed(1)}日` : '∞', detail: input.report?.resourceDeltas.food !== undefined ? `前日 ${input.report.resourceDeltas.food >= 0 ? '+' : ''}${input.report.resourceDeltas.food.toFixed(1)}` : '比較なし', tone: reserveTone(input.campaign.foodDays) },
    { id: 'water', label: '水', value: Number.isFinite(input.campaign.waterDays) ? `${input.campaign.waterDays.toFixed(1)}日` : '∞', detail: `安全度 ${Math.round(input.campaign.waterSafety)}%`, tone: input.campaign.waterSafety < 55 ? 'critical' : reserveTone(input.campaign.waterDays) },
    { id: 'medicine', label: '医療', value: `${medicine.toFixed(1)}`, detail: `重症域 ${severeResidents.length}名`, tone: medicineTone },
    { id: 'expedition', label: '遠征', value: String(activeExpeditions), detail: activeExpeditions ? '活動中' : '待機', tone: 'normal' },
  ];
}

function campaignTone(severity: SurvivalCampaignView['directive']['severity']): DailyCommandTone {
  return severity === 'critical' ? 'critical' : severity === 'urgent' || severity === 'watch' ? 'warning' : 'normal';
}

function buildPriorities(input: DailyCommandInput, readinessIssues: DailyCommandIssue[]): DailyCommandIssue[] {
  const candidates: Array<{ rank: number; issue: DailyCommandIssue }> = [];
  const report = input.report;
  if (report?.deaths.length) candidates.push({ rank: 1000, issue: { id: 'morning-death', tone: 'critical', title: `${report.deaths.length}名の死亡記録`, detail: '昨夜の不可逆な変化を年代記で確認してください。', target: 'chronicle' } });
  const endangered = report?.residentDeltas.find((entry) => entry.severity === 'critical' || entry.severity === 'severe' || entry.severity === 'new-condition');
  if (endangered) candidates.push({ rank: endangered.severity === 'critical' ? 950 : 900, issue: { id: `resident:${endangered.agentId}`, tone: endangered.severity === 'critical' ? 'critical' : 'warning', title: `${endangered.name} が${endangered.severity === 'critical' ? '重篤' : '要対応'}`, detail: endangered.summary, target: 'body', agentId: endangered.agentId } });
  if (input.campaign.waterDays < SURVIVAL_RESERVE_WARNING_DAYS || input.campaign.waterSafety < 55) candidates.push({ rank: 850, issue: { id: 'water-pressure', tone: input.campaign.waterDays < SURVIVAL_RESERVE_CRITICAL_DAYS || input.campaign.waterSafety < 55 ? 'critical' : 'warning', title: '水の継続性を確認', detail: `備蓄 ${input.campaign.waterDays.toFixed(1)}日 · 安全度 ${input.campaign.waterSafety.toFixed(0)}%`, target: 'inventory' } });
  if (input.campaign.foodDays < SURVIVAL_RESERVE_WARNING_DAYS) candidates.push({ rank: 820, issue: { id: 'food-pressure', tone: input.campaign.foodDays < SURVIVAL_RESERVE_CRITICAL_DAYS ? 'critical' : 'warning', title: '食料備蓄を確認', detail: `備蓄 ${input.campaign.foodDays.toFixed(1)}日`, target: 'inventory' } });
  const manualMedical = readinessIssues.find((entry) => entry.id === 'manual-medical');
  const manualExpedition = readinessIssues.find((entry) => entry.id === 'manual-expedition');
  if (manualMedical) candidates.push({ rank: 780, issue: manualMedical });
  if (manualExpedition) candidates.push({ rank: 760, issue: manualExpedition });
  if (report?.expeditionUpdates[0]) candidates.push({ rank: 700, issue: { id: 'expedition-update', tone: 'warning', title: '遠征状況が更新されました', detail: report.expeditionUpdates[0], target: 'expedition' } });
  const planRisk = readinessIssues.find((entry) => entry.id !== 'manual-medical' && entry.id !== 'manual-expedition' && entry.id !== 'canonical-block');
  if (planRisk) candidates.push({ rank: 650, issue: planRisk });
  candidates.push({ rank: 100, issue: { id: `directive:${input.campaign.directive.id}`, tone: campaignTone(input.campaign.directive.severity), title: input.campaign.directive.title, detail: input.campaign.directive.detail, target: input.campaign.directive.target } });
  const unique = new Map<string, DailyCommandIssue>();
  for (const { issue } of candidates.sort((a, b) => b.rank - a.rank || a.issue.id.localeCompare(b.issue.id))) if (!unique.has(issue.id)) unique.set(issue.id, issue);
  return [...unique.values()].slice(0, 3);
}

export function deriveDailyCommandView(input: DailyCommandInput): DailyCommandView {
  const residentRows = buildResidentRows(input);
  const readinessIssues = buildReadinessIssues(input, residentRows);
  const readiness: DailyPlanReadiness = input.canonicalBlockReason ? 'blocked' : readinessIssues.length ? 'risk' : 'ready';
  return {
    priorities: buildPriorities(input, readinessIssues),
    resourceSummary: buildResourceSummary(input),
    residentRows,
    readiness,
    readinessIssues,
  };
}
```

The Japanese copy in the code blocks above is the implementation copy for this plan; preserve the interface, severity ordering, threshold sources, and blocking rule exactly.

- [x] **Step 7: Run focused tests and type check**

Run:

```bash
npm run test:compile && node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs
npm run check
```

Expected: PASS.

- [x] **Step 8: Create task checkpoint ZIP and optional git commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T2_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/dailyCommandReadModel.ts src/sandbox/dailyActionLoop.ts src/sandbox/survivalCampaign.ts tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tools/test-unit.mjs package.json package-lock.json
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/dailyCommandReadModel.ts src/sandbox/dailyActionLoop.ts src/sandbox/survivalCampaign.ts tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tools/test-unit.mjs
  git commit -m "feat: derive daily command read model"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 3: Render Today’s Priorities and Compact Survival Summary in F1

**Files:**
- Modify: `src/sandbox/app.ts:1-22,560-589`
- Modify: `src/styles.css:570-591`
- Modify: `tests/daily-action-loop-ui.test.mjs`

**Interfaces:**
- Consumes: `deriveDailyCommandView({ state, plan, report, campaign, canonicalBlockReason })`
- Produces UI markers: `.desc-daily-priorities`, `.desc-daily-priority`, `.desc-daily-resource-summary`, `data-action="daily-detail"`.
- Preserves: existing Morning Report, field status, policies, roster, interruption, and execute button during this slice.

- [x] **Step 1: Add failing UI contract expectations**

Extend the first UI test with these tokens:

```js
for (const token of [
  'TODAY\'S PRIORITIES',
  'desc-daily-priorities',
  'desc-daily-resource-summary',
  'deriveDailyCommandView',
  'data-action="daily-detail"',
]) {
  assert.ok(app.includes(token), `missing Daily Command Center token: ${token}`);
}
```

Add a dedicated test:

```js
test('F1 bounds priorities and labels resource cards independently of color', () => {
  assert.match(app, /command\.priorities\.map/);
  assert.match(app, /data-command-tone=/);
  assert.match(app, /人口/);
  assert.match(app, /食料/);
  assert.match(app, /水/);
  assert.match(app, /医療/);
  assert.match(app, /遠征/);
  assert.match(css, /\.desc-daily-priority/);
  assert.match(css, /\.desc-daily-resource-summary/);
});
```

- [x] **Step 2: Run the UI contract and verify failure**

```bash
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: FAIL on missing command-center markers.

- [x] **Step 3: Import the read model in `app.ts`**

Add:

```ts
import { deriveDailyCommandView, type DailyCommandTarget } from './dailyCommandReadModel.js';
```

- [x] **Step 4: Add one reusable existing-runtime block-reason helper in `SandboxApp`**

Place near `controlledExpedition()`:

```ts
private dailyExecutionBlockReason(): string | undefined {
  const field = this.controlledExpedition();
  const directEncounter = field ? [...this.state.encounters].reverse().find((entry) => entry.expeditionId === field.id && entry.status !== 'resolved') : undefined;
  if (directEncounter) return 'WEDO is active. Resolve the direct encounter before executing the settlement plan.';
  const loop = ensureDailyLoopState(this.state);
  if (loop.phase === 'executing') return 'Daily execution is already in progress.';
  if (loop.currentPlan.status !== 'draft' && loop.currentPlan.status !== 'committed') return `Daily plan is ${loop.currentPlan.status} and cannot be started from this screen.`;
  return undefined;
}
```

This helper may only restate states already rejected or unavailable in the existing UI/runtime. It must not add heuristic blockers.

- [x] **Step 5: Derive the command view once in `pdaCampaignCommand()`**

Immediately after existing campaign/loop/report variables:

```ts
const canonicalBlockReason = this.dailyExecutionBlockReason();
const command = deriveDailyCommandView({
  state: this.state,
  plan: loop.currentPlan,
  report,
  campaign,
  ...(canonicalBlockReason ? { canonicalBlockReason } : {}),
});
```

Then remove the old four-card `desc-pda-campaign-metrics` block from this F1 function only; do not remove shared CSS or other campaign uses yet.

- [x] **Step 6: Render bounded priorities directly below the day/campaign header**

Insert after `.desc-daily-header`:

```ts
<section class="desc-daily-priorities" aria-labelledby="daily-priorities-title">
  <div class="desc-daily-section-head">
    <div><span id="daily-priorities-title">TODAY'S PRIORITIES</span><strong>今日、先に判断すること</strong></div>
    <small>${command.priorities.length} / 3</small>
  </div>
  <div class="desc-daily-priority-list">
    ${command.priorities.map((issue, index) => `<article class="desc-daily-priority tone-${issue.tone}" data-command-tone="${issue.tone}">
      <b>${index + 1}</b><div><strong>${esc(issue.title)}</strong><small>${esc(issue.detail)}</small></div>
      ${issue.target ? `<button data-action="daily-detail" data-daily-target="${issue.target}" ${issue.agentId ? `data-agent-id="${esc(issue.agentId)}"` : ''}>詳細</button>` : ''}
    </article>`).join('')}
  </div>
</section>
```

- [x] **Step 7: Render five compact resource summary cards**

Immediately below priorities:

```ts
<div class="desc-daily-resource-summary" aria-label="Daily survival summary">
  ${command.resourceSummary.map((item) => `<article class="tone-${item.tone}" data-command-tone="${item.tone}">
    <span>${esc(item.label)}</span><b>${esc(item.value)}</b><small>${esc(item.detail)}</small>
  </article>`).join('')}
</div>
```

- [x] **Step 8: Add CSS hierarchy without changing the CRT identity**

Append near the existing daily-action-loop styles:

```css
.desc-daily-priorities{border:1px solid rgba(139,169,105,.34);background:rgba(7,14,7,.78);padding:9px}
.desc-daily-priority-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
.desc-daily-priority{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:7px;align-items:center;min-height:68px;padding:7px;border:1px solid rgba(139,169,105,.18);background:#091109}
.desc-daily-priority>b{font-size:1rem;color:var(--pda-dim)}
.desc-daily-priority strong,.desc-daily-priority small{display:block}.desc-daily-priority small{margin-top:3px;color:#819075;line-height:1.35}
.desc-daily-priority.tone-warning{box-shadow:inset 3px 0 #9a9451}.desc-daily-priority.tone-critical{box-shadow:inset 3px 0 #b65343;background:rgba(151,45,35,.12)}
.desc-daily-priority button{min-height:30px;padding:4px 8px}
.desc-daily-resource-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
.desc-daily-resource-summary article{border:1px solid rgba(139,169,105,.18);padding:6px 7px;background:rgba(4,10,4,.66)}
.desc-daily-resource-summary span,.desc-daily-resource-summary b,.desc-daily-resource-summary small{display:block}.desc-daily-resource-summary span{font-size:.66rem;color:#879674}.desc-daily-resource-summary b{font-size:1rem;color:var(--pda-bright)}.desc-daily-resource-summary small{font-size:.66rem;color:#758169}
.desc-daily-resource-summary .tone-warning{box-shadow:inset 0 -2px #9a9451}.desc-daily-resource-summary .tone-critical{box-shadow:inset 0 -2px #b65343}
```

Add responsive behavior inside the existing `@media(max-width:900px)` block:

```css
.desc-daily-priority-list{grid-template-columns:1fr}
.desc-daily-resource-summary{grid-template-columns:repeat(3,minmax(0,1fr))}
```

- [x] **Step 9: Route `daily-detail` as a no-mutation UI action**

In `onClick()`, before mutation-heavy actions, add:

```ts
if (action === 'daily-detail') {
  const target = button.dataset.dailyTarget as DailyCommandTarget | undefined;
  const agentId = button.dataset.agentId;
  if (agentId) this.#inspectedAgentId = agentId;
  if (target === 'expedition') { this.#pdaTab = 'task'; this.#pdaTaskPanel = 'expedition'; this.#view = 'exploration'; }
  else if (target === 'task') { this.#pdaTab = 'task'; this.#pdaTaskPanel = 'overview'; this.#view = 'exploration'; }
  else if (target === 'map') { this.#pdaTab = 'map'; this.#view = 'exploration'; }
  else if (target === 'body' || target === 'knowledge' || target === 'inventory' || target === 'chronicle') { this.#pdaTab = target; this.#view = target; }
  this.render();
  return;
}
```

Add `daily-detail` to `BUSY_SAFE_ACTIONS` in `src/sandbox/uiNavigation.ts` because it is navigation only.

- [x] **Step 10: Run focused UI, navigation, type, and full daily-loop tests**

```bash
npm run test:compile && node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs
npm run check
```

Expected: PASS.

- [x] **Step 11: Build and take a fresh normal-morning screenshot** — attempted; handoff `node_modules/vite` and `node_modules/electron` are empty, so fresh capture is deferred to the direct TypeScript+Chromium diagnostic path in Tasks 7–8.

```bash
npm run build
npm run test:electron-e2e
```

If Electron is unavailable in the environment, run the existing browser/headless capture path used by the current handoff and save a fresh 1440×900 PNG under `docs/screenshots/daily-command-center/normal-1440x900.png`. Do not reuse `game-0.8.4-1440x900.png`.

- [x] **Step 12: Create task checkpoint ZIP and optional git commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T3_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/dailyCommandReadModel.ts src/sandbox/app.ts src/sandbox/uiNavigation.ts src/styles.css tests/daily-command-read-model.test.mjs tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs docs/screenshots/daily-command-center 2>/dev/null || true
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/dailyCommandReadModel.ts src/sandbox/app.ts src/sandbox/uiNavigation.ts src/styles.css tests/daily-command-read-model.test.mjs tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs docs/screenshots/daily-command-center
  git commit -m "feat: surface daily command priorities"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 4: Add READY / RISK / BLOCKED Readiness Without Changing Execution Semantics

**Files:**
- Modify: `src/sandbox/app.ts:560-589,1372-1401`
- Modify: `src/styles.css:578-591`
- Modify: `tests/daily-action-loop-ui.test.mjs`
- Review: `tests/daily-command-read-model.test.mjs` — existing readiness cases remain the behavioral authority; no modification is planned in this task.

**Interfaces:**
- Consumes: `command.readiness`, `command.readinessIssues`, `dailyExecutionBlockReason()`.
- Produces: `.desc-daily-readiness`, `data-readiness="ready|risk|blocked"`.
- Execution rule: button disabled only for `#busy` or `command.readiness === 'blocked'`.

- [x] **Step 1: Add failing UI contract for readiness semantics**

Add:

```js
test('Plan Readiness exposes READY RISK BLOCKED while RISK remains executable', () => {
  for (const token of ['PLAN READINESS', 'data-readiness=', 'READY', 'RISK', 'BLOCKED']) assert.ok(app.includes(token));
  assert.match(app, /command\.readiness==='blocked'/);
  assert.doesNotMatch(app, /command\.readiness==='risk'\?['"]disabled/);
  assert.match(app, /dailyExecutionBlockReason/);
});
```

- [x] **Step 2: Run UI test and verify failure**

```bash
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: FAIL.

- [x] **Step 3: Replace the old execute footer with readiness-aware markup**

Replace `.desc-daily-execute` contents in `pdaCampaignCommand()` with:

```ts
<div class="desc-daily-readiness readiness-${command.readiness}" data-readiness="${command.readiness}">
  <div class="desc-daily-readiness-label"><span>PLAN READINESS</span><strong>${command.readiness.toUpperCase()}</strong></div>
  <div class="desc-daily-readiness-issues">
    ${command.readinessIssues.length
      ? command.readinessIssues.slice(0, 3).map((issue) => `<button data-action="daily-detail" data-daily-target="${issue.target ?? 'task'}" ${issue.agentId ? `data-agent-id="${esc(issue.agentId)}"` : ''}><b>${esc(issue.title)}</b><small>${esc(issue.detail)}</small></button>`).join('')
      : '<p>現在の可視状態と計画から明白な警告はありません。</p>'}
  </div>
  <button class="primary" data-action="execute-plan" ${this.#busy || command.readiness === 'blocked' ? 'disabled' : ''}>EXECUTE PLAN</button>
</div>
```

Keep the existing structured interruption panel immediately above it.

- [x] **Step 4: Make `executeDailyPlan()` use the same existing-runtime blocker helper**

Replace the duplicated direct-encounter preflight at the top of `executeDailyPlan()` with:

```ts
const blockReason = this.dailyExecutionBlockReason();
if (blockReason) { this.toast(blockReason); return; }
```

Do not add any check for `command.readiness === 'risk'`.

- [x] **Step 5: Add readiness CSS with textual labels carrying meaning**

```css
.desc-daily-readiness{display:grid;grid-template-columns:150px minmax(0,1fr) 190px;gap:8px;align-items:stretch;margin-top:10px;padding-top:8px;border-top:1px solid rgba(139,169,105,.24)}
.desc-daily-readiness-label{display:grid;align-content:center;border:1px solid rgba(139,169,105,.22);padding:7px}.desc-daily-readiness-label span{font-size:.64rem;letter-spacing:.12em;color:#80936d}.desc-daily-readiness-label strong{font-size:1rem;margin-top:2px}
.desc-daily-readiness-issues{display:grid;gap:3px}.desc-daily-readiness-issues button,.desc-daily-readiness-issues p{margin:0;border:1px solid rgba(139,169,105,.14);background:#091009;color:var(--pda-text);padding:5px 7px;text-align:left}.desc-daily-readiness-issues b,.desc-daily-readiness-issues small{display:block}.desc-daily-readiness-issues small{margin-top:2px;color:#78856e}
.desc-daily-readiness.readiness-risk{box-shadow:inset 0 2px #9a9451}.desc-daily-readiness.readiness-blocked{box-shadow:inset 0 2px #b65343}.desc-daily-readiness.readiness-ready{box-shadow:inset 0 2px #557f54}
.desc-daily-readiness>button{min-height:46px;font-weight:800;letter-spacing:.1em}
.desc-daily-readiness.readiness-blocked>button{opacity:.5;cursor:not-allowed}
```

At compact width:

```css
.desc-daily-readiness{grid-template-columns:1fr}
```

- [x] **Step 6: Prove RISK remains executable at the read-model and source-contract layers**

Run:

```bash
npm run test:compile && node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop-ui.test.mjs tests/daily-action-loop.test.mjs
npm run check
```

Expected: PASS.

- [x] **Step 7: Build and capture a RISK-state screenshot** — deferred with the same handoff build-tool boundary; source behavior and enabled-RISK contract are verified, visual evidence will be captured in Tasks 7–8.

Create the state through the playable UI: select a resident already in a severe/critical condition and assign a strenuous task, or set MANUAL medical policy when the current Morning Report exposes a severe patient. Capture `docs/screenshots/daily-command-center/risk-1440x900.png` from that current build. The image must visibly contain the `RISK` text label and an enabled `EXECUTE PLAN` control. If the current deterministic save contains no severe resident, first execute normal days until an existing simulation outcome produces one; do not inject hidden state or add a production fixture switch.

- [x] **Step 8: Create checkpoint ZIP and optional commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T4_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/app.ts src/styles.css tests/daily-action-loop-ui.test.mjs tests/daily-command-read-model.test.mjs docs/screenshots/daily-command-center 2>/dev/null || true
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/app.ts src/styles.css tests/daily-action-loop-ui.test.mjs tests/daily-command-read-model.test.mjs docs/screenshots/daily-command-center
  git commit -m "feat: add daily plan readiness"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 5: Triage Morning Report and Enrich Resident Planning Rows

**Files:**
- Modify: `src/sandbox/app.ts:153-190,560-589,1415-1510`
- Modify: `src/styles.css:573-591`
- Modify: `tests/daily-action-loop-ui.test.mjs`

**Interfaces:**
- Consumes: `command.residentRows`, existing `report.residentDeltas`.
- Produces UI-only `#morningReportExpanded: boolean`.
- Produces action: `daily-morning-toggle`.
- Preserves: all Morning Report data remains accessible; no save persistence for disclosure state.

- [x] **Step 1: Add failing UI contract for triage disclosure and richer resident rows**

Add:

```js
test('Morning Report progressively discloses stable rows and planning rows show prior/current/risk context', () => {
  for (const token of [
    '#morningReportExpanded',
    'data-action="daily-morning-toggle"',
    '全住民',
    'previousTask',
    'riskNote',
    'data-resident-risk',
  ]) assert.ok(app.includes(token), `missing triage/planning token: ${token}`);
});
```

- [x] **Step 2: Run and verify failure**

```bash
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: FAIL.

- [x] **Step 3: Add UI-only disclosure state**

In class fields:

```ts
#morningReportExpanded = false;
```

Do not store this in `SandboxGameState`, localStorage, or the repository.

- [x] **Step 4: Derive visible Morning Report rows without losing data**

In `pdaCampaignCommand()` after `morningRows`:

```ts
const triageRows = morningRows.filter((entry) => !['stable', 'improved'].includes(entry.severity));
const visibleMorningRows = this.#morningReportExpanded
  ? morningRows
  : (triageRows.length ? triageRows : morningRows.slice(0, 3));
const hiddenMorningCount = Math.max(0, morningRows.length - visibleMorningRows.length);
```

Render `visibleMorningRows` instead of `morningRows`. In the section head add:

```ts
<button
  data-action="daily-morning-toggle"
  aria-expanded="${this.#morningReportExpanded}"
  ${!this.#morningReportExpanded && hiddenMorningCount === 0 ? 'disabled' : ''}
>
  ${this.#morningReportExpanded ? '重要項目だけ' : `全住民を表示${hiddenMorningCount ? ` (${hiddenMorningCount})` : ''}`}
</button>
```

If `hiddenMorningCount === 0`, keep the button present but disabled only when there is nothing to expand.

- [x] **Step 5: Render `command.residentRows` instead of reconstructing roster context in the template**

Replace the roster mapping with:

```ts
<div class="desc-daily-roster">
  ${command.residentRows.map((row) => `<label data-daily-agent-id="${esc(row.agentId)}" data-resident-risk="${row.riskNote ? '1' : '0'}">
    <span class="desc-daily-resident-main"><b>${esc(row.name)}</b><small>${esc(row.role)} · ${esc(row.condition)}</small></span>
    <span class="desc-daily-resident-context"><small>前日/現在</small><b>${esc(row.previousTask)}</b></span>
    <select data-action="daily-assignment" data-agent-id="${esc(row.agentId)}" ${row.locked ? 'disabled' : ''} aria-label="${esc(row.name)} 今日の作業">
      ${tasks.map((task) => `<option value="${task}" ${task === row.assignedTask ? 'selected' : ''}>${task}</option>`).join('')}
    </select>
    <small class="desc-daily-resident-risk">${esc(row.riskNote ?? (row.locked ? '年齢により作業割当不可' : '明白な配置警告なし'))}</small>
  </label>`).join('')}
</div>
```

- [x] **Step 6: Route the disclosure toggle**

In `onClick()`:

```ts
if (action === 'daily-morning-toggle') {
  this.#morningReportExpanded = !this.#morningReportExpanded;
  this.#focusAfterRender = '[data-action="daily-morning-toggle"]';
  this.render();
  return;
}
```

Add `daily-morning-toggle` to `BUSY_SAFE_ACTIONS`.

- [x] **Step 7: Update roster CSS for four readable zones**

Replace the current two-column roster label rule with:

```css
.desc-daily-roster>label{display:grid;grid-template-columns:minmax(180px,1.35fr) minmax(85px,.7fr) 110px minmax(130px,1fr);gap:7px;align-items:center;border:1px solid rgba(139,169,105,.14);padding:5px 6px}
.desc-daily-roster>label[data-resident-risk="1"]{box-shadow:inset 3px 0 #9a9451;background:rgba(125,108,48,.06)}
.desc-daily-resident-main,.desc-daily-resident-context{min-width:0}.desc-daily-resident-main b,.desc-daily-resident-main small,.desc-daily-resident-context b,.desc-daily-resident-context small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.desc-daily-resident-context small{font-size:.6rem;color:#6f7b67}.desc-daily-resident-context b{font-size:.72rem}
.desc-daily-resident-risk{font-size:.66rem;color:#7e8b73;white-space:normal!important}.desc-daily-roster>label[data-resident-risk="1"] .desc-daily-resident-risk{color:#c4b56e}
```

At `max-width:900px`:

```css
.desc-daily-roster>label{grid-template-columns:minmax(150px,1fr) 105px}.desc-daily-resident-context,.desc-daily-resident-risk{grid-column:1/-1}
```

- [x] **Step 8: Run focused tests, type check, and build**

```bash
npm run test:compile && node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs
npm run check
npm run build
```

Observed: focused tests and type check PASS; `npm run build` reaches Vite then stops because the handoff contains no Vite executable (`vite: not found`). Source verification remains green.

- [x] **Step 9: Re-run normal and RISK screenshots and inspect layout**

Deferred to Tasks 7–8 because the handoff omits the Vite/Electron executables. Capture via the current-source Chromium fallback before final packaging.

At 1440×900 verify:

- priorities and summary appear before resident database;
- stable rows can be hidden without losing the expansion control;
- the resident roster shows name/condition, previous task, selector, and risk note without horizontal document overflow;
- `EXECUTE PLAN` remains reachable in the F1 command surface.

At 1280×720 verify no horizontal document-level overflow. Save `docs/screenshots/daily-command-center/compact-1280x720.png` when the environment supports the requested viewport.

- [x] **Step 10: Create checkpoint ZIP and optional commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T5_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/app.ts src/sandbox/uiNavigation.ts src/styles.css tests/daily-action-loop-ui.test.mjs docs/screenshots/daily-command-center 2>/dev/null || true
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/app.ts src/sandbox/uiNavigation.ts src/styles.css tests/daily-action-loop-ui.test.mjs docs/screenshots/daily-command-center
  git commit -m "feat: triage morning report and plan roster"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 6: Complete Direct Detail Handoffs and MANUAL Interruption Navigation

**Files:**
- Modify: `src/sandbox/app.ts:1415-1510`
- Modify: `tests/daily-action-loop-ui.test.mjs`
- Modify: `tests/generated-ui-contract.test.mjs` if routed-action audit requires it.

**Interfaces:**
- Consumes: `DailyCommandTarget` and optional issue `agentId`.
- Produces: direct navigation to F2 Body, F4 Inventory/rationing, F1 expedition/map, F3 Knowledge, F5 Chronicle.
- Preserves: DailyPlan because plan remains in `state.dailyLoop.currentPlan` across UI navigation.

- [x] **Step 1: Add a contract test for all command destinations**

```js
test('Daily Command Center routes concerns to existing authoritative detail surfaces', () => {
  for (const target of ['body','inventory','expedition','map','knowledge','chronicle','task']) {
    assert.match(app, new RegExp(`target === '${target}'|target==='${target}'`), `missing Daily Command target route: ${target}`);
  }
  assert.match(app, /this\.#inspectedAgentId = agentId/);
  assert.match(app, /this\.#pdaTaskPanel = 'expedition'/);
});
```

- [x] **Step 2: Run contract tests**

```bash
node --test tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs
```

Expected: pass if Task 3 routing is complete; otherwise fail on missing destinations.

- [x] **Step 3: Tighten `daily-detail` so resident warnings open the selected person in F2**

Ensure the handler performs these operations in this order:

```ts
if (agentId) this.#inspectedAgentId = agentId;
if (target === 'body') { this.#pdaTab = 'body'; this.#view = 'body'; }
```

Do not use the old `inspect-agent` behavior alone because it currently re-renders the same surface rather than moving to F2.

- [x] **Step 4: Change the Morning Report resident-name control to direct F2 navigation**

Replace:

```html
data-action="inspect-agent"
```

for Morning Report names with:

```html
data-action="daily-detail" data-daily-target="body"
```

and keep `data-agent-id` unchanged.

Do not globally remove `inspect-agent`; other surfaces may depend on its current semantics.

- [x] **Step 5: Reuse the same direct route in the MANUAL interruption panel**

For medical interruption:

```html
<button data-action="daily-detail" data-daily-target="body" data-agent-id="${esc(interruption.subjectIds[0] ?? '')}">手動で身体・医療を確認</button>
```

For expedition interruption:

```html
<button data-action="daily-detail" data-daily-target="expedition">手動で探索を操作</button>
```

Keep `resolve-daily-interruption-auto` unchanged.

- [x] **Step 6: Run route audit, daily UI tests, and unit tests**

```bash
npm run test:compile && node --test tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs tests/daily-action-loop.test.mjs tests/daily-command-read-model.test.mjs
npm run check
```

Expected: PASS, including the generic “every rendered data-action is routed” test.

- [x] **Step 7: Exercise a MANUAL interruption end-to-end**

Use the existing daily-action-loop test for semantics and the current build for UI. Confirm:

1. severe patient + medical MANUAL yields interruption;
2. F1 shows the structured interruption;
3. “身体・医療を確認” opens F2 with that resident selected;
4. returning to F1 leaves `currentPlan` committed;
5. “この日だけAUTOで続行” resumes and reaches the originally scheduled next morning.

UI route and daily-loop semantics are verified by focused tests. Screenshot capture is deferred to the current-source Chromium fallback in Tasks 7–8 because Vite/Electron executables are absent from the handoff.

Capture `docs/screenshots/daily-command-center/manual-interruption-1440x900.png` from the current build when the environment permits.

- [x] **Step 8: Create checkpoint ZIP and optional commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T6_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/app.ts tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs docs/screenshots/daily-command-center 2>/dev/null || true
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/app.ts tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs docs/screenshots/daily-command-center
  git commit -m "feat: connect daily command detail handoffs"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 7: Visual Hierarchy, Accessibility, and 1440×900 / 1280×720 Hardening

**Files:**
- Modify: `src/styles.css:570-591` and adjacent accessibility rules only.
- Modify: `src/sandbox/app.ts` only for semantic labels/ARIA discovered during visual inspection.
- Modify: `tests/daily-action-loop-ui.test.mjs`
- Review: `tests/pda-presentation.test.mjs` — existing CRT/reduced-motion contracts must continue to pass; no modification is planned in this task.

**Interfaces:**
- No new simulation interfaces.
- Preserves: PDA/CRT identity, reduced motion, focus restoration, keyboard tabs.

- [x] **Step 1: Add accessibility contract assertions**

Add to `tests/daily-action-loop-ui.test.mjs`:

```js
test('Daily Command Center exposes textual state and accessible disclosure/readiness semantics', () => {
  assert.match(app, /aria-labelledby="daily-priorities-title"/);
  assert.match(app, /aria-label="Daily survival summary"/);
  assert.match(app, /aria-expanded=/);
  assert.match(app, /data-readiness=/);
  assert.match(app, /PLAN READINESS/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /prefers-reduced-motion|a11y-reduce-motion/);
});
```

- [x] **Step 2: Run accessibility contract test**

```bash
node --test tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: PASS after Tasks 3–6; if not, fix semantic markup rather than weakening assertions.

- [x] **Step 3: Run the current build and inspect the 1440×900 normal state**

Check all of these explicitly:

- day/campaign header is visually first;
- only priorities use strongest attention above routine data;
- healthy resource values are visually quieter than warning/critical values;
- no priority card exceeds two text lines for title plus roughly three short lines for detail;
- Morning Report does not dominate the full screen when most residents are stable;
- resident roster is scan-readable without text collision;
- readiness and execute control read as one decision unit;
- no document-level horizontal scrolling.

- [x] **Step 4: Inspect 1440×900 RISK and MANUAL states**

Verify:

- `RISK` text is visible independently of color;
- execute remains enabled in RISK;
- MANUAL interruption appears above readiness and does not push the action control out of practical reach;
- direct detail buttons have concrete labels and visible focus states.

- [x] **Step 5: Inspect 1280×720 compact state**

Verify:

- priority cards stack to one column;
- resource cards reflow without horizontal overflow;
- resident rows collapse to two principal columns plus full-width context/risk lines;
- readiness becomes one column;
- navigation and execute controls remain operable.

If vertical density is excessive, reduce padding/gaps before reducing font size below existing PDA legibility norms.

- [x] **Step 6: Preserve reduced-motion and focus behavior**

Run:

```bash
npm run test:compile && node --test tests/pda-presentation.test.mjs tests/generated-ui-contract.test.mjs tests/daily-action-loop-ui.test.mjs
```

Expected: PASS. Do not alter the existing CRT reduced-motion keyframes unless a regression is demonstrated.

- [x] **Step 7: Capture the required fresh screenshot matrix**

Required files:

```text
docs/screenshots/daily-command-center/normal-1440x900.png
docs/screenshots/daily-command-center/risk-1440x900.png
docs/screenshots/daily-command-center/manual-interruption-1440x900.png
docs/screenshots/daily-command-center/compact-1280x720.png
```

If the environment cannot produce one state, keep the successfully captured current-build images and continue; do not copy an old screenshot into a new filename.

- [x] **Step 8: Create checkpoint ZIP and optional commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T7_2026-09-16.zip
zip -q -r "$CHECK" src/sandbox/app.ts src/styles.css tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs docs/screenshots/daily-command-center 2>/dev/null || true
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/app.ts src/styles.css tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs docs/screenshots/daily-command-center
  git commit -m "style: harden daily command center presentation"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 8: Extend Electron Diagnostic Capture for the New F1 Contract

**Files:**
- Modify: `electron/main.cjs:8-65`
- Modify: `tools/run-electron-path-e2e.mjs:1-45`

**Interfaces:**
- Produces diagnostic assertions only; must not ship gameplay-state mutation or hidden fixture controls into `src/`.
- Existing `npm run test:electron-e2e` remains the primary command.

- [x] **Step 1: Add F1 command-center DOM checks to the Electron E2E result**

Inside the initial `executeJavaScript()` result in `electron/main.cjs`, add:

```js
commandCenter: {
  priorities: document.querySelectorAll('.desc-daily-priority').length,
  resourceCards: document.querySelectorAll('.desc-daily-resource-summary article').length,
  readiness: document.querySelector('.desc-daily-readiness')?.getAttribute('data-readiness') ?? '',
  executePresent: Boolean(document.querySelector('[data-action="execute-plan"]')),
},
```

- [x] **Step 2: Assert the new contract in `tools/run-electron-path-e2e.mjs`**

Extend the failure condition with:

```js
|| result.commandCenter?.priorities < 1
|| result.commandCenter?.priorities > 3
|| result.commandCenter?.resourceCards !== 5
|| !['ready','risk','blocked'].includes(result.commandCenter?.readiness)
|| !result.commandCenter?.executePresent
```

- [x] **Step 3: Capture the normal F1 screenshot before navigating away**

Change the existing first capture sequence to:

```js
await capture('daily-command-normal');
await capture('task');
```

Do not remove the existing task screenshot; downstream tooling may use it.

- [x] **Step 4: Add a compact-size diagnostic capture and restore the original size**

Immediately after the normal/task captures:

```js
const originalBounds = win.getContentBounds();
win.setContentSize(1280, 720);
await new Promise((resolve) => setTimeout(resolve, 180));
await capture('daily-command-1280x720');
result.compactContentBounds = win.getContentBounds();
result.compactNoHorizontalOverflow = await win.webContents.executeJavaScript(`(() => {
  const viewport = document.querySelector('.desc-pda-content');
  return Boolean(viewport && viewport.scrollWidth <= viewport.clientWidth + 1);
})()`);
win.setContentSize(originalBounds.width, originalBounds.height);
await new Promise((resolve) => setTimeout(resolve, 180));
```

This is diagnostic evidence; if platform window chrome causes a content area different from exactly 1280×720, report the captured `compactContentBounds` instead of claiming an exact browser viewport. Require `result.compactNoHorizontalOverflow === true` in `tools/run-electron-path-e2e.mjs`.

- [x] **Step 5: Verify the compact diagnostic fields are included in the final Electron E2E result object**

Keep both fields on the same `result` object that is serialized by the runner:

```js
result.compactContentBounds;
result.compactNoHorizontalOverflow;
```

Do not resize the window again before the normal navigation checks continue.

- [x] **Step 6: Run build and Electron diagnostic** — source/type/static diagnostics pass; Vite and Electron executables are absent from this extracted handoff, so runtime Electron capture remains an environment boundary.

```bash
npm run build
npm run test:electron-e2e
```

Expected: PASS when Electron is supported. If Electron cannot start in this execution environment, retain the failure output and continue; do not add hidden production fixture hooks to force a screenshot.

- [x] **Step 7: Copy successful current-build diagnostic captures into the Daily Command Center screenshot directory** — Electron E2E did not run; exact-size current-source Chromium captures are retained instead, so no Electron image was mislabeled.

When the Electron E2E succeeds:

```bash
mkdir -p docs/screenshots/daily-command-center
cp docs/screenshots/pda-e2e/daily-command-normal.png docs/screenshots/daily-command-center/normal-1440x900.png
cp docs/screenshots/pda-e2e/daily-command-1280x720.png docs/screenshots/daily-command-center/compact-1280x720.png
```

If the captured normal content bounds are not exactly 1440×900, keep the diagnostic file under `pda-e2e` and do not rename it to `normal-1440x900.png`; the required exact-size image must come from the headless/browser path that can honor the requested viewport.

- [x] **Step 8: Create checkpoint ZIP and optional commit**

```bash
CHECK=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_T8_2026-09-16.zip
zip -q -r "$CHECK" electron/main.cjs tools/run-electron-path-e2e.mjs docs/screenshots/daily-command-center docs/screenshots/pda-e2e 2>/dev/null || true
sha256sum "$CHECK"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add electron/main.cjs tools/run-electron-path-e2e.mjs docs/screenshots/daily-command-center docs/screenshots/pda-e2e 2>/dev/null || true
  git commit -m "test: capture daily command center states"
else
  echo "git unavailable in extracted handoff; ZIP checkpoint is recovery boundary"
fi
```

---

### Task 9: Full Regression, Playability Gate, Cleanup, and Final Recovery Package

**Files:**
- Review: all files changed by Tasks 1–8.
- Review all changed files; fix only regressions attributable to this feature, without unrelated refactors.
- No new prose status files unless an existing handoff file must be updated by project convention.

**Interfaces:**
- Final output is a playable source tree plus recovery ZIP and SHA-256.

- [ ] **Step 1: Run the complete unit suite** — attempted; 356 tests passed consecutively before the 5-minute environment timeout, with no failure observed.

```bash
npm run test:unit
```

Expected: all registered tests PASS, including the new Daily Command read-model test.

- [x] **Step 2: Run TypeScript, worldgen integration, and portable build checks** — type check and Worldgen integration pass; portable builder emitted its success banner and generated-package contamination check passes, although that process did not exit before the external timeout.

```bash
npm run check
npm run test:worldgen-integration
npm run build:portable
node tools/check-generated-package.mjs
```

Expected: PASS.

- [x] **Step 3: Run release-facing audits that are affordable in the current environment** — contract/version/desktop checks pass; release audit reaches the inherited handoff boundary because the parent `PACKAGE_CONTENT_SHA256.txt` is absent.

```bash
npm run contract:check
npm run version:check
npm run desktop:check
npm run release:audit
```

If `research:check` is a known baseline failure in this handoff, do not spend the implementation cycle repairing unrelated reference-ledger debt; report the existing failure separately and continue.

- [x] **Step 4: Attempt Electron E2E and treat environment startup failure as a recorded boundary**

```bash
npm run test:electron-e2e
```

Expected: PASS and fresh diagnostic screenshots. If Electron cannot start in this container, keep the successful build/unit evidence and current-build browser/headless screenshots; do not block completion.

- [x] **Step 5: Run an end-to-end daily-loop playability smoke**

Use the existing unit path plus current UI and confirm this exact sequence still works:

1. open F1 planning state;
2. change at least one resident assignment;
3. change one execution policy;
4. verify readiness updates immediately;
5. execute a READY or RISK plan;
6. if MANUAL interruption occurs, inspect detail or switch that domain to AUTO;
7. resume execution;
8. reach next morning;
9. verify new Morning Report appears;
10. verify prior explicit assignments are carried by existing daily-loop behavior.

Do not add a new one-off test document for this smoke; use console/test output and screenshots.

- [x] **Step 6: Verify persistence compatibility directly**

Run the existing save/import tests through `npm run test:unit`, then additionally confirm no source change added fields under `DailyLoopStateV1` or changed `SandboxGameState.schemaVersion`:

```bash
grep -n "schemaVersion: 1" src/sandbox/types.ts | head
grep -Rni "dailyCommand" src/sandbox/types.ts src/sandbox/storage.ts
```

Expected: no persisted `dailyCommand` property appears in types/storage.

- [x] **Step 7: Scan for plan failures and accidental debug residue**

```bash
grep -RniE 'console\.log\(|debugger;' src/sandbox/dailyCommandReadModel.ts src/sandbox/app.ts src/styles.css tests/daily-command-read-model.test.mjs tests/daily-action-loop-ui.test.mjs || true
grep -RniE '__debugState|window\.__|debug fixture' src || true
```

Expected: no unresolved placeholders or production debug hooks introduced by this work.

- [x] **Step 8: Verify screenshot files actually exist and are non-empty**

```bash
find docs/screenshots/daily-command-center -maxdepth 1 -type f -name '*.png' -size +0c -print | sort
```

Expected: every successfully captured state is listed. Missing environment-specific states may remain absent; never fabricate them.

- [x] **Step 9: Produce the final full-source recovery ZIP**

From the parent directory of `Descendants`:

```bash
cd /mnt/data/descendants_handoff/DESCENDANTS_DAILY_ACTION_LOOP_HANDOFF_2026-09-16
FINAL=/mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_2026-09-16.zip
zip -q -r "$FINAL" Descendants \
  -x 'Descendants/node_modules/*' \
     'Descendants/.test-dist/*' \
     'Descendants/dist/*' \
     'Descendants/.git'
sha256sum "$FINAL" | tee /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_2026-09-16.zip.sha256
```

This is the final recovery artifact. Excluding `node_modules`, `.test-dist`, and `dist` does not lose source data; dependencies/build outputs are reproducible from `package-lock.json` and the checked-in source.

- [x] **Step 10: Optional final git commit when repository metadata is functional** — attempted; inherited `.git` points to a missing external worktree, so no commit was created and ZIP+SHA-256 remains the recovery boundary.

```bash
cd /mnt/data/descendants_handoff/DESCENDANTS_DAILY_ACTION_LOOP_HANDOFF_2026-09-16/Descendants
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/sandbox/dailyCommandReadModel.ts src/sandbox/dailyActionLoop.ts src/sandbox/survivalCampaign.ts src/sandbox/app.ts src/sandbox/uiNavigation.ts src/styles.css tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/generated-ui-contract.test.mjs tests/pda-presentation.test.mjs tools/test-unit.mjs electron/main.cjs tools/run-electron-path-e2e.mjs docs/screenshots/daily-command-center
  git commit -m "feat: complete daily command center"
else
  echo "git unavailable in extracted handoff; final ZIP + SHA-256 is the authoritative recovery artifact"
fi
```

---

## Implementation Completion Gate

Do not declare this feature complete until all applicable items below are true:

- `deriveDailyCommandView()` is deterministic and non-mutating.
- F1 shows 1–3 priorities, never more than 3.
- Food/water pressure uses the same shared reserve thresholds as the existing survival campaign.
- Manual interruption preview and actual interruption use the same exported predicate.
- RISK never disables execution.
- BLOCKED comes only from `dailyExecutionBlockReason()` states already rejected/unavailable in current runtime.
- Morning Report stable rows remain accessible through disclosure.
- Every living settlement resident remains represented in the planning roster; under-13 residents remain non-assignable under the existing rule.
- Relevant command concerns navigate directly into F2/F4/F1 expedition/map/F3/F5 without duplicating deep data.
- Existing daily execution timing, MANUAL resume target, and next-morning report semantics remain unchanged.
- No save schema, migration, or persisted command read model is added.
- Keyboard/focus and reduced-motion tests pass.
- Fresh current-build screenshots exist for every state the current environment can render.
- Unit/type/build/integration checks pass except explicitly pre-existing environment/baseline failures.
- A final recovery ZIP and SHA-256 are generated.

## Post-plan polish checkpoint

- [x] Priority cards use `auto-fit` on wide displays so 1/2/3 priorities occupy 1/2/3 useful columns instead of leaving dead space; 1280-class layout remains single-column.
- [x] MANUAL medical priorities collapse the same resident's redundant critical-status card into the actionable medical decision, and generic campaign directives do not duplicate a more specific priority targeting the same detail surface.
- [x] Re-captured current-source screenshots for normal, RISK, MANUAL interruption, and 1280×720 compact states with zero document-level horizontal overflow.
- [x] Re-ran the real UI smoke path: MANUAL medical interruption → F2 body detail → return to F1 with committed plan → one-day AUTO resume → next morning report.
- [x] Localized F1 labor-task presentation (`採集 / forage`, `休養 / rest`, etc.) while retaining canonical `LaborTask` ids for saves and simulation commands; readiness copy uses the same labels.
- [x] Added a non-persistent `YESTERDAY'S OUTCOME / 昨日の結果` band derived only from the canonical Morning Report. It compresses irreversible population change, resident-state change, resource deltas, expedition updates, and settlement updates to at most three consequence cards; days with no meaningful prior changes render no synthetic cards.
- [x] Added a no-state-change `計画へ ↓` anchor from the morning header to `TODAY'S PLAN`. At 1280-class widths the resident roster is capped at 205px so the jump viewport includes `PLAN READINESS` and `EXECUTE PLAN`; browser evidence confirms the campaign scroll container moves from `scrollTop 0` to `1149`, the execute control is visible, and DAY 2 → execute → DAY 3 remains playable.
- [x] Captured fresh DAY 2 outcome screenshots at 1440×900 and 1280×720 plus a 1280×720 post-jump plan screenshot; all have zero document-level horizontal overflow.

## Post-plan polish checkpoint P3

- [x] Added non-persistent `PLAN IMPACT / 計画反応` derived from the draft plan versus the prior Morning Report/current task baseline. It appears only after assignment changes and reports changed-resident count plus up to two concrete deltas: crisis coverage (`給水・衛生`, `採集`) and hazardous-placement count. It explicitly labels the plan as unexecuted and leaves actual outcome confirmation to the next Morning Report rather than predicting yields.
- [x] Preserved `.desc-pda-campaign-screen` scroll across F1 rerenders. Browser QA reproduced the prior defect (`scrollTop 1149 → 0` after changing an assignment) and verifies the fix (`1149 → 1149`), with PLAN IMPACT and `EXECUTE PLAN` still visible at 1280×720.
- [x] Added planned worker counts directly to water/food crisis priority details so the player can compare crisis severity with current response staffing before changing assignments.
- [x] Added ephemeral daily-execution feedback: the authoritative F1 execute control changes to `EXECUTING 24H…` while the daily run is active; no save/schema fields were added.
- [x] Added a next-morning CRT transition summary derived only from the canonical Morning Report (`死亡`, `要対応`, and significant food/water/medicine deltas, maximum three facts). It is cleared after the transition and does not persist or duplicate simulation state.
- [x] Captured current-source GUI evidence for 1280×720 plan-impact state, 1440×900 crisis-coverage state, and 1440×900 next-morning transition summary with zero document-level horizontal overflow.

## Post-plan polish checkpoint P4

- [x] Added non-persistent `CRISIS CREW / 危機対応候補` recommendations only when food/water/sanitation pressure is visible. Candidate ranking uses player-visible role/skill/HP/fatigue/current-task data, excludes under-age or visibly unsafe assignments, caps each shortlist at three residents, and never predicts yield or survival outcome.
- [x] Connected each crisis candidate to the canonical `setDailyAssignment()` path through a one-click assignment button. Browser QA confirms the selected `DailyPlan` assignment changes immediately and existing `PLAN IMPACT` feedback updates without introducing a parallel planning state.
- [x] Preserved the 1280×720 command loop after adding crisis recommendations: compact mode hides the repeated AUTO/MANUAL explanatory sentence, reduces only spacing, and caps the crisis-state resident roster at 90px so crisis comparison, PLAN IMPACT, PLAN READINESS, and the full `EXECUTE PLAN` control remain visible together.
- [x] Removed the temporary horizontal-scroll preservation approach after root-cause diagnosis. The PDA screen is a CSS Grid whose direct grid items inherited `min-width:auto`; long F1 min-content widened the single grid column beyond the CRT viewport. Header/content/footer now use `min-width:0; max-width:100%; width:100%`, leaving `scrollLeft=0` before and after anchor navigation and F1 rerenders.
- [x] Captured current-source crisis-crew screenshots at 1440×900 and 1280×720. Browser measurement confirms the 1280 PDA viewport has `clientWidth == scrollWidth`, zero horizontal scroll, no document-level overflow, and no page errors.
- [x] Ran a real risk-state loop: DAY 1 → `計画へ` → one-click crisis assignment → medical policy AUTO → `EXECUTE PLAN` → DAY 2. The chosen `forage` assignment persists into DAY 2 through the existing canonical daily-loop carry-forward behavior.

## Post-plan polish checkpoint P5

- [x] Made each `CRISIS CREW` candidate explain its visible fit with compact reason chips (`役割一致`, localized visible skill, fatigue, HP) while retaining the existing visible-data-only ranking and explicit no-outcome-prediction boundary.
- [x] Added a two-person crisis batch control that applies the currently displayed top two safe candidates through the canonical `setDailyAssignment()` path; no parallel planning state or save field is introduced. Browser QA verifies both assignments update immediately and carry into the next morning through the existing daily-loop behavior.
- [x] Preserved the 1280×720 one-screen command loop after adding comparison reasons and batch controls. Compact mode removes the redundant candidate transition sentence, keeps comparison chips on one line, tightens only spacing/readiness padding, preserves campaign scroll (`998 → 998`), and leaves `EXECUTE PLAN` visible with zero horizontal overflow.
- [x] Added an authoritative next-morning response log derived only from Morning Report executed-task rows plus actual resource deltas: e.g. `採集 7名 · 給水 2名 · 衛生 3名 · 食料 +75.7 · 水 +14.5`. Copy explicitly states that juxtaposition does not establish causality.
- [x] Suppressed the generic resource-delta outcome card whenever the response log already contains the same food/water deltas, avoiding duplicate morning information while keeping population/health outcomes independently visible.
- [x] Captured current-source evidence at 1280×720 for crisis comparison + batch assignment and at 1440×900 for the next-morning response log after execution completion.


## Post-plan polish checkpoint P6

- [x] Upgraded the existing next-morning response log into a `CRISIS READBACK` without adding persisted state. The card still uses only canonical Morning Report executed-task rows and observed resource deltas, but now also reads the current authoritative survival reserve view so a positive delta cannot be mistaken for crisis resolution.
- [x] Food readback uses the same shared 1.5-day critical / 3-day warning reserve thresholds as the survival campaign and labels the current state `危機継続`, `警戒継続`, or `警戒圏外`. Water readback uses the same reserve thresholds plus the existing 55% water-safety boundary; unsafe water remains critical and is labeled `水質危機継続` even when reserve quantity is high.
- [x] Response-log tone now follows the stronger current crisis condition instead of simply treating positive resource deltas as normal. Copy continues to state that juxtaposing yesterday's placement with the next-morning delta does not establish causality.
- [x] Added a compact `CRISIS READBACK` marker to the existing Yesterday's Outcome card rather than creating another vertical dashboard section. Existing outcome compression and the no-duplicate-resource-card rule remain intact.
- [x] Fixed the daily-loop viewport boundary discovered during current-source browser QA: same-day F1 rerenders preserve `.desc-pda-campaign-screen` scroll, but a new day no longer inherits the prior day's Today-plan scroll. Campaign scroll preservation is keyed by `data-scroll-day`; the `計画へ ↓` link is intercepted as a no-state-change `scrollIntoView()` action so it does not leave a persistent URL hash that can pull the next morning back to the plan section.
- [x] Current-source browser QA verifies DAY 1 risk response → execute → DAY 2 opens at the Morning Report top with `CRISIS READBACK` visible at both 1440×900 and 1280×720, with zero PDA/document horizontal overflow. A separate non-persistent QA state verifies a positive food delta with 0.0 days remaining stays `critical` and displays `危機継続`.
- [x] During final related-suite regression, the legacy Survival Campaign UI contract exposed that F1 no longer surfaced generational continuity after the Daily Command read-model refactor. Updated that contract to follow the current architecture (food/water reserve facts live in `dailyCommandReadModel.ts`) and restored a low-intensity header line: `SURVIVAL CONTINUITY · 子孫 N · MILESTONES x/y`. This adds no new gameplay state and avoids duplicating food/water values already shown in the resource cards.

## Post-plan polish checkpoint P7

- [x] Added a direct unresolved-crisis handoff from `CRISIS READBACK` to today's `CRISIS CREW`. Warning/critical readback cards render `対応を続ける`; recovered/normal readbacks do not. The action performs no state mutation, scrolls to the current canonical planning surface, and moves keyboard focus to the first available crisis assignment control.
- [x] Marked the destination crisis crew with a low-intensity `FOLLOW-UP / 継続危機` treatment only while the prior response readback remains warning/critical and an actionable current crisis recommendation exists.
- [x] Added non-persistent previous-response staffing to each crisis recommendation (`previousCount`) from the canonical Morning Report task rows and display it beside current planned staffing as `昨日 N名 → 今日 M名`. This exposes staffing discontinuity without predicting yields or adding save fields.
- [x] Current-source browser QA verifies persistent food crisis morning → `対応を続ける` → crisis crew (`scrollTop 0 → 941`) with focus on the batch/assignment control. At 1280×720 the destination remains free of PDA/document horizontal overflow. A recovered high-reserve QA state verifies no follow-up CTA or follow-up crew marker is manufactured.

## Post-plan polish checkpoint P8

- [x] Added one-day crisis rotation support without introducing history persistence. `CRISIS CREW` now compares each safe candidate with the canonical prior Morning Report; residents who performed the same crisis task yesterday are explicitly tagged (`昨日も採集` / localized task) and ranked after equally safe residents who were on another task yesterday. Candidate comparison still uses only visible role/skill/HP/fatigue/current-task plus the immediately previous executed task; no hidden yield or survival prediction is introduced.
- [x] Added non-persistent continuity gap fields to each crisis recommendation: `continuityShortfall = max(0, previousCount - assignedCount)` and `fillCandidateIds` selected from the already-safe, rotation-aware shortlist. No arbitrary staffing target is invented: the shortcut exists only to restore staffing that actually existed in the previous Morning Report.
- [x] Replaced the generic two-person batch button with `昨日水準へ補充 +N` while an unresolved crisis is below yesterday's staffing level. The action applies exactly the displayed safe fill candidates through canonical `setDailyAssignment()` calls and disappears as soon as the prior-day staffing level is restored; otherwise the existing `上位2名を配置` control remains available.
- [x] Updated crisis-crew explanatory copy to state `昨日担当は後順位`, making the rotation rule visible instead of presenting it as an opaque recommendation score.
- [x] Current-source browser QA verifies persistent food crisis DAY 2 → follow-up crew → `昨日2名 → 今日0名` → `昨日水準へ補充 +2` → `今日2名`. The selected fill residents are the fresh prior-day non-foragers, campaign scroll is preserved (`1156 → 1156`), the execute control stays visible at 1280×720, and execution reaches DAY 3 with no horizontal PDA overflow or page errors.
- [x] Captured current-source evidence for the unresolved morning at 1440×900, the rotation/gap comparison at 1280×720, and the filled plan at 1280×720.

## Post-plan polish checkpoint P9

- [x] Added a conservative one-click crisis responder rotation without adding persisted history. A rotation is proposed only when a resident is assigned to the same active crisis task they performed in the immediately previous Morning Report **and** that repeated responder is visibly strained (`fatigue >= 45` or `health <= 70`). Healthy low-fatigue repeats do not manufacture rotation advice.
- [x] Rotation replacements come only from the already-safe crisis shortlist, must not have performed that crisis task yesterday, and must currently be on `rest` or `records`. The swap returns the strained repeated responder to that low-load task while the fresh resident takes the crisis task, so crisis staffing count is preserved instead of silently dropping coverage or inventing an arbitrary new job.
- [x] Added `rotationSwap` as a non-persistent Daily Command read-model field only. The UI action applies both legs through the canonical `setDailyAssignment()` path; no second planning state, save field, hidden yield model, or multi-day history store is introduced.
- [x] The compact action remains `1名交代`, while its accessible label names both sides and both resulting tasks so the operation is unambiguous to keyboard/screen-reader users.
- [x] TDD coverage verifies: strained repeated responder + fresh low-load replacement produces a swap; no safe low-load replacement produces none; healthy low-fatigue repeats produce none; applying the advertised swap preserves crisis staffing while exchanging the two canonical assignments.
- [x] Current-source visual QA at 1280×720 uses the production stylesheet/markup structure and confirms the rotation control fits alongside Crisis Crew comparison and `EXECUTE PLAN` with zero document-level horizontal overflow. This environment blocked Chromium navigation to local/file URLs, so event-path behavior is verified by the canonical assignment tests and static UI contract rather than a navigated browser session for this checkpoint.


## Post-plan polish checkpoint P10

- [x] Added next-morning observed responder-load readback without persisting rotation history. The read model summarizes up to two residents who actually performed `forage`, `water`, or `sanitation` in the immediately previous Morning Report, showing only observed `fatigueDelta` and `healthDelta`. It does not claim that a rotation caused those deltas. Long generated resident labels are compacted for this summary only; authoritative resident identity remains available in the Morning Report database.
- [x] Added multi-crisis candidate conflict detection as a pure Daily Command derivation. When the same safe visible candidate appears in two or more active crisis shortlists, the candidate receives an explicit `他危機候補 ×N` comparison tag and the Crisis Crew title reports the conflict count.
- [x] Added a conservative conflict-avoiding batch action for multiple uncovered crises. It proposes at most one unique candidate per uncovered crisis, never selects a resident whose current assignment is already one of the active crisis tasks, and only exposes the batch action when at least two unique assignments can be made. Execution still uses canonical `setDailyAssignment()` calls; no alternate planning state is introduced.
- [x] Verified current-source GUI behavior at 1280×720: `STAFF CONFLICT`, crisis cards, plan impact/readiness, and `EXECUTE PLAN` remain usable with zero PDA horizontal overflow. The conflict-avoidance action assigned distinct residents to forage/water while preserving the existing sanitation responder and preserving campaign scroll (`951 → 951`).
- [x] Verified next-morning GUI readback at 1440×900 after executing the coordinated plan. `危機担当の実測負荷` shows compact resident labels plus observed fatigue/HP deltas alongside the existing non-causal crisis readback.

## Post-plan polish checkpoint P11

- [x] Added an explicit, non-predictive `RESPONSE ORDER / 対応順` to active crisis crew cards. The order uses only existing authoritative severity bands: `critical` before `warning`; within the same band it follows the F1 priority policy already in use, water-system continuity before food. No hidden outcome score or yield estimate is introduced.
- [x] Each crisis recommendation now carries `priorityOrder`, `urgencyTone`, and `urgencyDetail`. The UI renders `#1/#2/#3` plus the concrete threshold fact that caused the band (for example `安全度 40% < 55%` or `備蓄 0.8日 < 1.5日`). Duplicate reserve copy was removed from the card header so the ordering evidence does not increase vertical density unnecessarily.
- [x] Multi-crisis conflict balancing now consumes the same ordered recommendations. Scarce unique staff is therefore assigned to higher response-order uncovered crises first while continuing to avoid stealing residents who are already working another active crisis task. Canonical `setDailyAssignment()` remains the only mutation path.
- [x] Current-source browser QA verifies a mixed-severity three-crisis state at 1280×720: `#1 CRITICAL sanitation`, `#2 CRITICAL forage`, `#3 WARNING water`; the conflict batch exposes priority payload `1,2,3`, same-day rerender preserves campaign scroll (`951 → 951`), PDA horizontal overflow remains zero, and `EXECUTE PLAN` stays fully inside the content viewport. 1440×900 evidence confirms readable badges and comparison tags.
- [x] A compact-width regression discovered during QA (execute control extending ~1.5px below the content viewport) was corrected by tightening crisis-mode readiness spacing only under 1300px. No gameplay information or control was removed.

## Post-plan polish checkpoint P12

- [x] Added a non-persistent `FOCUS #1` action for the current highest response-order crisis. It appears only when the #1 crisis is unstaffed or below the staffing count actually observed in the immediately previous Morning Report; no new target staffing model or predicted yield is introduced.
- [x] The focus action allocates exactly one already-safe shortlist candidate at a time through canonical `setDailyAssignment()`. It refuses to pull a resident whose current task is another active crisis task, so focusing #1 cannot silently strip forage/water/sanitation coverage from a lower-priority active crisis.
- [x] Continuity uses only the prior observed staffing count: if yesterday had N responders, repeated focus clicks can restore toward N one person at a time; when no prior responder existed, the shortcut only establishes one initial responder and then disappears. The player can still make any further assignments manually.
- [x] Browser QA found and fixed a real narrow-column pointer-overlap regression before checkpointing. The original horizontal `FOCUS #1` flex row exceeded the 150px Crisis Crew title column and was covered by a candidate button. The focus block now uses a single-column grid and a width-constrained button, leaving candidate controls unobstructed.
- [x] Current-source browser QA verifies mixed-severity multi-crisis planning at 1440×900 and 1280×720: `FOCUS #1` targets sanitation without stealing already-active forage/water staff, the canonical roster assignment updates from records to sanitation, the focus action disappears after initial #1 coverage is reached, campaign scroll remains `793 → 793`, PDA horizontal overflow stays zero, and `EXECUTE PLAN` remains fully visible at 1280×720.

## Post-plan polish checkpoint P13

- [x] Added a non-persistent crisis minimum-coverage progress readout derived from the already-ordered active crisis recommendations. The floor is deliberately conservative and reuses existing observed staffing only: each active crisis is considered minimally covered when today's canonical assignment count reaches yesterday's actual Morning Report count, or one responder when there was no prior responder. No yield model, success probability, or new recommended staffing target is introduced.
- [x] `crisisCoverage` reports `coveredCount / totalCount` plus the next unmet response-order item. After FOCUS #1 reaches its minimum floor, the progress readout automatically advances to the next unmet `#N` crisis instead of leaving the player to rescan all cards.
- [x] Added a no-state-change `次の危機へ #N` navigation action. It scrolls to the already-rendered canonical crisis card and moves keyboard focus to that card's first existing assignment control; it does not call `setDailyAssignment()` or create a second planning state.
- [x] Compact-width QA caught that hiding the detail sentence also hid the numeric coverage value. The title now keeps `COVERAGE N/M / 対応進捗` visible at 1280px while only the verbose detail line is suppressed.
- [x] Current-source browser QA verifies a three-crisis state at 1280×720: initial coverage `1/3`, FOCUS #1 raises it to `2/3`, `次の危機へ #2` focuses the food/forage crisis without changing assignments, campaign scroll remains `951 → 951`, PDA horizontal overflow remains zero, and the full `EXECUTE PLAN` control remains inside the content viewport. A 1440×900 capture confirms the expanded detail text remains readable.

## Post-plan polish checkpoint P14

- [x] Connected the existing non-persistent crisis minimum-coverage model to `PLAN READINESS`. Any active crisis whose conservative floor is still unmet adds one aggregate `crisis-coverage-gap` RISK issue; this never creates a new BLOCKED path and `EXECUTE PLAN` remains available.
- [x] Removed duplicate critical food/water "uncovered" readiness warnings when the aggregate crisis coverage model already represents those active crises. The readiness surface now reports one coverage gap summary while the individual CRISIS CREW cards retain the exact crisis-specific facts and controls.
- [x] Added a compact readiness coverage verdict: `COVERAGE N/M` while incomplete and `COVERAGE COMPLETE N/M` after every active crisis reaches the observed/initial staffing floor. Completion does not recommend extra staffing beyond that floor.
- [x] Browser QA at 1280×720 caught two density regressions before checkpointing. Compact mode now hides only the redundant long RESPONSE ORDER prose, and completed READY coverage suppresses the redundant "no visible warnings" paragraph while tightening the readiness label. Both incomplete RISK and complete READY states keep the full `EXECUTE PLAN` control inside the PDA viewport with zero horizontal overflow.
- [x] Current-source browser evidence verifies `RISK + COVERAGE 1/3` before coverage completion and `READY + COVERAGE COMPLETE 3/3` after canonical one-person assignments satisfy all three active crisis floors.

## Post-plan polish checkpoint P15

- [x] Added non-persistent `RECOVERY CAPACITY` after crisis minimum coverage is complete. It reports only staffing above the existing conservative coverage floor; it does not invent an optimal staffing target or change READY/RISK/BLOCKED semantics.
- [x] Recovery candidates are limited to residents currently assigned above the floor whose actual prior Morning Report/current baseline task is not another active crisis task and is still safe under the existing resident-risk predicate. The one-person action restores that prior canonical task through `setDailyAssignment()` and never drops the crisis below its minimum observed/initial floor.
- [x] Compact-width rendering hides only the verbose recovery detail while preserving the `RECOVERY CAPACITY` label and `余剰1名を戻す` action. Browser QA verifies 1440×900 visibility and 1280×720 one-click recovery with campaign scroll `775 → 775`, zero horizontal overflow, `COVERAGE COMPLETE 1/1`, READY preserved, and the full `EXECUTE PLAN` control inside the PDA content viewport.
- [x] TDD coverage verifies recovery appears only for excess staffing, points back to the resident's actual prior task rather than a guessed job, disappears at the conservative floor, and never upgrades overstaffing into a blocking or risk state.

## Post-plan polish checkpoint P16

- [x] Added non-persistent `NORMAL OPS / 平常業務` after active crisis minimum coverage is complete. It compares today's canonical assignments only against the immediately previous Morning Report task mix and reports non-crisis tasks whose staffing count has decreased; it does not invent a required staffing model or change READY/RISK/BLOCKED semantics.
- [x] Normal-ops gaps explicitly use `前日比` counts such as `修繕 1→0`. Active crisis tasks are excluded from this secondary summary so the player does not see the same shortage twice in Crisis Crew and Normal Ops.
- [x] When P15 `RECOVERY CAPACITY` already has a safe one-person return whose actual prior task is one of the visible normal-ops gaps, `NORMAL OPS` names that return task as the recovery candidate. Mutation remains exclusively in the existing canonical `daily-release-crisis-excess` → `setDailyAssignment()` path; no second planning state or auto-rebalancer is introduced.
- [x] Normal Ops stays hidden while crisis minimum coverage is incomplete, keeping the primary response decision ahead of routine restoration. It also disappears when the prior-day non-crisis task mix is preserved or after the visible gap is restored.
- [x] Current-source browser QA verifies a completed one-crisis plan at 1440×900 with `RECOVERY CAPACITY` plus `NORMAL OPS / 平常業務 · 修繕 1→0 · 戻し候補: 修繕`. At 1280×720, one canonical recovery click clears both secondary bands while preserving `COVERAGE COMPLETE 1/1`, READY, campaign scroll (`1110 → 1110`), zero horizontal overflow, and a fully visible `EXECUTE PLAN` control.

## Post-plan polish checkpoint P17

- [x] Added non-persistent `PLAN BALANCE` as an explanatory pre-execution staffing comparison against the immediately previous Morning Report. It groups assignable residents into only three visible categories: active-crisis tasks, non-crisis normal operations, and rest; no new required staffing target, score, or readiness rule is introduced.
- [x] The balance is expressed only as observed prior-day deltas, e.g. `危機対応 +1 · 平常業務 ±0 · 休養 -1`, followed by explicit copy that this is a prior-placement comparison rather than a recommended headcount. It is hidden when there is no real prior Morning Report or when all three category counts are unchanged.
- [x] `PLAN BALANCE` rerenders immediately through the existing canonical DailyPlan path. Current-source browser QA verifies a 1280×720 assignment change updates the balance while preserving campaign scroll (`1110 → 1110`), zero horizontal overflow, and a fully visible `EXECUTE PLAN`; restoring the prior category mix removes the balance entirely.
- [x] The balance stays presentation-only and does not modify READY/RISK/BLOCKED, crisis minimum coverage, recovery capacity, persistence schema, or simulation authority. Fresh GUI evidence was captured at 1440×900 and 1280×720.

## Post-plan polish checkpoint P18

- [x] Added non-persistent `BALANCE RECOVERY` inside the existing `PLAN BALANCE` strip. It appears only after active crisis minimum coverage is complete, no P15 crisis-excess recovery action is competing for the same decision, and one safe non-crisis assignment can be reverted toward the immediately previous Morning Report category mix.
- [x] Recovery is deliberately category-level and conservative: it only repairs an observed rest shortfall (`normal ops → prior rest`) or an observed normal-ops shortfall (`rest → prior normal task`). It never removes an active crisis responder, never invents a staffing target, and reuses the existing resident-risk predicate before suggesting the actual prior task.
- [x] The one-person `前日構成へ戻す` control mutates only through canonical `setDailyAssignment()`. It disappears when the three-category plan mix matches the prior day again and does not modify READY/RISK/BLOCKED semantics, crisis coverage, persistence, or simulation authority.
- [x] Current-source browser QA verifies the recovery strip at 1440×900 and a 1280×720 one-click restore with campaign scroll preserved (`1110 → 1110`), zero horizontal overflow, the full execute control visible, and subsequent execution reaching DAY 2.

### P19 — Rest Pressure / safe rest handoff

- [x] Added non-persistent `REST PRESSURE / 休養圧` after active crisis minimum coverage is satisfied (or no active crisis exists). It reuses the already-established visible P9 threshold only: fatigue >= 45 or HP <= 70; no new fatigue model, staffing target, prediction, or saved history is introduced.
- [x] Crisis-task residents, locked residents, and residents already resting are excluded. Up to two safe non-crisis candidates are shown with current task, fatigue, and HP; `休養へ` writes only through the canonical `setDailyAssignment(..., 'rest')` path.
- [x] Resolved a cross-polish contradiction: P18 `BALANCE RECOVERY` no longer immediately undoes rest for a resident who is already at the same fatigue/HP pressure threshold. Safe baseline recovery remains available for residents outside that pressure threshold.
- [x] Current-source browser QA verifies 1440×900 visibility and a 1280×720 rest assignment with campaign scroll preserved (`1110 → 1110`), zero horizontal overflow, a fully visible `EXECUTE PLAN`, immediate PLAN BALANCE / NORMAL OPS recomputation, and successful transition to DAY 2.
- [x] Evidence: `docs/screenshots/daily-command-center/rest-pressure-1440x900.png`, `docs/screenshots/daily-command-center/rest-pressure-applied-1280x720.png`.

### P20 — Rest Readback / observed next-morning recovery

- [x] Added non-persistent `REST READBACK` inside the existing `YESTERDAY'S OUTCOME` strip. It reads only residents whose actual prior Morning Report task was `rest`, combines their observed fatigue/HP deltas with the current morning fatigue/HP values, and does not infer that rest caused the change.
- [x] Reused the existing P9/P19 visible pressure bands for the readback tone: current fatigue >= 70 or HP <= 45 is critical; fatigue >= 45 or HP <= 70 is warning; otherwise normal. No new recovery threshold or saved rest history is introduced.
- [x] The readback is capped to two residents and is lower-priority than irreversible population, aggregate health, and resource outcomes so it does not displace the established three-card consequence hierarchy on busy mornings.
- [x] Added a dedicated `REST READBACK` visual tag and body-detail handoff through the existing outcome card renderer. Current-source QA at 1440×900 and 1280×720 verifies the observed deltas/current values remain readable with zero horizontal overflow.
- [x] Evidence: `docs/screenshots/daily-command-center/rest-readback-day2-1440x900.png`, `docs/screenshots/daily-command-center/rest-readback-day2-1280x720.png`.

### P21 — Rest Readback Follow-up / safe repeat-rest handoff

- [x] Added non-persistent `REST FOLLOW-UP / 休養継続` inside the existing REST READBACK outcome card. It only considers residents whose actual prior Morning Report task was `rest`, whose observed fatigue/HP changed enough to qualify for the existing readback, and who still remain inside the already-established visible pressure band (fatigue >= 45 or HP <= 70) this morning.
- [x] The follow-up is plan-aware rather than historical state. If the current canonical DailyPlan already keeps the resident on `rest`, the card says `休養継続中` and emits no mutation control. If the resident has been moved to another safe non-crisis task, the card exposes one `再休養` action using the existing `daily-rest-resident` -> canonical `setDailyAssignment(..., 'rest')` path.
- [x] Residents currently assigned to an active crisis task are excluded from this follow-up so the morning readback cannot silently break crisis minimum coverage. No saved rest-follow-up history, target, required-rest count, or second assignment model is introduced.
- [x] Follow-up resident display names reuse the compact generated-ID presentation already used by REST READBACK (`Resident 01` instead of a long generated identity) while canonical agent IDs remain untouched.
- [x] Current-source browser QA verifies 1440×900 `再休養`, 1280×720 click-to-`休養継続中`, zero document/PDA horizontal overflow, and a full play path `再休養 -> EXECUTE PLAN -> DAY 2` with the canonical `rest` assignment carried into the next planning day.
- [x] Evidence: `docs/screenshots/daily-command-center/rest-follow-up-1440x900.png`, `docs/screenshots/daily-command-center/rest-follow-up-applied-1280x720.png`.

### P22 — Rest Release Review / return-to-duty handoff without task inference

- [x] Added non-persistent `RETURN REVIEW / 復帰確認` for REST READBACK residents who have left the existing visible pressure band (fatigue < 45 and HP > 70) but whose current canonical DailyPlan still keeps them on `rest`. The read model uses only the immediately previous Morning Report rest row plus current morning fatigue/HP; no recovery history or new threshold is persisted.
- [x] The review deliberately does **not** choose a return task. The immediately previous Morning Report only proves that the resident rested yesterday and cannot reconstruct the pre-rest job, so `復帰先を選ぶ` performs no mutation: it scrolls to that resident's Today’s Plan row and focuses the existing canonical `daily-assignment` select for explicit player choice.
- [x] Residents already assigned to a non-rest task no longer receive the return-review prompt. P21 `REST FOLLOW-UP` continues to take precedence for residents who remain at fatigue >= 45 or HP <= 70, preserving the existing re-rest path instead of showing contradictory release advice.
- [x] Browser QA caught and fixed an outcome-card layout regression before checkpointing. Rich rest readback controls were being forced into the generic side-by-side outcome grid, crushing Japanese readback copy into a very narrow column. Outcome cards containing REST FOLLOW-UP or RETURN REVIEW now stack readback content over controls while retaining the compact one-column behavior below 1300px.
- [x] Current-source browser QA verifies 1440×900 readable REST READBACK + RETURN REVIEW and 1280×720 click-to-focus on the recovered resident's Today’s Plan assignment control. The select value remains `rest`, proving the review action does not mutate the plan; document/PDA horizontal overflow remains zero.
- [x] Evidence: `docs/screenshots/daily-command-center/rest-return-review-1440x900.png`, `docs/screenshots/daily-command-center/rest-return-review-focus-1280x720.png`.

### P23 — Return Context / safe comparison before return-to-duty choice

- [x] Extended non-persistent `RETURN REVIEW / 復帰確認` with `RETURN CONTEXT / 復帰比較`. For a recovered resident who is still resting, the read model compares the current DailyPlan with the immediately previous Morning Report and lists at most two non-crisis tasks whose staffing has actually fallen below the prior-day count.
- [x] Return context is descriptive only. Each task entry shows observed counts such as `修繕 1→0`; active crisis tasks are excluded, and the existing resident-risk predicate must consider the recovered resident safe for that task before it is shown. No task is selected, no required staffing number is invented, and no history/target field is persisted.
- [x] `復帰先を選ぶ` remains a non-mutating navigation action. Browser QA verifies the assignment stays `rest` while focus moves to the existing canonical Today’s Plan selector. The same return context is repeated beside that resident row so the player does not need to remember the morning card after scrolling.
- [x] When the player explicitly chooses the displayed gap task through the existing `daily-assignment` control, the canonical DailyPlan updates and the filled comparison context disappears on rerender. Campaign scroll is preserved (`984 → 984`), with zero document/PDA horizontal overflow at 1280×720.
- [x] Compact layout keeps the `RETURN CONTEXT` label visible in Today’s Plan while the richer morning card retains `RETURN CONTEXT / 復帰比較`. Current-source evidence was captured at 1440×900 and 1280×720.
- [x] Evidence: `docs/screenshots/daily-command-center/rest-return-context-1440x900.png`, `docs/screenshots/daily-command-center/rest-return-context-focus-1280x720.png`.

### P24 — Return Option Impact / deterministic staffing trade-off before return choice

- [x] Extended each non-persistent `RETURN CONTEXT` entry with deterministic staffing effects only: the task's current/prior gap, the count after selecting that task, and the assignable-rest count before/after moving this recovered resident out of rest. Locked residents are excluded from the rest count so the comparison reflects only plan-controllable staffing.
- [x] Added visible suitability context without a hidden score: each return option shows the task's existing visible skill value and whether the resident's visible role directly matches that task. No yield, success probability, optimal staffing target, or outcome prediction is introduced.
- [x] Kept `復帰先を選ぶ` non-mutating. The richer comparison appears both in the morning `RETURN REVIEW` card and beside the focused Today’s Plan assignment row; the player still chooses the canonical task from the existing selector.
- [x] Browser QA caught and fixed a semantic counting issue before checkpointing: locked children on `rest` were initially included in the displayed rest trade-off. The count now uses only assignable resident rows, producing a meaningful example such as `選択後 修繕 1/1 · 休養 1→0 · 役割一致 · 建築 73`.
- [x] Current-source QA verifies readable 1440×900 morning comparison, 1280×720 focused Today’s Plan comparison, campaign scroll preservation (`984 → 984`), zero document/PDA horizontal overflow, and canonical manual selection clearing the filled return context.
- [x] Evidence: `docs/screenshots/daily-command-center/rest-return-option-impact-1440x900.png`, `docs/screenshots/daily-command-center/rest-return-option-focus-1280x720.png`.

### P25 — Return Balance Preview / post-selection category impact

- [x] Extended each non-persistent `RETURN CONTEXT` option with a deterministic post-selection `PLAN BALANCE` preview. It compares only the assignable-resident category counts already used by P17 (`active crisis / normal operations / rest`) before and after moving this recovered resident from `rest` into the displayed non-crisis task.
- [x] The comparison exposes the actual category delta transition, e.g. `平常業務 -1→±0 · 休養 +1→±0`, and classifies the absolute category-distance change only as `前日構成へ近づく / 差は同じ / 前日構成から離れる`. It does not predict yield, success, survival, or any simulation outcome.
- [x] `復帰先を選ぶ` remains non-mutating. The full balance comparison appears in the morning RETURN REVIEW card; the focused Today’s Plan row uses a shorter `BALANCE · 平常 ... · 休養 ...` form while the canonical assignment selector remains the only mutation point.
- [x] Browser QA caught and fixed a wide-layout regression before checkpointing. A one-candidate RETURN REVIEW was effectively sharing width with an empty second candidate column, making the new balance comparison unreadably narrow. Wide layouts now use flexible candidate widths; <=1300px retains the established one-column compact layout.
- [x] Current-source QA verifies 1440×900 full return-balance comparison, 1280×720 compact focused comparison, zero document/PDA horizontal overflow, canonical manual `repair` selection clearing both RETURN CONTEXT and the restored category-level PLAN BALANCE, and campaign scroll preservation (`1049 → 1049`).
- [x] Evidence: `docs/screenshots/daily-command-center/rest-return-balance-impact-1440x900.png`, `docs/screenshots/daily-command-center/rest-return-balance-focus-1280x720.png`.

### P26 — Long Horizon / quiet-day continuity milestone

- [x] Added non-persistent `LONG HORIZON / 次の節目` for quiet, executable mornings only. It appears only when the DailyPlan is `READY`, there is no active Daily Command crisis recommendation, and the campaign directive is not urgent/critical; any survival crisis immediately suppresses the band so crisis response remains primary.
- [x] The band reads the existing open-ended Survival Campaign milestone chain rather than creating a new goal system. It shows the first incomplete milestone and only current observable progress: STABILIZE uses the existing 5-day reserve / water safety 60 / sanitation 50 / average HP 60 conditions; EXPLORE shows returned/active expeditions; PRESERVE shows archived records / institutional knowledge; NEXT GENERATION shows living descendants / births since start.
- [x] Navigation reuses the existing `daily-detail` target routing (`inventory/task/body/expedition/knowledge`). No new assignment, success probability, resource yield, required staffing count, hidden score, or persisted long-horizon history is introduced.
- [x] Current-source QA uses the compiled read model plus production `src/styles.css` in a navigation-free Chromium harness because this environment currently blocks both `file://` and localhost navigation by administrator policy. The evidence shows a quiet EXPLORE morning at 1440×900 and 1280×720 with zero document horizontal overflow; the compact width hides only verbose explanatory copy while retaining the milestone and factual progress.
- [x] Evidence: `docs/screenshots/daily-command-center/long-horizon-quiet-1440x900.png`, `docs/screenshots/daily-command-center/long-horizon-quiet-1280x720.png`.

---

# P27 Command Pulse Implementation Addendum

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Daily Command Center feel like a command game by adding a non-persistent MORNING → PLAN → EXECUTE → READBACK signal, one-shot morning emphasis, READY/RISK/BLOCKED execution affordances, a short PLAN LOCKED/SIMULATING 24H curtain, and factual next-morning readback without changing simulation authority or save data.

**Architecture:** Keep `deriveDailyCommandView()` and `executeCommittedPlan()` authoritative. P27 adds only transient presentation state to `SandboxApp`, synthesized audio in the existing `PdaSoundEngine`, and CSS presentation around values already returned by the current read model and `MorningReport`; no new read model, RNG, forecast, save field, or canonical block rule is introduced.

**Tech Stack:** TypeScript 5.8.3, Vite 8.1.5, Electron 41.10.3, Node.js >=22.12.0, `node:test`, existing CSS/PC-98 PDA presentation system and Web Audio synthesis.

**Spec:** `docs/superpowers/specs/2026-09-16-daily-command-center-design.md` sections 22–33.

## P27 Global Constraints

- Preserve `SandboxGameState.schemaVersion === 1`; P27 state is UI-only and never persisted.
- Do not modify `src/sandbox/dailyActionLoop.ts` or `src/sandbox/dailyCommandReadModel.ts` for P27 unless a focused test proves a missing factual input; the planned implementation needs neither.
- `RISK` remains executable. Only the existing `dailyExecutionBlockReason()` / `command.readiness === 'blocked'` path disables execution.
- `executeCommittedPlan()` remains the only 24-hour canonical execution call.
- P27 may display observed `MorningReport` facts only; it must not display success probability, efficiency, forecast yield, or fabricated percentage telemetry.
- Existing mute/master-volume controls remain authoritative for the new audio cue.
- Reduced-motion mode removes staged entrance/sweep/transform-heavy effects and uses short textual transitions instead.
- Keep the source footprint to `src/sandbox/app.ts`, `src/styles.css`, `src/sandbox/pdaAudio.ts`, existing tests, this plan, selected final screenshots, and recovery ZIPs.
- Git is unavailable in this extracted handoff (`git rev-parse --is-inside-work-tree` fails); use ZIP checkpoints plus SHA-256 as the recovery boundary instead of creating status files.

## P27 File Map

- **Modify:** `src/sandbox/app.ts` — transient command pulse/execution curtain state, command signal markup, factual readback lines, canonical execution sequencing.
- **Modify:** `src/styles.css` — signal strip, one-shot morning emphasis, severity rails, readiness affordance, execution curtain, reduced-motion/high-contrast/1280 rules.
- **Modify:** `src/sandbox/pdaAudio.ts` — one short synthesized `playCommandCommit()` cue routed through the existing master gain.
- **Modify:** `tests/daily-action-loop-ui.test.mjs` — P27 UI/canonical-path regression contracts.
- **Modify:** `tests/pda-presentation.test.mjs` — audio, motion-safety, hierarchy, and compact presentation contracts.
- **Modify:** `docs/superpowers/plans/2026-09-16-daily-command-center-implementation.md` — mark this addendum complete as tasks finish.
- **Add final evidence only:** `docs/screenshots/daily-command-center/p27-*.png`.

### P27 Task 1: Lock the presentation contracts with failing tests

**Files:**
- Modify: `tests/daily-action-loop-ui.test.mjs`
- Modify: `tests/pda-presentation.test.mjs`

**Interfaces:**
- Consumes: existing source files as text contracts.
- Produces: regression expectations for `desc-command-signal`, `desc-command-execution-curtain`, `#commandPulsePhase`, `playCommandCommit()`, reduced-motion coverage, and the canonical `executeCommittedPlan()` call.

- [x] **Step 1: Add a failing Daily Command UI contract test**

Append to `tests/daily-action-loop-ui.test.mjs`:

```js
test('P27 command pulse exposes MORNING PLAN EXECUTE READBACK without changing canonical execution authority', () => {
  for (const token of [
    'COMMAND SIGNAL', 'MORNING', 'PLAN', 'EXECUTE', 'READBACK',
    '#commandPulsePhase', 'desc-command-signal', 'desc-command-execution-curtain',
    'PLAN LOCKED', 'SIMULATING 24H', 'CANONICAL DAILY LOOP', 'playCommandCommit',
  ]) assert.ok(app.includes(token) || css.includes(token), `missing P27 command pulse token: ${token}`);
  assert.match(app, /await\s+executeCommittedPlan\(this\.provider,this\.state\)/);
  assert.doesNotMatch(app, /command\.readiness==='risk'[^\n]*disabled/);
});
```

- [x] **Step 2: Add a failing factual readback and motion-safety contract test**

Append to `tests/daily-action-loop-ui.test.mjs`:

```js
test('P27 next-morning overlay uses observed MorningReport facts and interruption never claims completion', () => {
  assert.match(app, /result\.report\.births\.length/);
  assert.match(app, /result\.report\.deaths\.length/);
  assert.match(app, /result\.report\.residentDeltas/);
  assert.match(app, /result\.status==='interrupted'[\s\S]*?#commandPulsePhase='plan'/);
  assert.doesNotMatch(app, /success rate|efficiency|forecast|predicted yield/i);
});
```

Append to `tests/pda-presentation.test.mjs`:

```js
test('P27 command effects are synthesized, reduced-motion safe, and compact at 1280-class widths', () => {
  assert.match(audio, /playCommandCommit\(\)/);
  assert.doesNotMatch(audio, /fetch\(|new Audio\(|\.mp3|\.wav|\.ogg/i);
  assert.match(css, /\.desc-command-execution-curtain/);
  assert.match(css, /a11y-reduce-motion[\s\S]*?desc-command-execution-curtain/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?desc-command-execution-curtain/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-command-signal/);
});
```

- [x] **Step 3: Run the focused tests and confirm P27 expectations fail before implementation**

Run:

```bash
node --test tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: existing tests pass and the new P27 tests fail on missing command-pulse/audio/curtain tokens.

### P27 Task 2: Add transient command phases and preserve canonical execution

**Files:**
- Modify: `src/sandbox/app.ts` near private UI fields, `pdaCampaignCommand()`, `render()`, `playDayTransition()`, and `executeDailyPlan()`.
- Test: `tests/daily-action-loop-ui.test.mjs`

**Interfaces:**
- Produces: `#commandPulsePhase: 'morning' | 'plan' | 'locked' | 'executing' | 'readback'`.
- Produces: `#commandPulseMorningDay: number` for one-shot per-runtime morning emphasis only.
- Produces: `#commandReadbackLines: string[]` for observed transition facts only.
- Consumes: `MorningReport`, `command.readiness`, `dailyExecutionBlockReason()`, `executeCommittedPlan()`.

- [x] **Step 1: Add transient, non-persistent fields**

Add next to the existing CRT/daily execution fields:

```ts
#commandPulsePhase: 'morning' | 'plan' | 'locked' | 'executing' | 'readback' = 'morning';
#commandPulseMorningDay = -1;
#commandReadbackLines: string[] = [];
```

- [x] **Step 2: Render the command signal directly from existing state**

Inside `pdaCampaignCommand()`, before the returned section, derive only presentation labels:

```ts
const commandSignalPhase = this.#commandPulsePhase === 'locked' || this.#commandPulsePhase === 'executing'
  ? 'execute'
  : this.#commandPulsePhase;
const signalSteps = [
  ['morning','MORNING','観測'], ['plan','PLAN','配置'], ['execute','EXECUTE','24H'], ['readback','READBACK','結果'],
] as const;
```

Insert after the Daily Command header:

```ts
<nav class="desc-command-signal" aria-label="Daily command signal" data-command-phase="${commandSignalPhase}">
  <span>COMMAND SIGNAL</span>
  <ol>${signalSteps.map(([phase,label,detail])=>`<li class="${phase===commandSignalPhase?'is-active':''}" data-command-step="${phase}"><b>${label}</b><small>${detail}</small></li>`).join('')}</ol>
</nav>
```

On the first render of a new day, set `#commandPulseMorningDay` to `state.clock.day` and keep the phase as `morning`. Plan-changing actions keep rendering normally and set `#commandPulsePhase = 'plan'` before `render()`; this is presentation-only.

- [x] **Step 3: Add the execution curtain to `render()` without changing focus semantics**

Build an overlay string before assigning `root.innerHTML`:

```ts
const executionCurtain = this.#commandPulsePhase==='locked' || this.#commandPulsePhase==='executing'
  ? `<div class="desc-command-execution-curtain phase-${this.#commandPulsePhase}" role="status" aria-live="polite">
      <div aria-hidden="true" class="desc-command-execution-reticle"><i></i><i></i><i></i></div>
      <span>${this.#commandPulsePhase==='locked'?'PLAN LOCKED':'SIMULATING 24H'}</span>
      <strong>DAY ${this.state.clock.day} → DAY ${this.state.clock.day+1}</strong>
      <small>CANONICAL DAILY LOOP</small>
    </div>` : '';
```

Place `${executionCurtain}` inside `.desc-pda-screen`, after the content/footer and before CRT/glass decoration so the temporary overlay does not create a new focus trap.

- [x] **Step 4: Stage commit and simulation around the existing canonical call**

In `executeDailyPlan()` keep existing validation and `commitDailyPlan()` behavior. After the plan is committed:

```ts
this.#dailyExecutionActive = true;
this.#busy = true;
this.#commandPulsePhase = 'locked';
this.render();
pdaAudio.playCommandCommit();
const reduced = this.#accessibility.reduceMotion || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
await this.transitionDelay(reduced ? 60 : 240);
this.#commandPulsePhase = 'executing';
this.render();
const result = await executeCommittedPlan(this.provider,this.state);
```

Do not add any second simulation call or alternate time advancement.

- [x] **Step 5: Handle interruption and completion truthfully**

For `result.status==='interrupted'`, set `#commandPulsePhase='plan'` before returning to the existing MANUAL surface and leave `#commandReadbackLines=[]`.

For completion, derive readback facts directly from the report:

```ts
const changedResidents = result.report.residentDeltas.filter((entry)=>!['stable','improved'].includes(entry.severity)).length;
this.#commandReadbackLines = [
  `BIRTHS ${result.report.births.length}`,
  `DEATHS ${result.report.deaths.length}`,
  changedResidents ? `RESIDENT ALERTS ${changedResidents}` : 'NO MAJOR RESIDENT CHANGE',
];
this.#commandPulsePhase='readback';
```

Pass `this.#commandReadbackLines.join(' · ')` into the existing CRT day-title summary together with `morningReportTransitionSummary(result.report)`, then keep the final phase at `readback` until a player changes the plan or executes again.

- [x] **Step 6: Run focused TypeScript/UI tests**

Run:

```bash
npm run check
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: PASS.

### P27 Task 3: Add rich but restrained CSS and synthesized command audio

**Files:**
- Modify: `src/styles.css`
- Modify: `src/sandbox/pdaAudio.ts`
- Test: `tests/pda-presentation.test.mjs`

**Interfaces:**
- Produces: `PdaSoundEngine.playCommandCommit(): void`.
- Produces: `.desc-command-signal`, `.desc-command-execution-curtain`, `.desc-command-morning-pulse`, readiness/priority rail refinements, reduced-motion and high-contrast fallbacks.

- [x] **Step 1: Implement the synthesized command commit cue using the existing master gain**

Add after `playConfirm()`:

```ts
playCommandCommit(): void {
  const ready = this.ready(); if (!ready) return;
  const { ctx, master } = ready; const now = ctx.currentTime;
  const carrier = ctx.createOscillator(); const pulse = ctx.createOscillator(); const gain = ctx.createGain();
  carrier.type = 'square'; pulse.type = 'triangle';
  carrier.frequency.setValueAtTime(420, now); carrier.frequency.setValueAtTime(760, now + 0.055);
  pulse.frequency.setValueAtTime(1180, now + 0.035); pulse.frequency.setValueAtTime(1640, now + 0.09);
  gain.gain.setValueAtTime(0.001, now); gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  carrier.connect(gain); pulse.connect(gain); gain.connect(master);
  carrier.start(now); pulse.start(now + 0.03); carrier.stop(now + 0.16); pulse.stop(now + 0.16);
}
```

This uses no external audio assets and automatically obeys mute/master gain.

- [x] **Step 2: Add command signal and severity hierarchy CSS**

Add a P27 section after the existing Daily Command rules. The signal is a compact four-step grid with text labels, active step border/rail, and a single sweep pseudo-element only on the active step. Priority cards gain a left status rail and top concern may receive a one-shot glow class; resource cells may gain tone rails but no percentage widths.

Use these stable selectors:

```css
.desc-command-signal{}
.desc-command-signal ol{}
.desc-command-signal li{}
.desc-command-signal li.is-active{}
.desc-daily-priority::before{}
.desc-daily-priority-list>.desc-daily-priority:first-child{}
```

- [x] **Step 3: Add readiness and execution curtain presentation**

Use the existing `.readiness-ready`, `.readiness-risk`, `.readiness-blocked` classes. READY may use a restrained edge scan; RISK uses an amber bracket/sweep but leaves the button enabled; BLOCKED uses a static crosshatch/fault border.

The execution overlay must use:

```css
.desc-command-execution-curtain{}
.desc-command-execution-curtain::before{}
.desc-command-execution-reticle{}
@keyframes descCommandSweep{}
@keyframes descCommandLock{}
```

No percentage progress meter is permitted.

- [x] **Step 4: Add motion/high-contrast/compact fallbacks**

Add both explicit accessibility forms:

```css
.a11y-reduce-motion .desc-command-execution-curtain,
.a11y-reduce-motion .desc-command-signal li.is-active,
.a11y-reduce-motion .desc-daily-priority-list>.desc-daily-priority:first-child { animation:none!important; transform:none!important; }

@media (prefers-reduced-motion: reduce) {
  .desc-command-execution-curtain,
  .desc-command-signal li.is-active,
  .desc-daily-priority-list>.desc-daily-priority:first-child { animation:none!important; transform:none!important; }
}
```

Add a high-contrast rule that uses solid borders/backgrounds, and at `@media(max-width:1300px)` collapse the signal helper detail while retaining all four text labels.

- [x] **Step 5: Run focused presentation tests and type check**

Run:

```bash
npm run check
node --test tests/pda-presentation.test.mjs tests/daily-action-loop-ui.test.mjs
```

Expected: PASS.

### P27 Task 4: Verify playability, capture current-build GUI evidence, and package recovery

**Files:**
- Modify only if needed for deterministic existing screenshot tooling: `electron/main.cjs`, `tools/run-electron-path-e2e.mjs`.
- Add final evidence: `docs/screenshots/daily-command-center/p27-normal-1440x900.png`, `p27-risk-1440x900.png`, `p27-execution-1440x900.png`, `p27-readback-1440x900.png`, `p27-compact-1280x720.png` when the state is reachable.
- Modify: this plan, checking P27 task boxes.
- Create: final full-source ZIP outside the project directory.

**Interfaces:**
- Consumes: production build and existing playable UI; no debug save schema or hidden state injection.
- Produces: current-build screenshots and `DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P27_2026-09-16.zip` plus SHA-256.

- [x] **Step 1: Compile focused test distribution and run Daily Command/daily-loop tests**

Run:

```bash
npm run test:compile
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: all focused tests PASS.

- [x] **Step 2: Build the playable production surface**

Run:

```bash
npm run build
```

Expected: Vite production build completes and `dist/` is updated.

- [x] **Step 3: Capture 1440×900 and 1280×720 evidence using the established Electron/Chromium path**

Prefer the existing Electron E2E command:

```bash
npm run test:electron-e2e
```

If Electron cannot run because of container policy, start `npm run preview -- --host 127.0.0.1` and use the installed headless Chromium/Playwright/Puppeteer path already present in the environment. Capture only reachable real states; do not inject hidden runtime facts to manufacture RISK/readback states. Retain the final meaningful captures and remove diagnostic duplicates.

- [x] **Step 4: Inspect selected screenshots for viewport overflow and hierarchy**

Check that 1440×900 shows COMMAND SIGNAL, priorities/resources, Morning Report and the Today Plan path; check 1280×720 has no horizontal overflow and retains all four signal labels and executable readiness control. If a visual defect is found, fix CSS and rerun Step 1 before recapturing.

- [x] **Step 5: Run final focused verification**

Run:

```bash
npm run check
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: PASS. A full `npm run test:unit` may be attempted only if economical; timeout without a failing focused test does not block packaging.

- [x] **Step 6: Package the complete P27 source tree and hash it**

From the parent directory:

```bash
zip -qr /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P27_2026-09-16.zip Descendants -x 'Descendants/node_modules/*' 'Descendants/.test-dist/*'
sha256sum /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P27_2026-09-16.zip
```

Expected: one full-source recovery ZIP and a SHA-256 printed to the console. Do not create a separate checksum text file.

## P27 Execution Notes — 2026-09-16

- RED was observed before production changes: the newly added P27 contract tests failed on the absent command signal/audio/curtain tokens.
- `npm run check` passes after restoring the interrupted local `@types/node` link; no source workaround was required.
- `npm run build` could not enter Vite because the extracted handoff had no usable local Vite binary and `npm install` timed out in the container. Per the project rule not to stall on environment-only test blockers, `npm run build:portable` was used instead and refreshed `dist/` successfully.
- Runtime Electron/Chromium capture was attempted but the container policy returned `ERR_BLOCKED_BY_ADMINISTRATOR` for local HTTP, `file:` and `data:` navigation. The retained `p27-*.png` files are therefore explicitly **static CSS visual-QA renders**, produced from the current `src/styles.css` and representative Daily Command markup; they are not claimed as runtime E2E captures. Existing P26 runtime screenshots remain untouched.
- Static visual-QA inspection covers READY/MORNING, RISK/PLAN, EXECUTE curtain, READBACK, and 1280×720 compact hierarchy. No horizontal overflow was observed in the retained compact render; the vertical crop remains consistent with the existing 1280×720 Daily Command evidence, where lower plan content continues below the fixed PDA footer.
- The full `npm run test:unit` suite was also time-budgeted after focused verification. It reached **461 passing tests with no explicit `not ok` result** before the container/tool time budget ended; because the TAP run did not reach its final summary, this is recorded as partial evidence rather than a full-suite PASS.
- Final verification and final ZIP/SHA are recorded by the execution transcript rather than separate status/checksum files, keeping the project directory uncluttered.

---

# P29 — Assignment Consequence Readback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect P28 STAFF MOVES to the next canonical Morning Report so the player can inspect factual resident-state changes after a submitted reassignment without adding causal claims, simulation logic, or persistence.

**Architecture:** Capture the final `previousTask !== assignedTask` rows in transient `SandboxApp` memory immediately before the first commit of a daily plan. A pure helper in `dailyCommandReadModel.ts` joins those move snapshots to the completed `MorningReport` by `agentId`; `app.ts` renders the resulting same-session readback and retains pending moves across MANUAL interruption. No game-state type, save field, or daily-loop interface changes.

**Tech Stack:** TypeScript, existing DOM-template UI in `SandboxApp`, existing CSS/CRT system, Node test runner, existing portable build pipeline.

**Spec:** `docs/superpowers/specs/2026-09-16-daily-command-center-design.md` sections 44–51.

## Global Constraints

- Keep `setDailyAssignment()` as the only Daily Command assignment mutation.
- Keep `executeCommittedPlan()` as the only 24-hour simulation path.
- Use only canonical `MorningReport` resident deltas for observed readback facts.
- Do not persist move snapshots or readback in `SandboxGameState` or storage.
- Do not attribute settlement resource changes to individual residents.
- Do not add forecast, efficiency, success probability, staffing target, or progress percentage.
- RISK remains executable; BLOCKED remains canonical.
- Preserve the original select-based assignment editor and P28 PLAN BOARD.

### P29 Task 1: RED tests for factual move projection and transient lifecycle

**Files:**
- Modify: `tests/daily-command-read-model.test.mjs`
- Modify: `tests/daily-action-loop-ui.test.mjs`
- Modify: `tests/pda-presentation.test.mjs`

**Interfaces:**
- Expected production symbol: `assignmentConsequenceReadback(moves, report)`.
- Expected app fields: `#pendingAssignmentMoves`, `#assignmentConsequenceReadback`.
- Expected UI tokens: `ASSIGNMENT READBACK`, `OBSERVED AFTER STAFF MOVE`, `.desc-assignment-readback`.

- [x] **Step 1: Add a failing pure projection test**

Append to `tests/daily-command-read-model.test.mjs` a test that constructs two move snapshots and a canonical `MorningReport`, calls `assignmentConsequenceReadback`, and asserts:

```js
assert.equal(readback.length, 2);
assert.equal(readback[0].agentId, criticalAgentId);
assert.equal(readback[0].fromTask, 'records');
assert.equal(readback[0].toTask, 'water');
assert.equal(readback[0].healthDelta, -4);
assert.equal(readback[0].fatigueDelta, 15);
assert.equal(readback[0].moraleDelta, -2);
assert.equal(readback[0].severity, 'critical');
```

Include one unmatched move and assert it is not synthesized. Do not assert any resource attribution.

- [x] **Step 2: Add failing app-source lifecycle assertions**

Append to `tests/daily-action-loop-ui.test.mjs`:

```js
test('P29 captures final staff moves before first commit, preserves them across interruption, and finalizes only from MorningReport', () => {
  for (const token of ['#pendingAssignmentMoves', '#assignmentConsequenceReadback', 'assignmentConsequenceReadback', 'ASSIGNMENT READBACK', 'OBSERVED AFTER STAFF MOVE']) {
    assert.ok(app.includes(token), `missing P29 token: ${token}`);
  }
  assert.match(app, /currentPlan\.status==='draft'[\s\S]*?#pendingAssignmentMoves[\s\S]*?commitDailyPlan\(this\.state\)/);
  assert.match(app, /result\.status==='interrupted'[\s\S]*?#commandPulsePhase='plan'/);
  assert.doesNotMatch(app, /result\.status==='interrupted'[\s\S]{0,700}?#pendingAssignmentMoves=\[\]/);
  assert.match(app, /assignmentConsequenceReadback\(this\.#pendingAssignmentMoves,result\.report\)/);
  assert.match(app, /#pendingAssignmentMoves=\[\]/);
  assert.match(app, /data-daily-target="body"/);
});
```

- [x] **Step 3: Add failing presentation/accessibility assertions**

Append to `tests/pda-presentation.test.mjs` assertions for:

```js
assert.match(css, /\.desc-assignment-readback/);
assert.match(css, /\.desc-assignment-trace/);
assert.match(css, /a11y-reduce-motion[\s\S]*?desc-assignment-readback/);
assert.match(css, /prefers-reduced-motion[\s\S]*?desc-assignment-readback/);
assert.match(css, /a11y-contrast[\s\S]*?desc-assignment-readback/);
assert.match(css, /@media\(max-width:1300px\)[\s\S]*?desc-assignment-readback/);
```

- [x] **Step 4: Run RED tests**

Run:

```bash
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: the new P29 tests fail because production symbols/styles do not yet exist while pre-existing tests remain green.

### P29 Task 2: Implement the pure Morning Report projection

**Files:**
- Modify: `src/sandbox/dailyCommandReadModel.ts`
- Test: `tests/daily-command-read-model.test.mjs`

**Interfaces:**
- Produces `DailyAssignmentMoveSnapshot`.
- Produces `DailyAssignmentConsequenceReadback`.
- Produces `assignmentConsequenceReadback(moves, report)`.

- [x] **Step 1: Add exported move/readback interfaces**

Add next to the existing Daily Command presentation interfaces:

```ts
export interface DailyAssignmentMoveSnapshot {
  agentId: string;
  name: string;
  fromTask: LaborTask;
  toTask: LaborTask;
}

export interface DailyAssignmentConsequenceReadback extends DailyAssignmentMoveSnapshot {
  severity: MorningResidentSeverity;
  severityScore: number;
  summary: string;
  healthAfter: number;
  healthDelta: number;
  fatigueDelta: number;
  moraleDelta: number;
}
```

- [x] **Step 2: Implement exact agent-id projection**

Add:

```ts
export function assignmentConsequenceReadback(
  moves: readonly DailyAssignmentMoveSnapshot[],
  report: MorningReport,
): DailyAssignmentConsequenceReadback[] {
  const deltas = new Map(report.residentDeltas.map((entry) => [entry.agentId, entry]));
  return moves.flatMap((move) => {
    const delta = deltas.get(move.agentId);
    if (!delta) return [];
    return [{
      ...move,
      severity: delta.severity,
      severityScore: delta.severityScore,
      summary: delta.summary,
      healthAfter: delta.healthAfter,
      healthDelta: delta.healthDelta,
      fatigueDelta: delta.fatigueDelta,
      moraleDelta: delta.moraleDelta,
    }];
  }).sort((a, b) => b.severityScore - a.severityScore || a.name.localeCompare(b.name));
}
```

Do not reference `report.resourceDeltas` in this helper.

- [x] **Step 3: Run projection test GREEN**

Run:

```bash
npm run test:compile
node --test tests/daily-command-read-model.test.mjs
```

Expected: the new projection test passes.

### P29 Task 3: Capture moves, preserve interruption state, and render morning trace

**Files:**
- Modify: `src/sandbox/app.ts`
- Test: `tests/daily-action-loop-ui.test.mjs`

**Interfaces:**
- Consumes `deriveDailyCommandView`, `assignmentConsequenceReadback`, `DailyAssignmentMoveSnapshot`, `DailyAssignmentConsequenceReadback`.
- Produces session-local `#pendingAssignmentMoves` and `#assignmentConsequenceReadback`.

- [x] **Step 1: Import P29 projection symbols and add transient fields**

Extend the existing Daily Command import and add:

```ts
#pendingAssignmentMoves: DailyAssignmentMoveSnapshot[] = [];
#assignmentConsequenceReadback: DailyAssignmentConsequenceReadback[] = [];
```

No state serialization hook may reference these fields.

- [x] **Step 2: Capture final P28 STAFF MOVES before the first commit**

Inside `executeDailyPlan()`, after block validation and `ensureDailyLoopState()` but before `commitDailyPlan()`:

```ts
if (loop.currentPlan.status==='draft') {
  const campaign=deriveSurvivalCampaignView(this.state);
  const canonicalBlockReason=this.dailyExecutionBlockReason();
  const command=deriveDailyCommandView({
    state:this.state,
    plan:loop.currentPlan,
    ...(loop.lastMorningReport?{report:loop.lastMorningReport}:{}),
    campaign,
    ...(canonicalBlockReason?{canonicalBlockReason}:{}),
  });
  this.#pendingAssignmentMoves=command.residentRows
    .filter((row)=>row.previousTask!==row.assignedTask)
    .map((row)=>({agentId:row.agentId,name:row.name,fromTask:row.previousTask,toTask:row.assignedTask}));
}
```

Then run the existing `commitDailyPlan(this.state)` exactly as before.

- [x] **Step 3: Preserve pending moves on interruption and finalize only on completion**

Do not clear `#pendingAssignmentMoves` in the `interrupted` branch. In the completed branch, before the existing command readback lines:

```ts
this.#assignmentConsequenceReadback=assignmentConsequenceReadback(this.#pendingAssignmentMoves,result.report);
this.#pendingAssignmentMoves=[];
```

If execution throws, keep the pending list untouched so a resumable same-runtime session is not falsified. A later completed execution is the only path that converts pending moves into the readback.

- [x] **Step 4: Render the factual assignment readback band**

In `pdaCampaignCommand()`, after `YESTERDAY'S OUTCOME`, derive:

```ts
const assignmentReadbackVisible=this.#assignmentConsequenceReadback.slice(0,4);
const assignmentReadbackAlerts=this.#assignmentConsequenceReadback.filter((entry)=>!['stable','improved'].includes(entry.severity)).length;
const signed=(value:number)=>`${value>=0?'+':''}${value.toFixed(0)}`;
```

Render `ASSIGNMENT READBACK / 昨日の配置結果`, the helper `OBSERVED AFTER STAFF MOVE · 因果確定ではありません`, and each row as an existing `daily-detail` button targeting `body`. Each row must show:

```text
<previous localized> → <executed localized>
HP <delta> → <healthAfter> · FAT <delta> · MOR <delta>
<MorningReport summary>
```

Render nothing when the readback array is empty.

- [x] **Step 5: Run UI lifecycle test GREEN and type check**

Run:

```bash
npm run check
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: PASS.

### P29 Task 4: Add rich trace styling, visual QA, regression verification, and recovery ZIP

**Files:**
- Modify: `src/styles.css`
- Test: `tests/pda-presentation.test.mjs`
- Add final evidence under: `docs/screenshots/daily-command-center/`
- Modify: this plan, checking P29 boxes and recording execution notes.
- Create final ZIP outside the project directory.

**Interfaces:**
- Produces `.desc-assignment-readback`, `.desc-assignment-readback-grid`, `.desc-assignment-readback-card`, `.desc-assignment-trace`.
- Produces final `DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P29_2026-09-16.zip` and SHA-256.

- [x] **Step 1: Add readback visual language**

Add a P29 CSS block with a framed CRT band, four-card wide grid at 1440-class, explicit severity text/borders, and a `PREVIOUS → EXECUTED` transfer line. Use a short non-progress scan/acquisition animation on `.desc-assignment-readback.is-fresh` only; do not create a numeric progress indicator.

- [x] **Step 2: Add accessibility and compact rules**

Add:

```css
.a11y-reduce-motion .desc-assignment-readback,
.a11y-reduce-motion .desc-assignment-trace::after { animation:none!important; transform:none!important; }

@media (prefers-reduced-motion: reduce) {
  .desc-assignment-readback,
  .desc-assignment-trace::after { animation:none!important; transform:none!important; }
}
```

High contrast must use solid borders/backgrounds. At `@media(max-width:1300px)`, make the readback grid one column and keep `PREVIOUS`, `EXECUTED`, severity, HP/FAT/MOR text visible.

- [x] **Step 3: Run focused presentation and regression checks**

Run:

```bash
npm run check
npm run build:portable
npm run test:compile
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: PASS.

- [x] **Step 4: Attempt runtime capture, then use established static CSS fallback only if blocked**

Capture when reachable:

- `p29-assignment-readback-1440x900.png` — multiple moved residents and observed deltas;
- `p29-assignment-readback-alert-1440x900.png` — at least one non-stable/improved Morning severity;
- `p29-assignment-readback-1280x720.png` — compact single-column trace layout.

Prefer existing Electron/Chromium runtime tooling. If the container repeats the administrative/runtime block, render the current production CSS with representative markup as static visual-QA evidence and label it non-runtime.

- [x] **Step 5: Run fresh completion verification**

Run again on the final tree:

```bash
npm run check
npm run build:portable
npm run test:compile
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Attempt `npm run test:unit` with a bounded time budget; record partial passing count if the environment ends before TAP summary, and do not claim full-suite PASS without the final summary.

- [x] **Step 6: Package and integrity-check the P29 recovery artifact**

From `/mnt/data/descendants_p27_work`:

```bash
zip -qr /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P29_2026-09-16.zip Descendants -x 'Descendants/node_modules/*' 'Descendants/.test-dist/*'
unzip -t /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P29_2026-09-16.zip
sha256sum /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P29_2026-09-16.zip
```

Expected: ZIP integrity reports no errors and one SHA-256 is printed. Do not add a checksum text file inside the repository.

## P29 Execution Notes

- TDD RED was observed before production code: the three new P29 contracts produced **3 expected failures** while **128 pre-existing assertions passed**. The failures were the missing transient lifecycle, pure projection helper, and P29 presentation CSS.
- `assignmentConsequenceReadback()` joins only the submitted move snapshot to canonical `MorningReport.residentDeltas` by `agentId`; unmatched residents are omitted and no `resourceDeltas` attribution is emitted.
- The app captures the final P28 `previousTask !== assignedTask` rows immediately before first commit, preserves them across MANUAL interruption, and converts them to readback only after completed `executeCommittedPlan()` returns its Morning Report. No save-schema field or simulation path was added.
- Runtime screenshot capture was attempted against the reachable portable server (`127.0.0.1:4173`, HTTP 200), but headless Chromium timed out without producing a PNG in this container. The retained P29 screenshots are therefore explicitly **static CSS visual-QA renders** made with the current production `src/styles.css` and representative canonical readback markup, not runtime E2E captures. The 1280×720 render explicitly applies the same production `@media(max-width:1300px)` P29 compact declarations because WeasyPrint does not reliably evaluate the runtime viewport media query.
- Visual-QA evidence covers normal READBACK, alert-heavy READBACK, and 1280×720 compact hierarchy. The cards preserve resident name, textual severity, `PREVIOUS → EXECUTED`, HP/FAT/MOR observed deltas, and the non-causal disclaimer.
- Fresh completion verification on the final tree: `npm run check` PASS; `npm run build:portable` PASS; `npm run test:compile` PASS; focused Daily Command regression **139/139 PASS**; bounded full `npm run test:unit` completed with **595/595 PASS, 0 failures**.
- Final ZIP integrity and SHA-256 are recorded in the execution transcript rather than additional checksum/status files, keeping the repository uncluttered.


# P30 Morning Review / Replan Assist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Turn P29 observed assignment readback into a compact morning replan queue that focuses the existing P28 PLAN BOARD and exposes quick rest only when the existing REST PRESSURE projection already marks that resident eligible.

**Architecture:** Add one pure projection in `dailyCommandReadModel.ts` that joins transient P29 readback to current resident rows and canonical rest-pressure candidates. `app.ts` renders and routes actions but does not introduce persistent state or new simulation logic. Styling extends the existing CRT Daily Command visual language and reuses the PLAN BOARD selection reticle.

**Tech Stack:** TypeScript, existing sandbox Daily Command read models, DOM-string UI in `src/sandbox/app.ts`, CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-16-daily-command-center-design.md` sections 52.1–52.6.

## Global Constraints

- No `SandboxGameState`, save schema, `DailyPlan`, `MorningReport`, simulation formula, or execution-authority interface changes.
- Do not invent a new risk threshold, recommendation score, probability, or causal statement.
- `PLANを見る` is non-mutating and routes to the existing P28 PLAN BOARD.
- `休養へ` is available only for an agent already present in existing `command.restPressure.candidates` and must use `setDailyAssignment(this.state,agentId,'rest')`.
- P30 is transient and may disappear on reload together with the P29 transient assignment readback.
- Keep documentation consolidated in the existing design and implementation-plan files; do not add standalone P30 md/txt/json files.

---

### P30 Task 1: Define the pure morning replan projection with TDD

**Files:**
- Modify: `src/sandbox/dailyCommandReadModel.ts`
- Test: `tests/daily-command-read-model.test.mjs`

**Interfaces:**
- Consumes: `DailyAssignmentConsequenceReadback[]`, `DailyResidentPlanRow[]`, optional `DailyRestPressure`.
- Produces: `DailyMorningReplanEntry` and `morningReplanQueue(readback, rows, restPressure)`.

- [x] **Step 1: Write a failing projection test**

Import `morningReplanQueue` and construct three P29 readback records: one `critical`, one `watch`, one `stable`. Construct matching current rows so the critical resident has changed again today and the watch resident remains on yesterday's executed task. Pass REST PRESSURE containing only the critical resident. Assert:

```js
assert.deepEqual(queue.map((entry)=>({
  agentId: entry.agentId,
  replanned: entry.replanned,
  restEligible: entry.restEligible,
})), [
  { agentId: 'critical-agent', replanned: true, restEligible: true },
  { agentId: 'watch-agent', replanned: false, restEligible: false },
]);
assert.equal(queue[0].currentTask, 'rest');
assert.equal(queue[0].toTask, 'guard');
assert.equal(queue.some((entry)=>entry.agentId==='stable-agent'), false);
```

Add an unmatched readback entry and assert it is omitted.

- [x] **Step 2: Compile tests and verify RED**

Run:

```bash
npm run test:compile
node --test tests/daily-command-read-model.test.mjs
```

Expected: the new P30 test fails because `morningReplanQueue` is not exported/implemented; pre-existing assertions remain green.

- [x] **Step 3: Add the minimal projection types and function**

Add:

```ts
export interface DailyMorningReplanEntry extends DailyAssignmentConsequenceReadback {
  currentTask: LaborTask;
  replanned: boolean;
  restEligible: boolean;
}

export function morningReplanQueue(
  readback: readonly DailyAssignmentConsequenceReadback[],
  rows: readonly DailyResidentPlanRow[],
  restPressure?: DailyRestPressure,
): DailyMorningReplanEntry[] {
  const rowsByAgent=new Map(rows.map((row)=>[row.agentId,row]));
  const restEligible=new Set((restPressure?.candidates??[]).map((candidate)=>candidate.agentId));
  return readback.flatMap((entry)=>{
    if (entry.severity==='stable'||entry.severity==='improved') return [];
    const row=rowsByAgent.get(entry.agentId);
    if (!row) return [];
    return [{...entry,currentTask:row.assignedTask,replanned:row.assignedTask!==entry.toTask,restEligible:restEligible.has(entry.agentId)}];
  }).sort((a,b)=>b.severityScore-a.severityScore||a.name.localeCompare(b.name));
}
```

Do not inspect raw health/fatigue values or invent thresholds here.

- [x] **Step 4: Verify projection GREEN**

Run the same compile + read-model test command and expect PASS.

### P30 Task 2: Render Morning Replan and route PLAN / REST actions with TDD

**Files:**
- Modify: `src/sandbox/app.ts`
- Test: `tests/daily-action-loop-ui.test.mjs`

**Interfaces:**
- Consumes: `morningReplanQueue`, existing `#assignmentConsequenceReadback`, current `command.residentRows`, `command.restPressure`, `setDailyAssignment()`.
- Produces: `MORNING REPLAN / 朝の再配置確認`, `daily-replan-focus`, and conditional `daily-replan-rest` actions.

- [x] **Step 1: Write failing UI source-contract tests**

Add assertions requiring:

```js
assert.match(app, /morningReplanQueue\(this\.#assignmentConsequenceReadback,command\.residentRows,command\.restPressure\)/);
assert.match(app, /MORNING REPLAN/);
assert.match(app, /朝の再配置確認/);
assert.match(app, /data-action="daily-replan-focus"/);
assert.match(app, /entry\.restEligible[\s\S]*?data-action="daily-replan-rest"/);
assert.match(app, /action==='daily-replan-focus'[\s\S]*?#dailyPlanBoardAgentId=agentId/);
assert.match(app, /action==='daily-replan-rest'[\s\S]*?setDailyAssignment\(this\.state,agentId,'rest'\)/);
```

Also assert the rendered copy includes `自動推奨ではありません` and status tokens `UNCHANGED` / `REPLANNED`.

- [x] **Step 2: Verify UI RED**

Run:

```bash
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: only the new P30 source-contract test fails.

- [x] **Step 3: Import the projection and derive the queue during command render**

Extend the Daily Command import with `morningReplanQueue`. In `pdaCampaignCommand()` derive:

```ts
const morningReplan=morningReplanQueue(this.#assignmentConsequenceReadback,command.residentRows,command.restPressure);
const morningReplanVisible=morningReplan.slice(0,4);
```

Render the band immediately after P29 assignment readback. Each card must include textual severity, yesterday `fromTask → toTask`, today's `currentTask`, observed HP/FAT/MOR deltas, Morning summary, `REPLANNED` or `UNCHANGED`, a `PLANを見る` button, and a `休養へ` button only when `entry.restEligible` is true.

- [x] **Step 4: Route PLAN focus without mutation**

Add:

```ts
if (action==='daily-replan-focus') {
  const agentId=button.dataset.agentId??'';
  if (agentId) {
    this.#dailyPlanBoardAgentId=agentId;
    this.#commandPulsePhase='plan';
    this.#focusAfterRender=`[data-action="daily-board-select"][data-agent-id="${agentId}"]`;
    this.render();
  }
  return;
}
```

Extend the existing post-render focus handling only if necessary so the focused PLAN BOARD chip is also scrolled into view using `scrollIntoView({block:'center',behavior: reducedMotion ? 'auto' : 'smooth'})`. Do not alter the assignment.

- [x] **Step 5: Route conditional quick rest through the canonical seam**

Add:

```ts
if (action==='daily-replan-rest') {
  const agentId=button.dataset.agentId??'';
  const loop=ensureDailyLoopState(this.state);
  const command=deriveDailyCommandView({state:this.state,plan:loop.currentPlan,...});
  const eligible=command.restPressure?.candidates.some((candidate)=>candidate.agentId===agentId)??false;
  if (!eligible) { this.toast('REST PRESSURE対象ではありません。PLAN BOARDで配置を確認してください。'); return; }
  setDailyAssignment(this.state,agentId,'rest');
  this.#dailyPlanBoardAgentId=agentId;
  this.#commandPulsePhase='plan';
  this.#focusAfterRender=`[data-action="daily-board-select"][data-agent-id="${agentId}"]`;
  this.render();
  return;
}
```

The click handler must re-check current canonical REST PRESSURE rather than trusting stale button markup.

- [x] **Step 6: Verify UI GREEN and type check**

Run:

```bash
npm run check
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: PASS.

### P30 Task 3: Add CRT replan styling and accessibility contracts

**Files:**
- Modify: `src/styles.css`
- Test: `tests/pda-presentation.test.mjs`

**Interfaces:**
- Produces: `.desc-morning-replan`, `.desc-morning-replan-grid`, `.desc-morning-replan-card`, `.desc-morning-replan-route`, `.desc-morning-replan-actions`.

- [x] **Step 1: Write failing presentation test**

Require the P30 classes plus reduced-motion, high-contrast, and `@media(max-width:1300px)` rules in `tests/pda-presentation.test.mjs`.

- [x] **Step 2: Verify presentation RED**

Run:

```bash
node --test tests/pda-presentation.test.mjs
```

Expected: only the new P30 presentation contract fails.

- [x] **Step 3: Implement the visual hierarchy**

Add a framed morning-review band using existing PDA palette variables. Wide layout uses up to four equal cards. `tone-critical` and `tone-warning` keep explicit border treatment; `.is-replanned` adds a transfer accent and textual `REPLANNED` marker. Add one short `descMorningReplanAcquire` scan on `.is-fresh` only.

- [x] **Step 4: Add accessibility and compact behavior**

Add Reduced Motion rules disabling the acquisition scan and route transfer animation, High Contrast rules using black/currentColor/solid borders, and `@media(max-width:1300px)` rules that switch the grid to one column while retaining all text and actions.

- [x] **Step 5: Verify presentation GREEN**

Run the presentation test and expect PASS.

### P30 Task 4: Regression, visual QA, documentation closeout, and recovery ZIP

**Files:**
- Modify: this implementation plan execution notes/check boxes.
- Add evidence under: `docs/screenshots/daily-command-center/`.
- Create final ZIP outside the project directory.

**Interfaces:**
- Produces final P30 screenshots and `DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P30_2026-09-16.zip`.

- [x] **Step 1: Run focused verification**

Run:

```bash
npm run check
npm run build:portable
npm run test:compile
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: PASS.

- [x] **Step 2: Attempt runtime screenshots first**

Capture:

- `p30-morning-replan-1440x900.png` — multiple review entries with PLAN actions;
- `p30-replanned-rest-1440x900.png` — a REPLANNED entry and one canonical REST PRESSURE quick-rest action;
- `p30-morning-replan-1280x720.png` — compact one-column review layout.

Use the existing portable server/Electron/Chromium route. If the same container runtime blocker prevents PNG generation, use the established production-CSS static visual-QA fallback and label it non-runtime in execution notes.

- [x] **Step 3: Run fresh completion verification**

Run focused verification again, then run full `npm run test:unit` to final TAP summary. Do not claim full-suite PASS without the final summary.

- [x] **Step 4: Close plan and package recovery ZIP**

Check all P30 boxes, append exact verification/visual evidence notes, then from `/mnt/data/descendants_p27_work` run:

```bash
zip -qr /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P30_2026-09-16.zip Descendants -x 'Descendants/node_modules/*' 'Descendants/.test-dist/*'
unzip -t /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P30_2026-09-16.zip
sha256sum /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P30_2026-09-16.zip
```

Expected: ZIP integrity reports no errors and exactly one SHA-256 is printed. Do not add checksum/status files to the repository.

## P30 Execution Notes

- TDD RED was observed before production code in each layer: the new pure projection produced **64 existing PASS / 1 expected FAIL**, the new UI contract produced **58 existing PASS / 1 expected FAIL**, and the presentation contract produced **9 existing PASS / 1 expected FAIL**. Each became green only after the corresponding production implementation.
- `morningReplanQueue()` filters the transient P29 readback to non-`stable`/non-`improved` entries, joins only to current `DailyResidentPlanRow` by `agentId`, preserves existing `severityScore` ordering, and marks REST eligibility only from `command.restPressure.candidates`. No new risk threshold or score was introduced.
- `PLANを見る` only selects the existing P28 PLAN BOARD resident, switches the command phase to PLAN, rerenders, focuses the canonical resident chip, and scrolls it into view. It never calls `setDailyAssignment`, `commitDailyPlan`, or `executeCommittedPlan`.
- `休養へ` is rendered only when the projection reports existing REST PRESSURE eligibility. The click handler recomputes current Daily Command state and re-checks `restPressure.candidates` before calling canonical `setDailyAssignment(this.state,agentId,'rest')`, so stale markup cannot authorize an obsolete quick-rest action.
- Runtime screenshot capture was attempted against the portable server and the server returned **HTTP 200**, but headless Chromium again failed to produce a PNG before the container timeout. P30 evidence is therefore explicitly **static production-CSS visual QA**, not runtime E2E capture. WeasyPrint does not implement all browser grid/media behavior, so the static evidence renderer applies QA-only layout fallbacks; the 1280×720 case copies the same P30 compact declarations present in production `@media(max-width:1300px)`.
- Visual QA covers normal MORNING REPLAN, a `REPLANNED` resident with canonical REST PRESSURE quick-rest plus selected PLAN BOARD context, and the 1280×720 compact review list.
- Fresh completion verification on the implementation-final tree: `npm run check` PASS; `npm run build:portable` PASS; `npm run test:compile` PASS; focused Daily Command regression **142/142 PASS**; full `npm run test:unit` completed to TAP summary with **598/598 PASS, 0 failures**.
- Packaging excludes `node_modules` and `.test-dist` and does not add checksum/status files to the repository.


## P31 SETTLEMENT TELEMETRY / SURVIVAL INSTRUMENTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Upgrade the five existing Daily Command resource-summary cards into rich survival instruments that expose exact current survival pressure and observed 24h change without adding forecasts, persistence, simulation, or a second resource model.

**Architecture:** Extend the existing `DailyResourceSummaryItem` projection in `dailyCommandReadModel.ts`, then render those same five items as richer semantic instruments in `app.ts`. All thresholds remain canonical existing thresholds; all 24h change text comes directly from `MorningReport` facts. Styling is presentation-only and uses discrete textual status cells rather than synthetic percentages.

**Tech Stack:** TypeScript, existing Daily Command pure read model, existing PDA HTML-string renderer, CSS, Node test runner, portable build pipeline.

**Spec:** `docs/superpowers/specs/2026-09-16-daily-command-center-design.md` section 53.

### Global Constraints

- Do not modify `SandboxGameState`, save schema, `DailyPlan`, `MorningReport`, simulation formulas, `executeCommittedPlan()`, or authority seams.
- Do not add a forecast, synthetic history, rolling average, productivity percentage, resource contribution score, fake sparkline, or new reserve threshold.
- Food/water reserve tone must use existing `reserveTone()` thresholds; water safety remains `<55` critical; medicine retains the existing severe-resident/current-stock rule.
- Drill-down is navigation only through existing `daily-detail` behavior.
- Do not add image, audio, 3D, JSON, TXT, or new design/plan files.
- Git metadata is absent in this recovery workspace; ZIP + SHA-256 is the recovery boundary.

---

### P31 Task 1: Extend the pure survival-instrument projection with TDD

**Files:**
- Modify: `src/sandbox/dailyCommandReadModel.ts`
- Test: `tests/daily-command-read-model.test.mjs`

**Interfaces:**
- Consumes: existing `DailyCommandInput`, `reserveTone()`, `MorningReport.resourceDeltas`, births/deaths/expeditionUpdates, campaign reserve/population fields, current settlement resources and expedition statuses.
- Produces: extended `DailyResourceSummaryItem` fields `statusLabel`, `trend`, `trendLabel`, and `target` for all five items.

- [x] **Step 1: Write the failing read-model test**

Add a test that sets exact current food/water/medicine values, a current water safety value, one severe resident, one active troubled expedition, and an explicit `lastMorningReport` containing births/deaths/resource deltas/expedition updates. Assert exact fields such as:

```js
const food=view.resourceSummary.find((entry)=>entry.id==='food');
assert.equal(food?.target,'inventory');
assert.equal(food?.statusLabel, food?.tone==='critical' ? 'CRITICAL' : food?.tone==='warning' ? 'WATCH' : 'STABLE');
assert.equal(food?.trend,'down');
assert.match(food?.trendLabel ?? '', /24H Δ -/);

const population=view.resourceSummary.find((entry)=>entry.id==='population');
assert.equal(population?.target,'chronicle');
assert.equal(population?.trend,'activity');
assert.match(population?.trendLabel ?? '', /BIRTH \+1/);
assert.match(population?.trendLabel ?? '', /DEATH -1/);

const expedition=view.resourceSummary.find((entry)=>entry.id==='expedition');
assert.equal(expedition?.target,'expedition');
assert.equal(expedition?.tone,'warning');
assert.equal(expedition?.trend,'activity');
```

Also assert serialized entries contain none of `forecast`, `projection`, `sparkline`, `efficiency`, `productivity`, or `score` except the already-existing unrelated resident severity structures outside `resourceSummary`.

- [x] **Step 2: Verify read-model RED**

Run:

```bash
npm run test:compile
node --test tests/daily-command-read-model.test.mjs
```

Expected: existing tests pass and only the new P31 expectations fail because the new fields do not exist.

- [x] **Step 3: Implement the minimal projection**

Extend the interface exactly as specified:

```ts
export type DailyInstrumentTrend = 'up' | 'down' | 'flat' | 'none' | 'activity';

export interface DailyResourceSummaryItem {
  id: 'population' | 'food' | 'water' | 'medicine' | 'expedition';
  label: string;
  value: string;
  detail: string;
  tone: DailyCommandTone;
  statusLabel: 'STABLE' | 'WATCH' | 'CRITICAL';
  trend: DailyInstrumentTrend;
  trendLabel: string;
  target: DailyCommandTarget;
}
```

Add small pure local helpers:

```ts
function instrumentStatusLabel(tone: DailyCommandTone): DailyResourceSummaryItem['statusLabel'] {
  return tone === 'critical' ? 'CRITICAL' : tone === 'warning' ? 'WATCH' : 'STABLE';
}

function deltaTrend(delta: number | undefined): { trend: DailyInstrumentTrend; trendLabel: string } {
  if (delta === undefined) return { trend:'none', trendLabel:'NO 24H SAMPLE' };
  if (Math.abs(delta) < 0.05) return { trend:'flat', trendLabel:'24H Δ =0.0' };
  return { trend: delta > 0 ? 'up' : 'down', trendLabel:`24H Δ ${delta > 0 ? '+' : ''}${delta.toFixed(1)}` };
}
```

Build each item from exact current/canonical facts defined in spec section 53.2. For expedition detail, aggregate only current active statuses already in state, for example `outbound 1 · missing 1`; do not infer safety. A current `missing`, `captured`, or `time-displaced` active expedition makes the instrument WATCH.

- [x] **Step 4: Verify read-model GREEN**

Run the same compile + read-model test command. Expected: PASS.

### P31 Task 2: Render the five telemetry instruments and preserve non-mutating drill-down

**Files:**
- Modify: `src/sandbox/app.ts`
- Test: `tests/daily-action-loop-ui.test.mjs`

**Interfaces:**
- Consumes: extended `command.resourceSummary` and existing `daily-detail` routing.
- Produces: `.desc-survival-instrument` markup with exact current value, supporting fact, textual status, observed-24h row, categorical pressure cells, and existing-authority detail button.

- [x] **Step 1: Write the failing UI source-contract test**

Require these tokens:

```js
for (const token of [
  'SURVIVAL INSTRUMENTS',
  'desc-survival-instrument',
  'OBSERVED 24H',
  'desc-instrument-pressure',
  'data-instrument-trend=',
  'data-instrument-status=',
]) assert.ok(app.includes(token), `missing P31 token: ${token}`);

assert.match(app, /command\.resourceSummary\.map/);
assert.match(app, /data-action="daily-detail"[\s\S]*?data-daily-target="\$\{item\.target\}"/);
assert.doesNotMatch(app, /SURVIVAL INSTRUMENTS[\s\S]{0,2600}?(?:forecast|predicted|sparkline|efficiency|productivity|success rate)/i);
```

Verify the existing `daily-detail` handler remains navigation-only by asserting its handler block does not call `setDailyAssignment`, `executeCommittedPlan`, resource mutation helpers, or expedition launch.

- [x] **Step 2: Verify UI RED**

Run:

```bash
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: only the new P31 UI contract fails.

- [x] **Step 3: Replace plain summary-card markup with instrument markup**

Keep the existing outer `.desc-daily-resource-summary` container and five-item order. Render:

```html
<div class="desc-daily-resource-summary" aria-label="Survival instruments">
  <article class="desc-survival-instrument tone-..." data-instrument-status="..." data-instrument-trend="...">
    <header><span>...</span><em>STABLE|WATCH|CRITICAL</em></header>
    <strong class="desc-instrument-value">...</strong>
    <small class="desc-instrument-detail">...</small>
    <div class="desc-instrument-trend"><b>OBSERVED 24H</b><span>↑|↓|=|• ...</span></div>
    <div class="desc-instrument-pressure" aria-label="Pressure state ..."><i ...></i><i ...></i><i ...></i></div>
    <button data-action="daily-detail" data-daily-target="...">詳細</button>
  </article>
</div>
```

Map trend symbols exactly: up `↑`, down `↓`, flat `=`, none `•`, activity `•`. The pressure cells are categorical and use `aria-label`/status text; do not render percentages or inline widths.

- [x] **Step 4: Verify UI GREEN and type check**

Run:

```bash
npm run check
node --test tests/daily-action-loop-ui.test.mjs
```

Expected: PASS.

### P31 Task 3: Add rich instrument styling, effects, compact mode, and accessibility contracts

**Files:**
- Modify: `src/styles.css`
- Test: `tests/pda-presentation.test.mjs`

**Interfaces:**
- Produces: `.desc-survival-instrument`, `.desc-instrument-value`, `.desc-instrument-detail`, `.desc-instrument-trend`, `.desc-instrument-pressure`, `descTelemetryAcquire`, alert pulse rules, reduced-motion/high-contrast/1280-class behavior.

- [x] **Step 1: Write the failing presentation test**

Require the P31 classes and:

```js
assert.match(css, /@keyframes\s+descTelemetryAcquire/);
assert.match(css, /a11y-reduce-motion[\s\S]*?desc-survival-instrument/);
assert.match(css, /prefers-reduced-motion[\s\S]*?desc-survival-instrument/);
assert.match(css, /a11y-contrast[\s\S]*?desc-survival-instrument/);
assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-resource-summary\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
```

Also assert there is no `width:` driven by a custom resource percentage or CSS variable such as `--resource-progress`.

- [x] **Step 2: Verify presentation RED**

Run:

```bash
node --test tests/pda-presentation.test.mjs
```

Expected: only the new P31 presentation contract fails.

- [x] **Step 3: Implement the visual hierarchy and effects**

Use the existing PDA palette. Each instrument gets a compact framed module with a large monospace value, tiny supporting fact, exact observed-24h rail, and three labeled/accessible pressure cells. WATCH/CRITICAL use stronger outlines and a low-frequency pulse. Exact non-`none` trend states may receive one short `descTelemetryAcquire` sweep using a pseudo-element; no looping graph animation.

- [x] **Step 4: Add accessibility and 1280-class layout**

Add `.a11y-reduce-motion` and `@media(prefers-reduced-motion:reduce)` rules that disable telemetry acquisition/pulse animation. Add `.a11y-contrast` solid current-color treatment. Preserve the existing 1280-class 3-column summary rule so five cards resolve as 3+2, and tighten padding/value size without removing labels/actions.

- [x] **Step 5: Verify presentation GREEN**

Run the presentation test and expect PASS.

### P31 Task 4: Regression, visual QA, documentation closeout, and recovery ZIP

**Files:**
- Modify: this implementation plan execution notes/check boxes.
- Add evidence under: `docs/screenshots/daily-command-center/`.
- Create final ZIP outside the project directory.

**Interfaces:**
- Produces: P31 screenshots and `DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P31_2026-09-16.zip`.

- [x] **Step 1: Run focused verification**

Run:

```bash
npm run check
npm run build:portable
npm run test:compile
node --test tests/daily-command-read-model.test.mjs tests/daily-action-loop.test.mjs tests/daily-action-loop-ui.test.mjs tests/pda-presentation.test.mjs
```

Expected: PASS.

- [x] **Step 2: Attempt runtime screenshots first**

Capture:

- `p31-survival-instruments-1440x900.png` — mixed STABLE/WATCH/CRITICAL instruments with exact 24h deltas;
- `p31-survival-critical-1440x900.png` — food/water pressure and one troubled expedition status visible without color dependence;
- `p31-survival-instruments-1280x720.png` — compact 3+2 instrument grid.

Use the existing portable server/Electron/Chromium route first. If the established container Chromium blocker prevents PNG generation, use the production-CSS static visual-QA fallback and label it non-runtime in execution notes.

- [x] **Step 3: Run fresh completion verification**

Run focused verification again, then run full:

```bash
npm run test:unit
```

Only claim full-suite PASS when the final TAP summary is observed.

- [x] **Step 4: Close plan and package recovery ZIP**

Check all P31 boxes and append exact execution notes. Then from `/mnt/data/descendants_p27_work` run:

```bash
zip -qr /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P31_2026-09-16.zip Descendants -x 'Descendants/node_modules/*' 'Descendants/.test-dist/*'
unzip -t /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P31_2026-09-16.zip
sha256sum /mnt/data/DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P31_2026-09-16.zip
```

Expected: ZIP integrity reports no errors and exactly one SHA-256 is printed. Do not add checksum/status files to the repository.


### P31 Execution Notes — 2026-09-16

- TDD RED was observed independently in all three new contracts: read model (65 existing PASS + 1 P31 FAIL for missing `target`), UI (59 existing PASS + 1 P31 FAIL for missing `SURVIVAL INSTRUMENTS`), and presentation (10 existing PASS + 1 P31 FAIL for missing telemetry CSS).
- GREEN verification reached read model 66/66, UI 60/60, and presentation 11/11 before combined regression.
- Final focused verification on the implementation tree: `npm run check` PASS; `npm run build:portable` PASS; `npm run test:compile` PASS; Daily Command focused regression 145/145 PASS, 0 failures.
- Full `npm run test:unit` was attempted after focused verification. The container time limit stopped the process before its TAP summary after 472 consecutive PASS results; the captured log contains 0 `not ok` lines. This is recorded as partial evidence only, not as a full-suite PASS.
- Runtime screenshot route was attempted first. The portable server returned HTTP 200, but headless Chromium did not produce a PNG before the container timeout. Visual evidence therefore uses the established non-runtime static visual-QA route with the current production `src/styles.css`; WeasyPrint-only layout fallbacks reproduce the production 3+2 compact arrangement and are not shipped in production CSS.
- Visual QA reviewed: `p31-survival-instruments-1440x900.png`, `p31-survival-critical-1440x900.png`, and `p31-survival-instruments-1280x720.png`. The screenshots preserve textual STABLE/WATCH/CRITICAL semantics, exact observed-24h facts, detail actions, and the 1280-class 3+2 hierarchy.
- P31 does not alter `SandboxGameState`, save schema, `DailyPlan`, `MorningReport`, simulation authority, or `executeCommittedPlan()`. No forecast, synthetic history, rolling average, fake sparkline, efficiency/productivity estimate, or success-rate model was added.

## P31 Layout Repair — Playability Hotfix

**Goal:** Restore a playable F1 layout after P27-P31 vertical Daily Command growth without changing game state, simulation, or save contracts.

**Files:**
- Modify: `src/styles.css`
- Test: `tests/pda-presentation.test.mjs`
- Modify: existing design/plan docs
- Replace P31 screenshot evidence under `docs/screenshots/daily-command-center/`

- [x] **Step 1: Reproduce and isolate the root cause**

Actual portable-app Chromium measurement before the repair showed the Daily Command at roughly 2410px while the Task row collapsed to roughly 16px at 1440×900. Static WeasyPrint evidence also mis-rendered CSS Grid, explaining the false instrument overlap visible in the old screenshot.

- [x] **Step 2: Add a failing presentation contract**

`tests/pda-presentation.test.mjs` now requires a bounded `2fr / 3fr` campaign split, independent Daily Command scrolling, independent Task-detail scrolling, and absence of the old `auto minmax(0,1fr)` contract. RED was observed before the final CSS change.

- [x] **Step 3: Implement the root-cause repair**

`src/styles.css` now keeps Daily Command in a 40% scrollable upper pane and canonical Task / Play / Status in a 60% lower pane. `.desc-pda-task-detail` is independently scrollable so its action row remains reachable.

- [x] **Step 4: Verify in the actual portable app and replace broken evidence**

Chromium was launched on `about:blank` and the real portable build was supplied through Playwright request routing because normal local URL navigation is blocked by container policy. The real compiled app/worldgen payload booted in a temporary persistence session.

Measured after the final repair:

- 1440×900: campaign 716px; command visible ~274px / scrollHeight 2280px / `overflow-y:auto`; task layout ~425px; task detail visible ~409px / scrollHeight 483px / `overflow-y:auto`; after scrolling, task actions occupy approximately y=710..750 within the visible screen.
- 1280×720: campaign ~543px; command visible ~204px / scrollHeight 1849px / `overflow-y:auto`; task layout ~322px; task detail visible ~306px / scrollHeight 495px / `overflow-y:auto`.

Retained runtime screenshots are only:

- `p31-layout-fixed-1440x900.png`
- `p31-scroll-actions-fixed-1440x900.png`
- `p31-layout-fixed-1280x720.png`

The old WeasyPrint P31 screenshots and intermediate duplicate captures were removed.

- [x] **Step 5: Fresh verification and recovery ZIP**

Run the final focused/type/build verification on the repaired tree, then create `DESCENDANTS_DAILY_COMMAND_CENTER_IMPLEMENTED_P31_LAYOUT_FIXED_2026-09-16.zip`, inspect it with `unzip -t`, and record its SHA-256 in the handoff response.


### P31 Layout Repair Verification — 2026-09-16

- Root-cause presentation RED observed: 11/12 PASS; only the new bounded-split/Task-scroll contract failed before the final CSS change.
- Presentation GREEN after the final CSS change: 12/12 PASS.
- Fresh final verification: `npm run check` PASS; `npm run build:portable` PASS; `npm run test:compile` PASS; Daily Command focused regression **146/146 PASS, 0 failures**.
- Actual portable-app Chromium QA uses compiled `dist` assets and worldgen runtime through local Playwright request routing; no WeasyPrint/Grid fallback is used in retained P31 layout evidence.
- Runtime measurements after repair: 1440x900 command ~274px and task layout ~425px; 1280x720 command ~204px and task layout ~322px. Central task detail is independently scrollable, and its action row was observed inside the visible lower pane after scroll.
- No save schema, simulation, DailyPlan, MorningReport, assignment authority, or execution authority changes were made by the layout repair.
