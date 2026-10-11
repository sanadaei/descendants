# Descendants Daily Command Center Refinement Design

**Status:** P1–P26 implemented; P27 COMMAND PULSE interview-approved, written design pending final review  
**Date:** 2026-09-16  
**Build basis:** `DESCENDANTS_DAILY_ACTION_LOOP_HANDOFF_2026-09-16`  
**Extends:** `docs/superpowers/specs/2026-09-15-daily-action-loop-design.md`  
**Primary surface:** F1 settlement-side daily command screen

## 1. Goal

Improve the already-playable Morning Report → plan → execute → interruption → next-morning loop without changing its simulation authority, save authority, campaign premise, or player-facing time model.

The refinement must make each morning answer three questions in this order:

1. **What requires attention today?**
2. **Who should do what today?**
3. **What risk am I accepting when I execute this plan?**

The result should feel like a survival command surface rather than a dense diagnostic table. Detailed information remains available, but it is progressively disclosed instead of competing with the current decision.

## 2. Existing behavior that remains authoritative

The following are preserved and must not be reimplemented in parallel:

- `src/sandbox/dailyActionLoop.ts` owns daily snapshot/report/plan/execute orchestration.
- `executeCommittedPlan()` advances canonical simulation through the existing engine and remains the only F1 daily execution path.
- `DailyPlan` continues to carry explicit resident assignments plus expedition/medical AUTO/MANUAL policy.
- MANUAL medical and expedition policies continue to use structured interruptions and may pause execution before the next morning.
- `dailyLoop` remains optional/lazy under save `schemaVersion: 1`.
- No victory condition, defeat condition, fixed ending, or deadline is introduced.
- Player-facing time progression remains `EXECUTE PLAN`; no `+1 day` control returns.
- F2/F3/F4/F5 continue to own deep body/medical, knowledge, inventory/rationing, and chronicle inspection.
- WorldProvider, resource provenance, rationing, Incident, expedition, pathology, generation, and survival systems retain their current authority boundaries.

This design adds a read-only decision layer over those systems. It does not create a second simulation model.

## 3. Design references and translated principles

The implementation borrows interaction principles, not art assets or proprietary content.

### Frostpunk

Use a small number of visibly urgent survival concerns ahead of routine information. The player should see scarcity and human cost before secondary detail.

**Translation:** a bounded “today’s priorities” strip appears before the resident database and never expands into a second dashboard.

### RimWorld

Work assignment is effective because a player can compare people and jobs in one surface while still understanding individual suitability and incapacity.

**Translation:** each resident planning row exposes current condition, prior/current task context, assignment, and a concise risk/suitability reason. The game does not adopt RimWorld’s full work-priority matrix.

### This War of Mine

A clear day-cycle boundary makes the current period itself a decision unit.

**Translation:** F1 is organized around “what changed overnight / what will we do today / execute the day,” reinforcing the already-implemented one-day cadence instead of adding continuous micromanagement.

### Against the Storm

Strong UX comes from preserving game identity while shortening alerts, differentiating them at a glance, and opening the relevant detail panel directly from a notification.

**Translation:** the existing PDA/CRT identity stays intact; alerts are short, state-coded, and actionable; deep detail opens F2/F4/expedition rather than being duplicated in F1.

## 4. Core architectural decision: derived Daily Command Read Model

Add one non-persistent read-model module, tentatively:

`src/sandbox/dailyCommandReadModel.ts`

It receives existing authoritative state and produces presentation-only data. It must contain no mutation, time advancement, random sampling, hidden-world inspection, or persistence.

### Inputs

- `SandboxGameState`
- current `DailyPlan`
- current `MorningReport`
- existing survival campaign projection where useful

### Output

A single derived object conceptually containing:

- `priorities`: up to 3 urgent or important concerns
- `resourceSummary`: food, water, medicine, population, expedition summary and prior-day deltas where evidence exists
- `residentRows`: planning rows with condition, prior/current task context, assigned task, and concise warning reason
- `readiness`: `ready | risk | blocked`
- `readinessIssues`: ordered actionable issues
- `shortcuts`: target F1/F2/F4/expedition destinations for relevant issues

The exact TypeScript names may differ in implementation, but the boundary may not: this layer is derived and read-only.

## 5. Priority derivation

The command surface displays **no more than three** top concerns. More may exist internally, but the screen remains intentionally bounded.

Priority order reuses existing game facts and thresholds rather than inventing unrelated parallel rules:

1. death/newly missing resident or equivalent irreversible morning event;
2. existing `critical` Morning Report resident classifications;
3. existing `severe` or `new-condition` resident classifications;
4. critical water continuity;
5. critical food continuity;
6. severe medical burden or manual medical decision waiting;
7. active MANUAL expedition decision waiting;
8. meaningful expedition change or visible external crisis;
9. unassigned/unsafe daily labor plan;
10. current survival campaign directive;
11. otherwise a low-intensity continuity message.

Where current systems already calculate severity or reserve-day values, the read model consumes them instead of duplicating their formulas.

Each priority has:

- severity/state;
- short title;
- one-line reason grounded in visible state;
- optional direct destination such as Body/Medical, Inventory/Rationing, or Expedition.

No priority may assert hidden causes, guaranteed future outcomes, or World Truth unavailable to the player.

## 6. Resource summary

Immediately below today’s priorities, show a compact survival summary. The default set is:

- population;
- food reserve days;
- water reserve days and/or safety where already available;
- medicine availability/medical burden;
- active expedition count/status.

When a reliable prior-day delta exists, show it adjacent to the current value. Absence of delta is rendered neutrally and must not be inferred as zero consumption or safety.

Healthy values should be visually quiet. Warning and critical values receive emphasis. This prevents every metric from competing for attention.

## 7. Morning Report progressive disclosure

The Morning Report remains authoritative history for the previous execution cycle, but its default presentation changes from “all columns equally visible” to “triage first.”

Default visible rows prioritize:

- death;
- critical;
- severe;
- new condition;
- needs/worsened;
- then watch/improved/stable.

The UI may initially collapse routine stable rows behind an “all residents” disclosure control, but the data is not removed. Expanding the database exposes the existing detailed fields including health delta, hunger/thirst, pathology, task/location, and recommended response.

Selecting a resident continues to use the existing inspection/navigation path; F1 must not duplicate full F2 medical/body detail.

## 8. Today’s Plan resident rows

Every living settlement resident receives one planning row. The row must be readable without opening another view and should contain:

- resident name and role;
- current health/fatigue or compact condition label;
- yesterday/current task context available from the Morning Report or live state;
- today’s explicit assignment selector;
- one concise suitability/risk note when relevant.

Children or residents currently ineligible for work remain visibly non-assignable using existing eligibility rules.

Assignment remains intent, not guaranteed execution. Existing simulation constraints may still prevent the planned task.

The first implementation does **not** add a multi-level 1–4 work-priority matrix, schedules by hour, job queues, or automatic optimal-assignment solver.

## 9. Plan Readiness

Before `EXECUTE PLAN`, derive one plan state:

### READY

No material warning detected from visible current state and the selected plan.

### RISK

The plan is executable, but at least one material concern should be visible before commitment. Examples include:

- critical/severe resident assigned strenuous ordinary labor instead of rest/care-compatible work;
- a resident with severe thirst/hunger assigned demanding work;
- no settlement worker assigned toward an immediately critical food/water continuity problem when such work is available;
- MANUAL medical policy with a severe patient, meaning execution will intentionally stop;
- MANUAL expedition policy with an active expedition, meaning execution will intentionally stop;
- important resident left on a clearly conflicting assignment.

`RISK` never disables execution. Bad or desperate plans remain valid player choices.

### BLOCKED

Reserved only for a state that existing runtime cannot legally execute, for example:

- a direct encounter already blocks normal time progression;
- daily loop phase/state cannot legally commit or resume;
- another existing canonical invariant already prevents execution.

Read-model heuristics alone may never create a new hard block.

## 10. Execution interaction

Keep the existing execute path.

When the player presses `EXECUTE PLAN`:

1. current draft assignments/policies are committed through existing daily-loop functions;
2. `executeCommittedPlan()` runs canonical simulation;
3. AUTO paths continue normally;
4. MANUAL paths render the existing structured interruption with a direct navigation action and “continue this day as AUTO” option;
5. successful day completion performs the existing CRT day transition;
6. the next Morning Report becomes the opening state for the next planning cycle.

The refinement must not create a confirmation modal for every `RISK`. The visible readiness area itself is the warning surface; extra confirmation is only justified if an existing canonical action already requires one.

## 11. Navigation and detail handoff

Priority/readiness items use existing views as detail destinations:

- resident health/pathology → F2 Body & Equipment / current resident;
- food/water/rationing → F4 Inventory / settlement or relevant rationing surface;
- expedition/manual field decision → existing F1 expedition/map surface;
- chronicle/history context → F5;
- knowledge evidence where directly relevant → F3.

Returning to F1 must preserve the draft DailyPlan because that plan already lives in game state. UI-only disclosure state does not need save persistence.

## 12. Visual hierarchy and interaction rules

The existing PC-98/PDA/CRT visual language remains the identity anchor.

Required hierarchy from top to bottom:

1. day / campaign identity;
2. today’s priorities;
3. compact survival summary;
4. Morning Report triage;
5. field/expedition status;
6. Today’s Plan roster and AUTO/MANUAL policies;
7. Plan Readiness + `EXECUTE PLAN`.

Rules:

- normal information uses restrained contrast;
- warning/critical state receives the strongest contrast, not decorative chrome;
- status must never be communicated by color alone;
- buttons use concrete action labels;
- warning text is concise enough to scan at 1440×900 without turning the page into a log viewer;
- stable detail may scroll or collapse inside its section, but the primary page should not require document-level scrolling merely to find `EXECUTE PLAN` at the reference viewport if layout permits;
- existing keyboard focus restoration and accessibility settings must continue working;
- reduced-motion behavior for the CRT transition remains intact.

## 13. Persistence and compatibility

No new persisted sidecar is introduced for this refinement.

- No save schema version change.
- No migration required.
- No cached readiness/priorities written into `SandboxGameState`.
- No duplicate resource or pathology values stored for convenience.
- Reloading recomputes the presentation from authoritative state.

This keeps old saves compatible and prevents stale warnings.

## 14. Error handling

Derived command data must fail soft:

- missing prior-day delta → show neutral “no comparison” state;
- missing optional resident context → omit that specific annotation rather than blocking F1;
- unavailable detail destination → retain readable warning text and leave execution available when canonical runtime allows it;
- malformed or illegal daily-loop phase → existing daily-loop/runtime error remains authoritative and may produce `BLOCKED`.

No UI helper catches and silently converts canonical execution failures into success.

## 15. Testing and visual verification design

Implementation must preserve a playable daily loop after every integration step.

### Machine checks

Add focused tests for the derived read model covering at least:

- top-three bounded priority ordering;
- critical/severe resident surfacing;
- food/water concern surfacing from existing reserve facts;
- READY/RISK/BLOCKED separation;
- RISK never becoming a new execution prohibition;
- no mutation of `SandboxGameState` while deriving the view;
- deterministic output for identical state.

Update F1 UI contract tests for:

- Today’s priorities;
- compact resource summary;
- resident plan context/risk text;
- readiness state;
- direct detail-navigation controls;
- retained `EXECUTE PLAN` and AUTO/MANUAL controls.

Existing daily-action-loop unit tests remain regression authority for execution semantics.

### Screenshot checks

For every meaningful F1 GUI checkpoint, capture a fresh current-build screenshot. At minimum:

- 1440×900 normal morning state;
- 1440×900 crisis/RISK state;
- 1440×900 MANUAL interruption state;
- 1280×720 overflow sanity check when practical.

Historical files such as `docs/screenshots/game-0.8.4-1440x900.png` are design references only. Fresh current-build captures are required for current acceptance evidence, consistent with D19.

Browser/container screenshots are diagnostic and development evidence. They do not replace the existing primary Windows/Electron human visual acceptance boundary.

## 16. Implementation slicing / always-playable constraint

Implementation must be integrated in playable slices in this order:

1. pure read model and tests;
2. priorities + compact resource summary;
3. plan readiness;
4. resident planning-row context and triage disclosure;
5. direct navigation/detail handoff;
6. visual hierarchy, responsive cleanup, accessibility polish;
7. screenshot verification and further presentation polish.

At the end of every slice, the player must still be able to draft a plan, execute it, resolve supported interruptions, and reach the next morning.

If a human visual test or an environment-specific test is unavailable, record that boundary and continue with the next implementation slice rather than halting development.

## 17. Non-goals for this refinement

Do not add in the first implementation:

- new win/loss/end campaign rules;
- new save schema;
- a new simulation scheduler;
- a second resource ledger;
- a second pathology model;
- AI-generated automatic “best plan” execution;
- hourly resident schedules;
- RimWorld-style 1–4 full work matrix;
- new combat/encounter systems;
- wholesale redesign of F2/F3/F4/F5;
- replacement of the PDA/CRT identity with generic modern dashboard styling.

These can be considered later only if they solve a demonstrated play problem.

## 18. Acceptance criteria

The refinement is complete when all of the following are true:

1. F1 exposes no more than three current priorities before routine detail.
2. A player can identify the most endangered resident/resource and the main active expedition concern without reading the full resident table.
3. Every eligible settlement resident can still receive a daily assignment.
4. The player can understand why a plan is READY, RISK, or canonically BLOCKED before execution.
5. RISK plans remain executable.
6. The existing daily execution/interruption/next-morning semantics remain unchanged by the presentation layer.
7. Existing saves load without migration.
8. F2/F4/expedition detail remains reachable directly from relevant F1 concerns.
9. Reduced-motion and keyboard/focus behavior do not regress.
10. Fresh F1 screenshots are produced for current-build visual review.
11. Tests demonstrate the read model is deterministic and does not mutate canonical state.
12. Each implementation checkpoint can be packaged into a recovery ZIP so work can resume without losing the latest playable state.


## 19. P27 — COMMAND PULSE / daily execution feedback refinement

### 19.1 Purpose

P27 strengthens the *felt boundary* between planning a day and living with its consequences. It is a presentation refinement only. The player should perceive four beats without learning a new subsystem:

1. **MORNING** — scan what changed and what matters now;
2. **PLAN** — adjust people/policies and understand current readiness;
3. **EXECUTE** — deliberately commit the plan and hand control to canonical 24-hour simulation;
4. **READBACK** — receive the next morning as observed results, not as predicted outcomes.

The refinement must make the existing one-day loop feel like a command ritual rather than a form submission. It must not create a second simulation, a second objective system, or a persisted animation state.

### 19.2 External references translated into Descendants

Research is used for interaction principles only; no external art, audio, code, or proprietary UI assets are copied.

- **Against the Storm:** important Orders/threats become visibly actionable and the game uses prominent alerts/glowing controls to tell the player what can be acted on now. The official tutorial also makes pause/planning versus resumed simulation a strong interaction boundary. Descendants translates this into a bounded priority pulse, a clearly armed EXECUTE state, and a distinct execution-in-progress state.
- **Frostpunk / Frostpunk 2:** vital actions are kept immediately reachable and survival pressure is visible without requiring the player to parse every subsystem. 11 bit's Frostpunk 2 console UI notes specifically emphasize quick access to vital actions and context-sensitive controls. Descendants keeps the PDA hierarchy and strengthens state plates/execute feedback instead of introducing a radial menu or copying the circular UI.
- **This War of Mine:** the day/night boundary gives each period narrative weight. Descendants already advances by one day; P27 makes the transition visually legible and gives the next morning a factual readback beat.
- **RimWorld:** planning works because assignment state is visible next to the person affected. Descendants keeps the existing per-resident Today’s Plan rows and uses local feedback on the command surface rather than introducing a full work-priority matrix.

Reference URLs inspected for this refinement:

- `https://wiki.hoodedhorse.com/Against_the_Storm/Tutorial_Walkthrough`
- `https://11bitstudios.com/frostpunk-2-console-release-arrives-setpember-18th/`
- `https://11bitstudios.com/games/this-war-of-mine/`
- `https://rimworldwiki.com/wiki/Work`

## 20. Architectural boundary

P27 must stay inside the presentation/controller layer.

### 20.1 Canonical systems remain unchanged

- `src/sandbox/dailyActionLoop.ts` remains the sole daily execution authority.
- `executeCommittedPlan()` still performs the canonical 24-hour simulation step.
- `setDailyAssignment()` and `setExecutionPolicy()` remain the only P27-relevant plan mutation seams.
- `src/sandbox/dailyCommandReadModel.ts` remains authoritative for priorities, plan impact, crisis/rest guidance, long-horizon visibility, and READY/RISK/BLOCKED derivation. P27 should not add a second severity or readiness calculation.
- `SandboxGameState.schemaVersion` remains `1`.
- No P27 field is serialized into `SandboxGameState`, `dailyLoop`, local storage save data, or provider state.

### 20.2 Allowed transient UI state

`src/sandbox/app.ts` may hold small in-memory presentation state such as:

- execution cue phase (`idle`, `locking`, `simulating`);
- the last game day for which the morning entrance pulse was played;
- short-lived readback/command-pulse markers needed to avoid replaying an entrance animation on every same-day re-render.

This state is disposable. Reloading may replay a harmless morning entrance cue, but it must not change simulation or save content.

### 20.3 No new asset bundle

P27 uses the existing PDA/CRT visual vocabulary, CSS gradients/borders/scan effects, and the existing Web Audio synthesis engine. It adds no 3D content and no downloaded art/audio asset. This keeps the project low-cost, internally consistent, and free of new asset provenance obligations.

## 21. Command-state presentation

Add a compact, non-interactive **COMMAND SIGNAL** rail to the Daily Command Center. It communicates the current loop position textually, not by color alone:

`MORNING → PLAN → EXECUTE → READBACK`

Normal planning shows PLAN as current. During commit/execution the rail advances to EXECUTE. The next-morning transition/readback identifies READBACK before returning to the ordinary MORNING/PLAN surface.

The rail is not navigation and does not expose a second timeline. It only reflects the current UI/execution phase.

At 1280-class width it may collapse descriptions, but all four stage labels remain available to assistive technology and the active stage must remain textually identifiable.

## 22. Morning command pulse

When F1 is first shown for a game day, play one restrained entrance sequence:

1. header/status line resolves first;
2. up to three priority cards appear in order;
3. survival summary cells resolve as one group;
4. the highest-severity visible priority receives one brief terminal glow/scan accent.

The effect must run **once per day per live app session**, not every time an assignment, disclosure control, or focus state causes `render()`.

Implementation should prefer the native Web Animations API or one-shot DOM classes applied after render, keyed by the transient last-pulsed day. The DOM is still fully readable if animations are unavailable.

No animation may reorder cards, hide critical text for its duration, or delay interaction with the screen.

## 23. Priority and survival-summary visual hierarchy

P27 may restyle existing data but may not invent new measurements.

### Priorities

- Preserve the existing maximum of three.
- Strengthen the left status rail/number block and severity plate.
- Use critical/warning/normal text labels or existing titles in addition to hue.
- Use a brief glow or sweep only for the current top concern; avoid continuous pulsing across the whole screen.

### Resource summary

- Preserve population / food / water / medicine / expedition values exactly as derived today.
- Add restrained terminal ticks/status rails based only on the existing `tone`; do not turn reserve days, medicine, or expedition count into fabricated percentage meters.
- Healthy cells remain visually quiet so warnings dominate.

## 24. Plan Readiness and commit affordance

The existing `PLAN READINESS` remains the decision gate display.

### READY

- stable green/terminal plate;
- execute button has a controlled edge glow or scan-ready effect;
- textual state remains `READY`.

### RISK

- amber/warning plate with a subtle moving scan or bracket accent;
- execution remains enabled;
- the execute area explicitly includes `RISK` text so the state is not communicated only through color;
- no extra confirmation modal is introduced in P27.

### BLOCKED

- existing canonical block behavior remains authoritative;
- execute stays disabled;
- the block reason remains visible and textual;
- visual treatment may use a static fault pattern, but no distracting infinite flash.

P27 must not reinterpret RISK as BLOCKED and must not add a new runtime prohibition.

## 25. Execution commit sequence

Pressing `EXECUTE PLAN` keeps the current canonical function chain but inserts a short, non-persistent presentation cue around it.

### Sequence

1. Validate canonical block reason exactly as now.
2. Commit the draft through existing `commitDailyPlan()` if required.
3. Set the UI busy/execution state and render a **PLAN LOCKED** execution curtain.
4. Play a short synthesized command-commit sound using the existing Web Audio engine.
5. After a small fixed presentation delay, switch the curtain to **SIMULATING 24H / CANONICAL DAILY LOOP** and call `executeCommittedPlan()`.
6. If execution is interrupted, remove the curtain and show the existing MANUAL interruption path without pretending the day completed.
7. If execution completes, persist/refresh exactly as today and run the CRT day transition into the next morning.

The pre-execution cue should be approximately 180–320 ms in normal motion mode: long enough to register, short enough not to become friction. Reduced-motion mode uses a near-immediate textual state (roughly 40–90 ms) and no transform-heavy animation.

The visual delay occurs only after canonical validation/plan commit and before the existing simulation call. It does not advance game time and does not alter random state.

## 26. Execution curtain

While the daily simulation call is active, render a lightweight full-screen-in-PDA overlay above the command content but below hardware/glass effects.

Required factual text:

- `PLAN LOCKED` during the short commit cue;
- `SIMULATING 24H` once canonical execution begins;
- current day → target next day notation such as `DAY 12 → DAY 13`;
- `CANONICAL DAILY LOOP` or equivalent wording making clear that this is the normal simulation path.

Optional visual treatment:

- horizontal terminal sweep;
- bracket/reticle corners;
- sparse telemetry bars that are decorative only and marked `aria-hidden="true"`;
- low-rate scan noise using CSS rather than an image asset.

Do **not** display fabricated percentages, estimated success, worker efficiency, or resource predictions while simulation is running.

## 27. Next-morning readback transition

The current CRT power-off → day title → power-on sequence remains. P27 enriches only the content and hierarchy.

The day-title phase may show up to three observed factual counters derived directly from the returned `MorningReport`, for example:

- births count;
- deaths count;
- count of severe/critical/new-condition resident deltas, or a concise “no major resident change” fallback.

These are **observed readback facts after simulation**, not a forecast. The existing `morningReportTransitionSummary()` may be extended or paired with a small local pure helper in `app.ts`; there is no need to persist this summary or add it to `dailyCommandReadModel.ts`.

After power-on, the ordinary Daily Command Center remains the source of detailed outcomes (`YESTERDAY'S OUTCOME`, `CRISIS READBACK`, `REST READBACK`, Morning Report).

## 28. Audio treatment

Reuse `src/sandbox/pdaAudio.ts` and its synthetic Web Audio vocabulary.

P27 may add one focused method, e.g. a command-commit cue built from short oscillator/noise envelopes, rather than importing an audio file. The cue should be materially distinct from an ordinary button click but shorter than the full CRT day transition.

Behavior:

- ordinary click still occurs on the execute control;
- command commit adds one confirmation transmission cue;
- completed day transition may add a restrained static/chirp accent;
- RISK may use the same commit cue with the visible RISK plate rather than a punitive alarm;
- canonical errors continue to use the existing buzz/error feedback.

Mute/master-volume settings remain authoritative. No sound may bypass them.

## 29. Accessibility and motion safety

P27 must preserve the existing accessibility contract:

- `prefers-reduced-motion: reduce` and `.a11y-reduce-motion` disable or radically shorten sweeps, glows, transforms, and staged entrance animation;
- critical/readiness states have text labels and structural differences, not color alone;
- overlays do not trap focus;
- no animation steals keyboard focus;
- the execute button retains its normal accessible name and disabled semantics;
- execution/readback status uses restrained `role="status"` / `aria-live` behavior and avoids repeatedly re-announcing on every render;
- high-contrast mode remains legible without depending on translucent gradients.

Continuous CRT scan/flicker behavior remains governed by the existing presentation/accessibility settings.

## 30. Responsive behavior

### 1440×900

The reference layout should keep priorities, resource summary, Morning Report triage, field status, and enough of Today’s Plan readable without the P27 effects obscuring content. The execution curtain can use the full PDA viewport because it is temporary.

### 1280×720

- COMMAND SIGNAL remains one compact row;
- verbose helper copy may collapse;
- priority cards and resource cells retain their values/status labels;
- execute/readiness stays reachable in the existing compact flow;
- no horizontal document or PDA overflow is introduced.

P27 does not attempt a full mobile redesign.

## 31. Planned source changes

Keep the file footprint deliberately small.

### Modify

- `src/sandbox/app.ts`
  - transient command/execution presentation phase;
  - command signal rendering;
  - one-shot morning pulse orchestration;
  - execution curtain rendering;
  - enriched factual next-morning readback content;
  - reuse of canonical `executeDailyPlan()` flow.
- `src/styles.css`
  - command signal;
  - priority/status hierarchy polish;
  - readiness/execute effects;
  - execution curtain;
  - reduced-motion/high-contrast/responsive rules.
- `src/sandbox/pdaAudio.ts`
  - only if necessary, one synthesized command-commit cue; no asset files.
- `tests/daily-action-loop-ui.test.mjs`
  - presentation contract coverage for P27 tokens, reduced-motion requirements, non-blocking RISK, and execution/readback states.
- `docs/superpowers/plans/2026-09-16-daily-command-center-implementation.md`
  - append the approved P27 implementation checklist rather than creating another plan file.
- `docs/screenshots/daily-command-center/`
  - add only final evidence images for meaningful P27 states; do not retain throwaway captures.

### Prefer not to modify

- `src/sandbox/dailyCommandReadModel.ts` unless implementation proves that a purely presentational fact is genuinely missing. No new severity/readiness policy is planned.
- `src/sandbox/dailyActionLoop.ts`.
- save types/schema/migrations.

## 32. Test strategy

Implementation follows the existing playable-slice rule and does not stall on unavailable environment-specific tests.

### Focused machine checks

At minimum verify:

1. P27 command signal / execution curtain / readback tokens are present.
2. RISK still does not disable `EXECUTE PLAN`.
3. BLOCKED still uses the canonical block reason.
4. reduced-motion rules cover new animation selectors.
5. daily execution still calls the existing `executeCommittedPlan()` path once.
6. MANUAL interruption still exits to the existing interruption surface instead of displaying completed-day readback.
7. TypeScript check passes.
8. the focused Daily Command/daily-loop tests pass.

A full unit suite may be run when economical, but a slow environment must not prevent completion after focused relevant checks are clean.

### Visual checks

Capture current-build screenshots, preferably from the real application surface or the established Chromium fallback when environment policy blocks it:

- `p27-normal-1440x900.png` — quiet/normal command state and hierarchy;
- `p27-risk-1440x900.png` — RISK plate with executable action;
- `p27-execution-1440x900.png` — PLAN LOCKED or SIMULATING 24H curtain;
- `p27-readback-1440x900.png` — next-morning transition/readback evidence when capturable deterministically;
- `p27-compact-1280x720.png` — compact overflow/readability check.

Do not keep multiple near-duplicate diagnostic PNGs after selecting the final evidence set.

## 33. P27 acceptance criteria

P27 is complete when all of the following are true:

1. The existing Daily Command Center remains fully playable from Morning Report through next morning.
2. The player can visually distinguish MORNING/PLAN/EXECUTE/READBACK without a new gameplay subsystem.
3. First-view morning priorities receive one restrained daily entrance pulse and do not replay on every same-day plan edit.
4. READY/RISK/BLOCKED are more visually distinct while remaining textually explicit.
5. RISK remains executable and BLOCKED remains canonically controlled.
6. Pressing EXECUTE visibly commits the plan before the simulation call and presents an in-progress state without fake progress metrics.
7. MANUAL interruption still interrupts rather than showing a false completed-day transition.
8. Completed execution still uses the existing CRT day transition and shows only factual returned MorningReport readback.
9. No save schema, simulation authority, random semantics, or Daily Command persistence is added.
10. New effects honor reduced-motion, high-contrast, mute, and keyboard/focus behavior.
11. Fresh 1440×900 and 1280×720 screenshots show no new horizontal overflow and demonstrate the P27 hierarchy/effects.
12. The implementation checkpoint is packaged as a recovery ZIP after verification.

---

# P28 — PLAN BOARD / Crew Assignment UX

## 34. Purpose and research basis

P28 improves the *human assignment decision surface* inside TODAY'S PLAN without creating a second simulation, optimizer, workforce policy, or save model.

The interaction borrows only broad, proven interface ideas from multiple management games:

- **RimWorld Work**: compare people and work categories in one surface rather than opening each person individually.
- **Against the Storm worker slots**: show who is assigned and their immediate status in the workplace surface; staffing changes are direct and reversible before time advances.
- **Frostpunk workforce assignment**: make reassignment legible as movement of limited people between operational needs.

Descendants does not copy their art, assets, layout, numerical priority systems, or production predictions. It translates the underlying interaction into the existing PDA/terminal language.

Research references used for P28:

- https://rimworldwiki.com/wiki/Work
- https://wiki.hoodedhorse.com/Against_the_Storm/Buildings
- https://wiki.hoodedhorse.com/Against_the_Storm/Tutorial_Walkthrough
- https://frostpunk.fandom.com/wiki/People

## 35. Scope and authority boundary

P28 remains a non-persistent presentation layer over existing canonical DailyPlan assignments.

Must remain unchanged:

- `SandboxGameState` schema/version;
- `dailyActionLoop.ts` execution authority;
- `executeCommittedPlan()` as the only 24h daily simulation path;
- `setDailyAssignment()` as the only assignment mutation used by Daily Command UI;
- READY/RISK/BLOCKED semantics;
- crisis recommendation, rest pressure, plan balance, and long-horizon derivation policy.

P28 may derive temporary grouping/count information from `command.residentRows` and `command.crisisRecommendations` inside `app.ts`. It must not persist board selection, lane membership, movement history, suggested yield, staffing targets, or efficiency scores.

## 36. PLAN BOARD information model

Place a new **PLAN BOARD / CREW ASSIGNMENT** immediately above the existing resident roster.

The board has four dynamic lanes:

1. **CRISIS** — residents whose current `assignedTask` matches a task present in `command.crisisRecommendations`.
2. **NORMAL OPS** — current assignments not classified as crisis, rest, or field preparation.
3. **REST** — residents assigned to canonical `rest`.
4. **FIELD** — residents assigned to canonical `explore-prep`.

Lane classification is display-only. It does not change task semantics.

Each lane shows:

- textual lane label and Japanese subtitle;
- exact current resident count;
- resident chips using existing `residentRows` only;
- each chip's name and canonical task label;
- visible warning marker when the existing row has `riskNote`;
- a movement marker when `previousTask !== assignedTask`.

No lane shows target staffing, percentage capacity, efficiency, expected output, or success probability.

## 37. Selected-resident transfer rail

The board has one transient selected resident ID stored only in the `SandboxApp` instance.

Selection behavior:

- first unlocked resident becomes the default board selection when no valid selection exists;
- clicking a resident chip changes only the transient selection and does not mutate game state;
- locked residents can be inspected but have assignment controls disabled;
- selection is not serialized and resets naturally on reload.

The selected-resident rail displays:

- resident name, role and current visible condition;
- `PREVIOUS` canonical task;
- `TODAY` canonical task;
- existing `riskNote` or a neutral text fallback;
- all existing canonical labor tasks as destination buttons.

Pressing a destination button calls exactly:

```ts
setDailyAssignment(this.state, agentId, task)
```

then sets COMMAND SIGNAL to `plan`, preserves the selected resident, focuses the relevant board control after re-render, and uses existing error/toast handling.

The existing resident `<select data-action="daily-assignment">` remains available as the precise fallback/editor. P28 does not remove or bypass it.

## 38. Movement readback

The board derives **STAFF MOVES / 配置変更** from rows where `previousTask !== assignedTask`.

Display at most four compact movement entries in the board header, each as:

`NAME · PREVIOUS → TODAY`

If more than four residents changed, append `+N` as a count only. If there are no changes, display `NO MOVES / 前日配置を維持`.

This is a comparison against the already-visible previous task, not persisted history and not a forecast.

## 39. Visual hierarchy and effects

The PLAN BOARD should feel like a tactical personnel console, not a spreadsheet.

Wide layout:

- four lane cards in a single row;
- lane header has a compact count plate;
- resident chips use an inset terminal slot treatment;
- selected chip receives a restrained reticle/glow;
- moved chips receive a directional accent, not continuous flashing;
- selected-resident transfer rail sits directly below lanes and visually connects PREVIOUS → TODAY → destination controls;
- destination buttons use task-family accents only for hierarchy; textual labels remain primary.

Effects must be CSS-only and low-cost:

- one short scan sweep when a selected chip is rendered;
- subtle arrow/line illumination between PREVIOUS and TODAY;
- hover/keyboard focus raises destination affordance;
- no imported images, 3D assets, video, or external effect packages.

## 40. Responsive and accessibility behavior

At `max-width:1300px`:

- lanes become a 2×2 grid, not a horizontal scroller;
- each lane keeps label, count, resident names, and canonical task abbreviation/label;
- verbose movement copy may truncate, but movement direction remains visible;
- transfer rail collapses to two rows;
- destination task buttons wrap and remain keyboard reachable;
- existing roster stays present below the board.

Accessibility:

- lane and resident selection are real buttons;
- selected resident uses `aria-pressed="true"`;
- destination buttons include the resident and destination in `aria-label`;
- locked resident assignment buttons are disabled;
- risk and move states have text/symbol content, not color only;
- `.a11y-reduce-motion` and `prefers-reduced-motion` disable board scan/transfer animation;
- high-contrast mode replaces translucent glow with solid outlines/backgrounds.

## 41. Planned source changes

Modify only:

- `src/sandbox/app.ts`
  - one transient `#dailyPlanBoardAgentId`;
  - pure local lane/move derivation from existing `command.residentRows`;
  - PLAN BOARD markup;
  - `daily-board-select` and `daily-board-assign` actions;
  - canonical `setDailyAssignment()` reuse.
- `src/styles.css`
  - PLAN BOARD lanes, resident chips, transfer rail, movement accents, reduced-motion/high-contrast/compact rules.
- `tests/daily-action-loop-ui.test.mjs`
  - P28 source-contract tests proving board semantics, canonical mutation path, movement derivation, and accessibility tokens.
- `docs/superpowers/plans/2026-09-16-daily-command-center-implementation.md`
  - append the P28 implementation plan and execution notes.
- `docs/screenshots/daily-command-center/`
  - retain only final P28 visual evidence.

Prefer not to modify:

- `src/sandbox/dailyCommandReadModel.ts`;
- `src/sandbox/dailyActionLoop.ts`;
- `src/sandbox/types.ts`;
- save/storage code;
- audio code (P27 already provides assignment/command interaction vocabulary).

## 42. Test and visual strategy

Focused automated checks must verify:

1. PLAN BOARD renders four textual lanes.
2. lane grouping is derived from current canonical resident assignments and crisis task IDs only.
3. STAFF MOVES uses `previousTask !== assignedTask`.
4. selecting a resident does not call a mutation.
5. board assignment calls existing `setDailyAssignment(this.state,agentId,task)` exactly once through the normal UI handler.
6. the original `daily-assignment` select remains present.
7. locked residents cannot use board destination buttons.
8. reduced-motion and high-contrast styles cover new animated/focus treatment.
9. TypeScript check and focused Daily Command/daily-loop tests pass.

Visual evidence target:

- `p28-plan-board-1440x900.png` — four lanes + selected-resident transfer rail;
- `p28-move-applied-1440x900.png` — STAFF MOVES and changed assignment treatment;
- `p28-plan-board-1280x720.png` — 2×2 lane compact layout and reachable transfer controls.

Use the real runtime capture route if container policy permits. If the same Chromium/Electron administrative block persists, use the established static CSS visual-QA fallback and label it explicitly as non-runtime evidence.

## 43. P28 acceptance criteria

P28 is complete when:

1. TODAY'S PLAN exposes an at-a-glance four-lane workforce board.
2. a player can select a resident and change the resident's canonical DailyPlan assignment directly from the board.
3. the original select-based assignment editor remains functional.
4. previous-to-current staffing moves are immediately visible without new persisted history.
5. crisis/rest/normal/field grouping is descriptive only and does not introduce policy or optimization.
6. RISK remains executable and BLOCKED remains canonical.
7. no save schema, simulation formula, probability, efficiency, target staffing, or fabricated progress is introduced.
8. 1440×900 and 1280×720 visual hierarchy remains usable.
9. focused automated verification is green or any environment-only blocker is recorded without stalling implementation.

# P29 — ASSIGNMENT CONSEQUENCE READBACK

## 44. Intent and reference pattern

P29 closes the P28 workforce loop without adding simulation authority. The player should be able to answer a narrow factual question the next morning: **which residents were moved from yesterday's baseline, what task actually ran, and what resident-state deltas were observed by Morning Report?**

The interaction pattern borrows from colony-management interfaces that keep worker assignment and worker status in the same decision context: RimWorld's resident-by-work matrix and Against the Storm's worker-slot status/alert vocabulary. Descendants must keep its existing PDA/CRT presentation rather than copying either interface literally.

P29 does **not** claim that an assignment caused a resource, health, or survival outcome. It only juxtaposes the executed move with the next canonical Morning Report resident delta.

## 45. Authority boundaries

P29 must preserve all existing authority seams:

- `setDailyAssignment()` remains the only Daily Command assignment mutation.
- `executeCommittedPlan()` remains the only 24-hour daily execution path.
- `MorningReport` remains the authoritative next-morning observation.
- no `SandboxGameState`, save schema, migration, daily-loop formula, yield estimate, success probability, efficiency score, or staffing target is added.
- no resource delta is attributed to a specific resident.
- RISK remains executable; BLOCKED remains derived only from the existing canonical block reason.

The readback is deliberately session-local presentation state. Reloading the app may remove the move-specific readback; the canonical Morning Report remains available and truthful.

## 46. Transient move snapshot and readback lifecycle

Immediately before a draft plan is committed, capture the final P28 STAFF MOVES from the same resident rows used by the PLAN BOARD:

```ts
interface DailyAssignmentMoveSnapshot {
  agentId: string;
  name: string;
  fromTask: LaborTask;
  toTask: LaborTask;
}
```

Only rows where `previousTask !== assignedTask` are captured. Intermediate edits are intentionally discarded; the snapshot represents the final plan submitted for that day.

`SandboxApp` holds two non-persistent fields:

```ts
#pendingAssignmentMoves: DailyAssignmentMoveSnapshot[] = [];
#assignmentConsequenceReadback: DailyAssignmentConsequenceReadback[] = [];
```

Lifecycle:

1. when `executeDailyPlan()` begins with a `draft` plan, derive the current command view and capture final move snapshots before `commitDailyPlan()`;
2. if execution returns `interrupted`, keep `#pendingAssignmentMoves` unchanged so AUTO resume in the same runtime retains the original submitted moves;
3. when execution returns `completed`, combine the pending move snapshots with `result.report.residentDeltas`, write the factual readback, then clear the pending snapshots;
4. if no final staff moves existed, the readback is empty;
5. if a runtime reload occurs before completion, do not reconstruct or guess historical moves from current state.

## 47. Pure consequence projection

Add a pure helper to `dailyCommandReadModel.ts` so the factual projection is independently testable:

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

export function assignmentConsequenceReadback(
  moves: readonly DailyAssignmentMoveSnapshot[],
  report: MorningReport,
): DailyAssignmentConsequenceReadback[];
```

The helper must:

- match only by `agentId`;
- copy observed values directly from `MorningResidentDelta`;
- preserve the move's `fromTask` and `toTask` rather than deriving a new historical baseline;
- sort by `severityScore` descending, then resident name;
- never read settlement resource deltas;
- never synthesize a row for an unmatched resident.

Presentation tone uses the existing Morning severity vocabulary: `death`/`critical` → critical, `severe`/`new-condition`/`needs`/`worsened`/`watch` → warning, `improved`/`stable` → normal. No new numeric risk threshold is introduced.

## 48. Morning presentation

Render a separate band immediately after `YESTERDAY'S OUTCOME` and before the compact resource summary when `#assignmentConsequenceReadback` is non-empty:

- eyebrow: **ASSIGNMENT READBACK**;
- title: **昨日の配置結果**;
- helper: **OBSERVED AFTER STAFF MOVE · 因果確定ではありません**;
- summary: total moved residents and count whose Morning severity is not `stable` or `improved`;
- at most four resident trace cards, with `+N` overflow text when needed.

Each card contains:

1. resident name and Morning severity text;
2. `PREVIOUS → EXECUTED` task trail using `laborTaskDisplayName()`;
3. exact `HP ±N → current`, `FAT ±N`, and `MOR ±N` values from Morning Report;
4. the existing Morning Report summary text;
5. a `daily-detail` action targeting the resident's body detail.

The cards must not show percentage success, resource contribution, causal labels, or inferred productivity.

## 49. Visual language and accessibility

The band should visually connect P28's transfer rail to P27's READBACK phase:

- a thin transfer trace from PREVIOUS to EXECUTED;
- a short CRT acquisition sweep on fresh READBACK only;
- text severity labels and border symbols in addition to color;
- no progress bar or animated percentage;
- `prefers-reduced-motion` and `.a11y-reduce-motion` remove sweep/trace animation;
- high-contrast mode uses solid outlines/backgrounds;
- at 1280-class widths, trace cards become a single compact column and retain all text labels.

## 50. Planned source changes

Modify only:

- `src/sandbox/dailyCommandReadModel.ts`
  - add the pure move/readback types and `assignmentConsequenceReadback()` helper.
- `src/sandbox/app.ts`
  - add two transient fields;
  - capture final STAFF MOVES before first commit;
  - retain pending moves across same-runtime MANUAL interruption;
  - finalize readback from the completed `MorningReport`;
  - render the ASSIGNMENT READBACK band using the existing `daily-detail` navigation action.
- `src/styles.css`
  - add assignment readback cards, transfer trace, fresh-readback sweep, compact/reduced-motion/high-contrast rules.
- `tests/daily-command-read-model.test.mjs`
  - verify exact factual projection and no unmatched synthesis.
- `tests/daily-action-loop-ui.test.mjs`
  - verify transient capture/completion/interruption lifecycle and canonical authority tokens.
- `tests/pda-presentation.test.mjs`
  - verify readback styling/accessibility/compact tokens.
- existing design/implementation-plan documents and final screenshot folder only.

Do not modify `dailyActionLoop.ts`, `types.ts`, save/storage code, simulation formulas, or audio for P29.

## 51. Acceptance criteria

P29 is complete when:

1. a final STAFF MOVE submitted for execution is captured only in transient UI memory;
2. same-runtime MANUAL interruption/resume preserves that pending move list;
3. completed execution projects only matching canonical Morning Report resident deltas into readback;
4. the morning band shows the resident's previous task, executed task, observed HP/fatigue/morale changes, and Morning severity;
5. clicking a readback resident uses the existing F2/body detail route;
6. no resource delta is attributed to an individual resident and no causal language is used;
7. no save schema, simulation, `DailyPlan`, `MorningReport`, or authority interface changes are introduced;
8. no-move days render no synthetic assignment readback;
9. reduced-motion, high-contrast, 1440×900, and 1280×720 presentation remain usable;
10. focused type/build/tests pass or an environment-only blocker is explicitly recorded without stalling packaging.

## 52. P30 MORNING REVIEW / REPLAN ASSIST

P30 closes the P28/P29 learning loop without adding prediction or automation authority. After a completed day, residents that were part of the transient P29 STAFF MOVE snapshot and whose canonical Morning Report severity is not `stable` or `improved` are surfaced in a compact morning replan queue. The queue is decision support only: it points the player back to the existing PLAN BOARD and existing `setDailyAssignment()` seam.

### 52.1 Authority and persistence boundary

- The source of observed consequence remains `MorningReport.residentDeltas`; P30 does not infer a new cause or outcome.
- The source of yesterday's changed assignment remains the transient P29 `DailyAssignmentConsequenceReadback`; P30 does not persist a second history.
- No `SandboxGameState`, save schema, `DailyPlan`, `MorningReport`, simulation, or execution-authority interface changes are allowed.
- Reloading may clear the P29/P30 transient review history. This is intentional; the canonical Morning Report remains the durable record.
- P30 never chooses a task automatically. The player remains responsible for assignment decisions.

### 52.2 Pure replan projection

Add a pure projection over the existing P29 readback and current Daily Command rows. It must:

1. keep only P29 entries whose severity is not `stable` or `improved`;
2. join only by `agentId` to a current `DailyResidentPlanRow`;
3. preserve P29 `severityScore` ordering with name as the deterministic tie-breaker;
4. expose yesterday's `fromTask`, yesterday's executed `toTask`, today's current `assignedTask`, observed HP/FAT/MOR deltas, Morning summary, and severity;
5. mark `replanned=true` only when today's current assignment differs from yesterday's executed task;
6. mark `restEligible=true` only when the same agent already exists in the canonical P18/P19 `restPressure.candidates` list;
7. omit unmatched residents rather than synthesizing records.

P30 must not create a new fatigue/health threshold, recommendation score, success probability, or causal label.

### 52.3 Morning replan band

Render `MORNING REPLAN / 朝の再配置確認` after the P29 assignment readback and before the main plan section. Show at most four entries. Each entry must retain textual severity independent of color and show:

- resident name;
- `YESTERDAY MOVE`: previous task → executed task;
- `TODAY`: current assignment;
- `HP / FAT / MOR` observed deltas;
- canonical Morning Report summary;
- explicit status `UNCHANGED` or `REPLANNED`.

The helper copy must state that this is review support from observed morning data, not an automatic recommendation.

### 52.4 Actions

Every P30 entry exposes `PLANを見る`. That action must:

1. set the existing `#dailyPlanBoardAgentId` to the resident;
2. set the command phase to `plan`;
3. rerender;
4. focus and scroll the existing PLAN BOARD chip for that resident into view.

A `休養へ` action may appear only when `restEligible=true`. It must call the existing `setDailyAssignment(this.state, agentId, 'rest')`, select that resident in PLAN BOARD, and rerender. It is forbidden to show the quick-rest action for a resident who is not already in canonical `REST PRESSURE`.

### 52.5 Presentation and effects

- Use a compact CRT review band rather than another full database table.
- Non-stable severity must remain visible through text and border semantics, not color alone.
- On fresh morning readback, the band may use one short acquisition/scan pulse. It is not a progress meter.
- `PLANを見る` focus may trigger the existing PLAN BOARD selected-chip reticle/scan; no new animation state needs persistence.
- `REPLANNED` must be visibly distinct from `UNCHANGED` using label, border, and transfer treatment.
- Reduced Motion disables acquisition/transfer animation. High Contrast uses solid current-color borders/backgrounds.
- At 1280-class widths, entries become a single-column review list while retaining yesterday move, today assignment, severity, deltas, and both available actions.

### 52.6 P30 acceptance criteria

P30 is complete when:

1. only P29 moved residents with non-stable/non-improved Morning severity enter the replan queue;
2. queue ordering follows existing Morning severityScore without a new score;
3. each entry shows yesterday move, today assignment, observed HP/FAT/MOR changes, Morning summary, and textual severity;
4. `REPLANNED` is derived only from today's canonical assignment differing from yesterday's executed assignment;
5. `PLANを見る` focuses the existing PLAN BOARD resident without mutating the plan;
6. `休養へ` is rendered only for an existing canonical REST PRESSURE candidate and uses existing `setDailyAssignment(...,'rest')`;
7. no auto-assignment, prediction, save schema, simulation, or authority seam is added;
8. no P29 readback means no synthetic P30 queue;
9. reduced-motion, high-contrast, 1440×900, and 1280×720 presentation remain usable;
10. focused regression and full unit verification pass, or any environment-only visual-runtime blocker is recorded without stalling the recovery ZIP.

## 53. P31 SETTLEMENT TELEMETRY / SURVIVAL INSTRUMENTS

P31 upgrades the existing five-card `resourceSummary` into a compact survival-instrument strip. The goal is not to add a second resource model; it is to make the current survival pressure readable at a glance using only facts and severity semantics that already exist in the Daily Command / Survival Campaign / Morning Report surfaces.

Reference principles carried into Descendants are: persistent top-level survival telemetry, explicit warning state that remains legible without color, exact current values, and short-path drill-down into the authoritative screen. P31 deliberately excludes speculative graphs, projected depletion dates beyond the existing canonical reserve-day metrics, inferred productivity, and generated history.

### 53.1 Authority and data boundary

- `SandboxGameState`, save schema, `DailyPlan`, `MorningReport`, simulation formulas, and execution authority remain unchanged.
- `deriveSurvivalCampaignView()` remains the source of canonical food reserve days, water reserve days, water safety, local population, and living population.
- `state.settlement.resources` remains the source of current physical aggregate stock shown by the Daily Command surface.
- `MorningReport.resourceDeltas`, `births`, `deaths`, and `expeditionUpdates` are the only previous-24h facts used for change readback.
- P31 may classify exact categorical expedition states such as `missing`, `captured`, or `time-displaced` as a visible WATCH condition, but it must not invent a probability or severity score for them.
- The existing `reserveTone()` thresholds remain the only food/water reserve thresholds. Water safety continues to use the existing `<55` critical boundary. Medicine continues to use the existing severe-resident/stock rule.
- No synthetic time series, rolling average, forecast, efficiency estimate, or days-to-event calculation is allowed.

### 53.2 Extended instrument projection

Extend `DailyResourceSummaryItem` in `dailyCommandReadModel.ts` rather than adding a second parallel read model:

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

Projection rules:

1. **Population**
   - value: canonical local population;
   - detail: all living population plus away count when non-zero;
   - trend: `activity` when births or deaths exist, otherwise `none`;
   - trendLabel: exact `BIRTH +N · DEATH -N`, or `NO 24H CHANGE`;
   - tone: `critical` only when the current Morning Report records at least one death; otherwise `normal`;
   - target: `chronicle`.
2. **Food**
   - value: canonical reserve days already used by P1-P30 (`N.N日` / `∞`);
   - detail: exact current aggregate stock;
   - trend from `MorningReport.resourceDeltas.food`: `up`, `down`, or `flat`; absent report/delta -> `none`;
   - trendLabel: exact `24H Δ ±N.N`, or `NO 24H SAMPLE`;
   - tone: existing `reserveTone(foodDays)`;
   - target: `inventory`.
3. **Water**
   - value: canonical reserve days;
   - detail: exact `安全度 N% · stock N.N`;
   - trend from exact `resourceDeltas.water` using the same direction vocabulary;
   - tone: existing water-safety critical rule, otherwise existing reserve tone;
   - target: `inventory`.
4. **Medicine**
   - value: exact current medicine stock;
   - detail: exact severe-resident count already used by the current summary;
   - trend from exact `resourceDeltas.medicine`;
   - tone: the existing medicine/severe-resident rule;
   - target: `inventory`.
5. **Expedition**
   - value: exact active expedition count;
   - detail: current categorical status counts, compacted to observed active statuses;
   - trend: `activity` when `MorningReport.expeditionUpdates` is non-empty, otherwise `none`;
   - trendLabel: exact `24H UPDATE N`, or `NO 24H UPDATE`;
   - tone: `warning` when an active expedition is currently `missing`, `captured`, or `time-displaced`; otherwise `normal`;
   - target: `expedition`.

`statusLabel` is a direct textual rendering of `tone`: normal -> `STABLE`, warning -> `WATCH`, critical -> `CRITICAL`. This is not a new score.

### 53.3 Instrument presentation

Replace the old plain `.desc-daily-resource-summary` card markup with a richer semantic instrument while preserving the section class and five-card ordering so existing layout contracts remain recognizable.

Each `.desc-survival-instrument` must contain:

- compact label and `STABLE / WATCH / CRITICAL` text;
- large current value;
- exact supporting fact (`stock`, `water safety`, severe residents, all living, expedition status);
- an `OBSERVED 24H` row with an explicit arrow/state symbol and exact trend label;
- a three-cell pressure indicator labeled by state semantics rather than a fake percentage;
- a drill-down button using the existing `daily-detail` action and the item's existing-authority target.

The three-cell indicator is categorical only. It lights the cell corresponding to the existing `tone`; it must not imply 33/66/100 percent completion or resource quantity.

### 53.4 Visual effects and accessibility

- Normal instruments have a low-level CRT phosphor edge and no continuous animation.
- WATCH and CRITICAL instruments may use a short low-frequency border pulse; CRITICAL may use a stronger scan flash, but both must remain readable when animation is disabled.
- A resource with an exact non-zero 24h delta gets a one-pass `telemetryAcquire` sweep on fresh morning render only. No indefinite moving graph is allowed.
- Positive/negative direction must be conveyed by `↑ / ↓ / = / •` text in addition to color.
- High Contrast uses solid `currentColor` outlines and explicit status text.
- Reduced Motion and `prefers-reduced-motion` disable pulse/acquisition animation.
- At 1280-class widths the five instruments become a 3+2 compact grid; labels, values, exact 24h fact, and detail action remain visible.

### 53.5 Interaction

All drill-down remains non-authoritative navigation:

- population -> existing Chronicle view, where births/deaths are canonical visible events;
- food/water/medicine -> existing Inventory view;
- expedition -> existing Expedition task panel.

No instrument click mutates state, changes assignments, launches an expedition, consumes resources, or executes a day.

### 53.6 Planned source changes

Modify only:

- `src/sandbox/dailyCommandReadModel.ts`
  - extend `DailyResourceSummaryItem` with textual status/trend/target fields;
  - derive exact current/24h instrument facts with no new persistence or simulation.
- `src/sandbox/app.ts`
  - render the richer five-instrument telemetry strip;
  - route drill-down through existing `daily-detail` navigation.
- `src/styles.css`
  - add instrument hierarchy, categorical pressure cells, exact-delta direction styling, low-frequency alert/acquisition effects, reduced-motion/high-contrast/1280-class rules.
- `tests/daily-command-read-model.test.mjs`
  - verify exact projection from canonical reserve/current/report facts and absence of forecast fields.
- `tests/daily-action-loop-ui.test.mjs`
  - verify five instrument semantics and non-mutating existing detail routing.
- `tests/pda-presentation.test.mjs`
  - verify visual/accessibility/compact contracts.
- existing design/implementation-plan documents and screenshot folder only.

Do not modify `dailyActionLoop.ts`, `survivalCampaign.ts`, `types.ts`, save/storage code, resource simulation formulas, or audio for P31.

### 53.7 P31 acceptance criteria

P31 is complete when:

1. all five existing Daily Command survival summaries render as semantic instruments with current value, supporting fact, text status, observed-24h fact, and drill-down;
2. food/water reserve pressure uses only existing canonical reserve-day thresholds;
3. water safety uses only the existing `<55` critical rule;
4. medicine uses the existing severe-resident/current-stock rule;
5. population change is read only from canonical births/deaths and expedition activity only from current statuses plus canonical expedition updates;
6. no forecast, synthetic history, new score, percentage productivity, or fake sparkline is introduced;
7. all detail actions remain non-mutating navigation to existing authoritative surfaces;
8. no save schema, simulation, `DailyPlan`, `MorningReport`, or authority seam changes are introduced;
9. reduced-motion, high-contrast, 1440×900, and 1280×720 presentation remain usable;
10. focused regression and full unit verification pass, or any environment-only runtime screenshot blocker is explicitly recorded without stalling the recovery ZIP.

## 54. P31 Layout Repair — Playable Daily Command / Task Split

### 54.1 Root cause

P27-P31 added substantial vertical content to `pdaCampaignCommand()`, while the F1 campaign shell still used `grid-template-rows:auto minmax(0,1fr)` with `overflow:hidden`. The `auto` Daily Command row therefore expanded to its full content height and collapsed the canonical Task / Play / Status row to effectively zero height. The earlier WeasyPrint visual-QA route also produced false CSS Grid overlap artifacts, so it is no longer acceptable as evidence for this screen.

### 54.2 Layout contract

For desktop/tablet F1 campaign viewports above the existing mobile breakpoint:

- `.desc-pda-campaign-screen` uses a bounded 40/60 split: `minmax(0,2fr) minmax(0,3fr)`;
- `.desc-pda-campaign-command` is an independent vertical scroll region and may never expand the outer campaign grid;
- the canonical `.desc-pda-task-layout` keeps the lower 60% play surface available;
- the central `.desc-pda-task-detail` is independently scrollable so its canonical task actions, including `EXECUTE PLAN`, remain reachable even when the lower pane is shorter than its content;
- no Daily Command content, task semantics, simulation authority, or save schema changes are introduced.

At the existing `max-width:700px` breakpoint the established stacked/mobile campaign layout remains authoritative.

### 54.3 Screenshot and QA contract

P31 layout evidence must use Chromium's production CSS engine with the built portable HTML/CSS/JS/worldgen payload. A temporary persistence recovery session may be used only because the sandbox browser origin cannot provide durable IndexedDB; the recovery banner is environment-only and is hidden for screenshot evidence. URL-navigation policy blockers must not be worked around by returning to WeasyPrint for Grid verification.

Required evidence:

- `p31-layout-fixed-1440x900.png` — initial F1 view with both Daily Command and Task / Play / Status visibly usable;
- `p31-scroll-actions-fixed-1440x900.png` — independent upper/lower scrolling with lower task actions reachable;
- `p31-layout-fixed-1280x720.png` — compact viewport with the lower play surface still materially available.

### 54.4 Acceptance criteria

The repair is complete when:

1. the old `auto + 1fr` campaign split is absent;
2. Daily Command has `overflow-y:auto` and stable scrollbar behavior;
3. Task / Play / Status receives a non-zero 60% grid share at 1440×900 and 1280×720;
4. central Task detail has `overflow-y:auto`, and its action row can be scrolled into the visible lower pane;
5. Chromium runtime measurements confirm both panes remain non-collapsed;
6. presentation regression protects the split and independent scrolling;
7. old WeasyPrint P31 screenshots that showed false Grid overlap are removed from the handoff ZIP.
