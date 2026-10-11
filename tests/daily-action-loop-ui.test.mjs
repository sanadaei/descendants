import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/sandbox/app.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const readModel = await readFile(new URL('../src/sandbox/dailyCommandReadModel.ts', import.meta.url), 'utf8');

test('F1 is organized as an in-world morning report, field status, and operations roster', () => {
  for (const token of ['MORNING REPORT','探索・遠征の現状','OPERATIONS ROSTER','BEGIN OPERATIONS','data-action="daily-assignment"','data-action="daily-policy"','data-action="execute-plan"']) {
    assert.ok(app.includes(token), `missing daily command surface token: ${token}`);
  }
  for (const token of [
    'COMMAND QUEUE',
    'desc-daily-priorities',
    'desc-daily-resource-summary',
    'deriveDailyCommandView',
    'data-action="daily-detail"',
  ]) {
    assert.ok(app.includes(token), `missing Daily Command Center token: ${token}`);
  }
  assert.doesNotMatch(app, /data-action="advance" data-hours="24"/);
  assert.doesNotMatch(app, />\+1日<|>\+1 day</);
});

test('Morning Report renders sortable resident severity rows and real before-after fields', () => {
  for (const token of ['residentDeltas','severityScore','healthDelta','newPathologyIds','recommendedResponse','data-morning-agent-id']) {
    assert.ok(app.includes(token), `missing Morning Report token: ${token}`);
  }
});

test('F1 exposes AUTO/MANUAL policies and interruption resolution controls', () => {
  for (const token of ['expedition','medical','AUTO','MANUAL','data-action="resolve-daily-interruption-auto"']) {
    assert.ok(app.includes(token), `missing execution policy/interruption token: ${token}`);
  }
});

test('CRT day transition has power off, day title, power on, Japanese day label and reduced-motion fallback', () => {
  for (const token of ['crt-power-off','crt-day-title','crt-power-on','日目']) assert.ok(app.includes(token) || css.includes(token), `missing CRT transition token: ${token}`);
  assert.match(css, /@keyframes\s+descCrtPowerOff/);
  assert.match(css, /@keyframes\s+descCrtPowerOn/);
  assert.match(css, /scaleY\(/);
  assert.match(css, /prefers-reduced-motion|a11y-reduce-motion/);
});


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


test('Plan Readiness exposes READY RISK BLOCKED while RISK remains executable', () => {
  for (const token of ['OPERATION STATUS', 'data-readiness=', 'READY', 'RISK', 'BLOCKED']) assert.ok(app.includes(token));
  assert.match(app, /command\.readiness==='blocked'/);
  assert.doesNotMatch(app, /command\.readiness==='risk'\?['"]disabled/);
  assert.match(app, /dailyExecutionBlockReason/);
});

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

test('Daily Command Center routes concerns to existing authoritative detail surfaces', () => {
  for (const target of ['body','inventory','expedition','map','knowledge','chronicle','task']) {
    assert.match(app, new RegExp(`target === '${target}'|target==='${target}'`), `missing Daily Command target route: ${target}`);
  }
  assert.match(app, /this\.#inspectedAgentId = agentId/);
  assert.match(app, /this\.#pdaTaskPanel = 'expedition'/);
});

test('Morning Report and MANUAL interruption hand off directly to authoritative detail surfaces', () => {
  assert.match(app, /visibleMorningRows\.map[\s\S]*?data-action="daily-detail" data-daily-target="body" data-agent-id="\$\{esc\(delta\.agentId\)\}"/);
  assert.match(app, /interruption\.kind==='medical'\?[\s\S]*?<button data-action="daily-detail" data-daily-target="body" data-agent-id=/);
  assert.match(app, /data-action="daily-detail" data-daily-target="expedition">手動で探索を操作/);
});

test('Daily Command Center exposes textual state and accessible disclosure/readiness semantics', () => {
  assert.match(app, /aria-labelledby="daily-priorities-title"/);
  assert.match(app, /aria-label="Daily survival summary"/);
  assert.match(app, /aria-expanded=/);
  assert.match(app, /data-readiness=/);
  assert.match(app, /OPERATION STATUS/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /prefers-reduced-motion|a11y-reduce-motion/);
});

test('Daily plan displays localized labor labels while retaining task values only in control attributes', () => {
  assert.match(app, /laborTaskDisplayName\(row\.previousTask\)/);
  assert.match(app, /<option value="\$\{task\}"[^>]*>\$\{esc\(laborTaskDisplayName\(task\)\)\}<\/option>/);
});

test('Daily Command Center closes the daily loop with a compact yesterday outcome band', () => {
  for (const token of ["YESTERDAY'S OUTCOME", '昨日の結果', 'command.outcomes.map', 'desc-daily-outcome-strip']) {
    assert.ok(app.includes(token) || css.includes(token), `missing outcome feedback token: ${token}`);
  }
  assert.match(app, /data-daily-outcome=/);
  assert.match(css, /\.desc-daily-outcome-strip/);
});


test('yesterday outcome marks observed rest recovery as a dedicated readback', () => {
  assert.match(app, /RECOVERY REPORT/);
  assert.match(app, /data-rest-readback=/);
  assert.match(css, /\.desc-daily-outcome-rest-readback/);
});

test('yesterday response outcome identifies crisis readback without implying causal prediction', () => {
  assert.match(app, /CRISIS REPORT/);
  assert.match(app, /data-crisis-readback=/);
  assert.match(css, /\.desc-daily-outcome-readback/);
});

test('Daily Command header provides a no-state-change jump directly to Today plan', () => {
  assert.match(app, /href="#daily-plan-section"/);
  assert.match(app, /id="daily-plan-section"/);
  assert.match(app, /当直へ ↓/);
  assert.match(css, /\.desc-daily-plan-jump/);
});

test('same-day plan rerenders preserve campaign scroll but a new morning starts at the report top', () => {
  assert.match(app, /data-scroll-day="\$\{this\.state\.clock\.day\}"/);
  assert.match(app, /previousCampaign\.dataset\.scrollDay/);
  assert.match(app, /nextCampaign\?\.dataset\.scrollDay===previousCampaignScroll\.day/);
  assert.match(app, /action==='daily-plan-jump'[\s\S]*?event\.preventDefault\(\)[\s\S]*?scrollIntoView/);
});


test('Today plan shows immediate non-simulated plan impact feedback before readiness', () => {
  for (const token of ['ROSTER EFFECT', '配置変化', 'command.planImpact', 'desc-daily-plan-impact']) {
    assert.ok(app.includes(token) || css.includes(token), `missing plan impact token: ${token}`);
  }
  assert.match(app, /command\.planImpact\.map/);
  assert.match(css, /\.desc-daily-plan-impact/);
});


test('daily execution gives immediate progress text and next-morning transition summary', () => {
  for (const token of ['#dailyExecutionActive', 'OPERATIONS ACTIVE', 'morningReportTransitionSummary', 'desc-pda-day-title-summary']) {
    assert.ok(app.includes(token) || css.includes(token), `missing execution feedback token: ${token}`);
  }
  assert.match(app, /playDayTransition\(result\.report\.day/);
});

test('crisis response shortlist offers one-click canonical DailyPlan assignments', () => {
  for (const token of ['CRISIS CREW', '危機対応候補', 'command.crisisRecommendations', 'data-action="daily-quick-assign"', 'data-crisis-response']) {
    assert.ok(app.includes(token), `missing crisis response shortlist token: ${token}`);
  }
  assert.match(app, /setDailyAssignment\(this\.state,agentId,task\)/);
  assert.match(css, /\.desc-daily-crisis-response/);
});

test('crisis crew explains candidate fit and supports two-person canonical batch assignment', () => {
  for (const token of ['candidate.reasons', 'desc-daily-crisis-tags', 'daily-quick-assign-group', 'data-agent-ids']) {
    assert.ok(app.includes(token) || css.includes(token), `missing crisis comparison/batch token: ${token}`);
  }
  assert.match(app, /candidate\.reasons\.map/);
  assert.match(app, /agentIds\.split\(','\)/);
  assert.match(app, /setDailyAssignment\(this\.state,agentId,task\)/);
});

test('compact crisis crew keeps Today plan dense enough for 1280x720 execution', () => {
  assert.doesNotMatch(css, /@media\(max-width:1300px\)\{[^}]*\.desc-daily-crisis-response\{grid-template-columns:1fr\}/s);
  assert.match(css, /\.desc-daily-plan:has\(\.desc-daily-crisis-response\) \.desc-daily-roster\{max-height:90px\}/);
  assert.match(css, /\.desc-daily-readiness\{grid-template-columns:140px minmax\(0,1fr\) 160px\}/);
  assert.match(css, /@media\(max-width:1300px\)\{[\s\S]*?\.desc-daily-policy>small\{display:none\}/);
});

test('compact crisis comparison keeps tags readable while preserving readiness visibility', () => {
  assert.match(css, /@media\(max-width:1300px\)\{[\s\S]*?\.desc-daily-crisis-response button>small\{display:none\}/);
  assert.match(css, /@media\(max-width:1300px\)\{[\s\S]*?\.desc-daily-crisis-tags\{flex-wrap:nowrap;overflow:hidden\}/);
  assert.match(css, /@media\(max-width:1300px\)\{[\s\S]*?\.desc-daily-readiness-issues button,.desc-daily-readiness-issues p\{padding:3px 5px\}/);
});

test('PDA grid children stay within the CRT viewport without horizontal scroll state hacks', () => {
  assert.match(css, /\.desc-pda-screen>\.desc-pda-header,\.desc-pda-screen>\.desc-pda-content,\.desc-pda-screen>\.desc-pda-footer\{min-width:0;max-width:100%;width:100%\}/);
  assert.doesNotMatch(app, /previousScreenScrollLeft/);
  assert.doesNotMatch(app, /nextScreen\.scrollLeft = previousScreenScrollLeft/);
});

test('unresolved crisis readback provides a direct follow-up path into crisis crew planning', () => {
  for (const token of ['daily-follow-up-crisis', '対応を続ける', 'data-crisis-follow-up', 'FOLLOW-UP']) {
    assert.ok(app.includes(token) || css.includes(token), `missing crisis follow-up token: ${token}`);
  }
  assert.match(app, /issue\.id==='outcome-response-log'[\s\S]*?issue\.tone!=='normal'[\s\S]*?command\.crisisRecommendations\.length/);
  assert.match(app, /action==='daily-follow-up-crisis'[\s\S]*?scrollIntoView/);
  assert.match(app, /action==='daily-follow-up-crisis'[\s\S]*?\.focus\(\)/);
});

test('crisis follow-up compares yesterday staffing with today planned staffing in place', () => {
  assert.match(app, /昨日 \$\{recommendation\.previousCount\}名 → 今日 \$\{recommendation\.assignedCount\}名/);
});

test('crisis follow-up can restore yesterday staffing gap in one canonical action with rotation cues', () => {
  for (const token of ['continuityShortfall', 'fillCandidateIds', 'workedSameTaskYesterday', 'daily-fill-crisis-gap', '昨日水準へ補充', '昨日担当は後順位']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P8 continuity/rotation token: ${token}`);
  }
  assert.match(app, /action==='daily-fill-crisis-gap'[\s\S]*?setDailyAssignment\(this\.state,agentId,task\)/);
  assert.match(app, /recommendation\.fillCandidateIds[\s\S]*?join\(','\)/);
  assert.match(app, /recommendation\.continuityShortfall > 0/);
  assert.match(readModel, /昨日も\$\{laborTaskDisplayName\(definition\.task\)\}/);
  assert.match(readModel, /昨日は別任務/);
});

test('crisis crew can rotate one repeated responder with a fresh rest or records candidate through canonical assignments', () => {
  for (const token of ['rotationSwap', 'daily-rotate-crisis', '1名交代', 'data-outgoing-agent-id', 'data-incoming-agent-id', 'data-incoming-previous-task']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P9 crisis rotation swap token: ${token}`);
  }
  assert.match(app, /action==='daily-rotate-crisis'[\s\S]*?setDailyAssignment\(this\.state,outgoingAgentId,incomingPreviousTask\)[\s\S]*?setDailyAssignment\(this\.state,incomingAgentId,task\)/);
});

test('crisis rotation swap names both sides in its accessible label', () => {
  assert.match(app, /data-action="daily-rotate-crisis"[\s\S]*?aria-label="\$\{esc\(recommendation\.rotationSwap\.outgoingName\)\}を[\s\S]*?\$\{esc\(recommendation\.rotationSwap\.incomingName\)\}を/);
});

test('multi-crisis crew exposes candidate conflicts and a canonical conflict-avoiding batch action', () => {
  for (const token of ['crisisConflicts', 'crisisBalanceAssignments', 'STAFF CONFLICT', 'daily-balance-crises', '他危機候補']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P10 multi-crisis coordination token: ${token}`);
  }
  assert.match(app, /action==='daily-balance-crises'[\s\S]*?setDailyAssignment\(this\.state,agentId,task\)/);
});

test('crisis crew renders explicit response order and conflict balancing follows the same ordered assignments', () => {
  for (const token of ['priorityOrder', 'urgencyTone', 'urgencyDetail', 'RESPONSE ORDER', '対応順']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P11 crisis response-order token: ${token}`);
  }
  assert.match(app, /#\$\{recommendation\.priorityOrder\}/);
  assert.match(app, /recommendation\.urgencyDetail/);
  assert.match(app, /command\.crisisBalanceAssignments\.map\(\(entry\)=>[^\n]*entry\.priorityOrder/);
});

test('top response-order crisis exposes a one-person canonical FOCUS #1 action', () => {
  for (const token of ['crisisFocusAssignment', 'FOCUS #1', 'daily-focus-top-crisis', '#1へ1名配置']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P12 focus-action token: ${token}`);
  }
  assert.match(app, /action==='daily-focus-top-crisis'[\s\S]*?setDailyAssignment\(this\.state,agentId,task\)/);
  assert.match(app, /data-action="daily-focus-top-crisis"[\s\S]*?data-priority-order="\$\{command\.crisisFocusAssignment\.priorityOrder\}"/);
});

test('FOCUS #1 stays inside the narrow crisis title column without covering candidate controls', () => {
  assert.match(css, /\.desc-daily-crisis-focus\{display:grid;grid-template-columns:1fr/);
  assert.match(css, /\.desc-daily-crisis-focus>button\{[^}]*min-width:0[^}]*width:100%[^}]*overflow:hidden/);
});

test('crisis crew exposes coverage progress and a non-mutating next-crisis navigation action', () => {
  for (const token of ['crisisCoverage', 'COVERAGE', '対応進捗', 'daily-next-crisis', '次の危機へ']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P13 crisis coverage token: ${token}`);
  }
  assert.match(app, /action==='daily-next-crisis'[\s\S]*?scrollIntoView/);
  assert.match(app, /data-action="daily-next-crisis"[\s\S]*?data-crisis-id="\$\{esc\(command\.crisisCoverage\.nextCrisisId/);
  assert.doesNotMatch(app, /action==='daily-next-crisis'[\s\S]{0,450}?setDailyAssignment/);
});

test('compact crisis coverage keeps the numeric progress visible when detail copy is hidden', () => {
  assert.match(app, /COVERAGE \$\{command\.crisisCoverage\.coveredCount\}\/\$\{command\.crisisCoverage\.totalCount\} \/ 対応進捗/);
  assert.match(css, /@media\(max-width:1300px\)\{\.desc-daily-crisis-coverage[\s\S]*?\.desc-daily-crisis-coverage>small\{display:none\}/);
});


test('plan readiness mirrors crisis minimum coverage without turning RISK into a block', () => {
  for (const token of ['crisis-coverage-gap', 'COVERAGE COMPLETE', '最低配置未達', 'readiness-coverage']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P14 readiness coverage token: ${token}`);
  }
  assert.match(app, /data-readiness-coverage=/);
  assert.match(readModel, /id: 'crisis-coverage-gap'/);
});

test('compact crisis crew hides only verbose response-order prose so readiness and execute remain in view', () => {
  assert.match(css, /@media\(max-width:1300px\)[^{]*\{[\s\S]*?\.desc-daily-crisis-response-title>small\{display:none\}/);
  assert.ok(app.includes('RESPONSE ORDER / 対応順'));
  assert.ok(app.includes('COVERAGE'));
});

test('compact completed crisis readiness removes redundant no-warning copy and tightens the verdict label', () => {
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-readiness-label\{[^}]*padding:3px 5px/);
  assert.match(css, /readiness-ready\[data-readiness-coverage\]:not\(\[data-readiness-coverage="none"\]\) \.desc-daily-readiness-issues p\{display:none\}/);
});

test('completed crisis coverage exposes a one-person recovery action back to the prior safe task', () => {
  for (const token of ['crisisRecovery', 'RECOVERY CAPACITY', 'daily-release-crisis-excess', '余剰1名を戻す']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P15 crisis recovery token: ${token}`);
  }
  assert.match(app, /action==='daily-release-crisis-excess'[\s\S]*?setDailyAssignment\(this\.state,agentId,returnTask\)/);
  assert.match(app, /data-action="daily-release-crisis-excess"[\s\S]*?data-return-task="\$\{command\.crisisRecovery\.assignment\.returnTask\}"/);
});

test('completed crisis planning exposes normal-operation baseline gaps without adding a second planning state', () => {
  for (const token of ['normalOpsBalance', 'NORMAL OPS', '平常業務', '前日比']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P16 normal-ops token: ${token}`);
  }
  assert.match(readModel, /normalOpsBalance/);
  assert.doesNotMatch(readModel, /normalOpsHistory|normalOpsTarget/);
});

test('daily command renders a non-authoritative plan balance comparing crisis, normal ops, and rest', () => {
  for (const token of ['planBalance', 'CREW BALANCE', '危機対応', '平常業務', '休養', 'data-plan-balance']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P17 plan-balance token: ${token}`);
  }
  assert.doesNotMatch(readModel, /planBalanceTarget|planBalanceRequired/);
});


test('plan balance exposes one safe baseline recovery action without changing readiness semantics', () => {
  for (const token of ['planBalanceRecovery', 'CREW RECOVERY', 'daily-restore-plan-balance', '前日構成へ戻す']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P18 balance-recovery token: ${token}`);
  }
  assert.match(app, /action==='daily-restore-plan-balance'[\s\S]*?setDailyAssignment\(this\.state,agentId,returnTask\)/);
  assert.doesNotMatch(readModel, /planBalanceRecoveryTarget|planBalanceRecoveryRequired/);
});

test('daily command exposes non-authoritative rest pressure using the existing visible fatigue and health thresholds', () => {
  for (const token of ['restPressure', 'REST PRESSURE', '休養圧', 'daily-rest-resident', '休養へ']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P19 rest-pressure token: ${token}`);
  }
  assert.match(app, /action==='daily-rest-resident'[\s\S]*?setDailyAssignment\(this\.state,agentId,'rest'\)/);
  assert.match(readModel, /fatigue >= 45 \|\| agent\.health <= 70/);
  assert.doesNotMatch(readModel, /restPressureTarget|restPressureRequired|restPressureHistory/);
});

test('rest readback exposes a non-persistent follow-up handoff without a second assignment path', () => {
  for (const token of ['restFollowUp', 'RECOVERY WATCH', '休養継続', '再休養', 'data-rest-follow-up']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P21 rest-follow-up token: ${token}`);
  }
  assert.match(app, /outcome-rest-recovery[\s\S]*?command\.restFollowUp/);
  assert.match(app, /data-action="daily-rest-resident"/);
  assert.doesNotMatch(readModel, /restFollowUpHistory|restFollowUpTarget|restFollowUpRequired/);
});


test('recovered rest readback exposes a review-only return-to-duty handoff without inventing a task', () => {
  for (const token of ['restReleaseReview', 'DUTY CLEARANCE', '復帰確認', 'daily-review-return', '復帰先を選ぶ']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P22 rest-release token: ${token}`);
  }
  const handler = app.match(/if \(action==='daily-review-return'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.match(handler, /daily-assignment/);
  assert.doesNotMatch(handler, /setDailyAssignment/);
  assert.doesNotMatch(readModel, /restReleaseTask|restReleaseHistory|restReleaseTarget/);
});



test('return review exposes safe normal-op comparison context without adding an auto-return mutation', () => {
  for (const token of ['taskContexts', 'DUTY OPTIONS', '復帰比較', 'data-return-context']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P23 return-context token: ${token}`);
  }
  const handler = app.match(/if \(action==='daily-review-return'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.doesNotMatch(handler, /setDailyAssignment/);
  assert.doesNotMatch(readModel, /returnContextTarget|returnContextRequired|returnContextHistory/);
});


test('return review keeps comparison context beside the focused Today plan assignment control', () => {
  assert.match(app, /returnReviewByAgent/);
  assert.match(app, /desc-daily-resident-return-context/);
  assert.match(app, /data-return-context-row/);
});


test('compact Today plan keeps the return-context label visible beside recovery gaps', () => {
  assert.doesNotMatch(css, /\.desc-daily-resident-return-context em\{display:none\}/);
});



test('return context shows deterministic staffing effect and visible suitability beside each option', () => {
  for (const token of ['effectDetail', 'fitDetail', 'data-return-effect', 'data-return-fit']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P24 return-option comparison token: ${token}`);
  }
  assert.match(app, /DUTY OPTIONS[\s\S]*?data-return-effect/);
  assert.doesNotMatch(readModel, /returnContextYield|returnContextSuccess|returnContextPrediction/);
});

test('return context shows deterministic post-selection PLAN BALANCE impact without auto-applying it', () => {
  for (const token of ['balanceEffectDetail', 'balanceDirection', 'data-return-balance', 'CREW BALANCE']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P25 return-balance token: ${token}`);
  }
  const handler = app.match(/if \(action==='daily-review-return'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.doesNotMatch(handler, /setDailyAssignment/);
  assert.doesNotMatch(readModel, /returnBalanceYield|returnBalanceSuccess|returnBalancePrediction/);
});

test('compact Today plan uses a short return-balance label while the morning review keeps the full comparison', () => {
  assert.ok(readModel.includes('balanceEffectCompact'), 'missing compact P25 balance copy');
  assert.match(app, /data-return-balance=.*?balanceEffectDetail/);
  assert.match(app, /desc-daily-resident-return-context[\s\S]*?balanceEffectCompact/);
});

test('wide return review lets one or two candidate controls share the available width without an empty fixed column', () => {
  assert.match(css, /\.desc-daily-rest-release\{display:flex/);
  assert.match(css, /\.desc-daily-rest-release>button\{[^}]*flex:1/);
});

test('interactive rest outcome cards stack readback and follow-up controls instead of crushing copy horizontally', () => {
  assert.match(css, /\.desc-daily-outcome-strip article:has\(\.desc-daily-rest-follow-up\),\.desc-daily-outcome-strip article:has\(\.desc-daily-rest-release\)\{grid-template-columns:1fr\}/);
});

test('quiet ready mornings render a non-persistent LONG HORIZON milestone band', () => {
  for (const token of ['longHorizon', 'CONTINUITY DIRECTIVE', '次期継承工程', 'data-long-horizon']) {
    assert.ok(app.includes(token) || readModel.includes(token), `missing P26 long-horizon token: ${token}`);
  }
  assert.match(app, /longHorizon[\s\S]*?daily-detail/);
  assert.doesNotMatch(readModel, /longHorizonHistory|longHorizonTargetState|longHorizonPrediction/);
});

test('P27 command pulse exposes MORNING PLAN EXECUTE READBACK without changing canonical execution authority', () => {
  for (const token of [
    'SHIFT CYCLE', 'MORNING', 'ORDERS', 'OPERATE', 'REPORT',
    '#commandPulsePhase', 'desc-command-signal', 'desc-command-execution-curtain',
    'ORDERS SEALED', 'DAY CYCLE ACTIVE', 'SETTLEMENT CLOCK', 'playCommandCommit',
  ]) assert.ok(app.includes(token) || css.includes(token), `missing P27 command pulse token: ${token}`);
  assert.match(app, /await\s+executeCommittedPlan\(this\.provider,this\.state\)/);
  assert.doesNotMatch(app, /command\.readiness==='risk'[^\n]*disabled/);
});

test('P27 next-morning overlay uses observed MorningReport facts and interruption never claims completion', () => {
  assert.match(app, /result\.report\.births\.length/);
  assert.match(app, /result\.report\.deaths\.length/);
  assert.match(app, /result\.report\.residentDeltas/);
  assert.match(app, /result\.status==='interrupted'[\s\S]*?#commandPulsePhase='plan'/);
  assert.doesNotMatch(app, /success rate|efficiency|forecast|predicted yield/i);
});

test('P28 PLAN BOARD groups the visible roster into crisis normal rest and field lanes without new authority', () => {
  for (const token of ['DUTY BOARD','CREW ASSIGNMENT','ROSTER CHANGES','#dailyPlanBoardAgentId','daily-board-select','daily-board-assign']) {
    assert.ok(app.includes(token), `missing P28 plan-board token: ${token}`);
  }
  for (const lane of ['crisis','normal','rest','field']) assert.ok(app.includes(`data-plan-board-lane="${lane}"`), `missing P28 lane ${lane}`);
  assert.match(app, /previousTask\s*!==\s*row\.assignedTask|row\.previousTask\s*!==\s*row\.assignedTask/);
  assert.match(app, /action==='daily-board-assign'[\s\S]*?setDailyAssignment\(this\.state,agentId,task\)/);
  const selectionHandler = app.match(/if \(action==='daily-board-select'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.doesNotMatch(selectionHandler, /setDailyAssignment|executeCommittedPlan|commitDailyPlan/);
  assert.ok(app.includes('data-action="daily-assignment"'), 'existing assignment select must remain');
});

test('P28 PLAN BOARD preserves keyboard, reduced-motion, high-contrast, and compact lane readability', () => {
  for (const token of ['aria-pressed=', 'desc-daily-plan-board', 'desc-plan-board-lane', 'desc-plan-board-transfer']) assert.ok(app.includes(token) || css.includes(token));
  assert.match(css, /\.a11y-reduce-motion[\s\S]*?\.desc-plan-board-chip\.is-selected|\.a11y-reduce-motion[\s\S]*?\.desc-plan-board-transfer-path/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?desc-plan-board/);
  assert.match(css, /a11y-contrast[\s\S]*?desc-daily-plan-board/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-plan-board-lanes\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});


test('P29 captures final staff moves before first commit, preserves them across interruption, and finalizes only from MorningReport', () => {
  for (const token of ['#pendingAssignmentMoves', '#assignmentConsequenceReadback', 'assignmentConsequenceReadback', 'DUTY REPORT', 'AFTER-ACTION OBSERVATION']) {
    assert.ok(app.includes(token), `missing P29 token: ${token}`);
  }
  assert.match(app, /currentPlan\.status==='draft'[\s\S]*?#pendingAssignmentMoves[\s\S]*?commitDailyPlan\(this\.state\)/);
  const interruptedBranch = app.match(/if\(result\.status==='interrupted'\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
  assert.ok(interruptedBranch, 'missing interrupted branch');
  assert.doesNotMatch(interruptedBranch[1], /#pendingAssignmentMoves\s*=\s*\[\]/);
  assert.match(app, /assignmentConsequenceReadback\(this\.#pendingAssignmentMoves,result\.report\)/);
  assert.match(app, /#pendingAssignmentMoves\s*=\s*\[\]/);
  assert.match(app, /DUTY REPORT[\s\S]*?data-daily-target="body"/);
  assert.doesNotMatch(app, /DUTY REPORT[\s\S]{0,1600}?(?:success rate|efficiency|成功率|効率|resource contribution)/i);
});

test('P30 morning replan routes observed staff-move alerts back to PLAN BOARD without automatic reassignment', () => {
  assert.match(app, /morningReplanQueue\(this\.#assignmentConsequenceReadback,command\.residentRows,command\.restPressure\)/);
  for (const token of ['DUTY REVIEW', '要観察員の勤務照合', 'ON DUTY', 'REASSIGNED', 'MORNING WATCH']) {
    assert.ok(app.includes(token), `missing P30 morning replan token: ${token}`);
  }
  assert.match(app, /data-action="daily-replan-focus"/);
  assert.match(app, /entry\.restEligible[\s\S]*?data-action="daily-replan-rest"/);
  const focusHandler = app.match(/if \(action==='daily-replan-focus'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.match(focusHandler, /#dailyPlanBoardAgentId=agentId/);
  assert.match(focusHandler, /scrollIntoView/);
  assert.doesNotMatch(focusHandler, /setDailyAssignment|commitDailyPlan|executeCommittedPlan/);
  const restHandler = app.match(/if \(action==='daily-replan-rest'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.match(restHandler, /restPressure\?\.candidates\.some/);
  assert.match(restHandler, /setDailyAssignment\(this\.state,agentId,'rest'\)/);
});

test('F1 player-facing copy contains no developer-facing metatext or raw labor task ids', () => {
  const visibleDailySource = `${app}\n${readModel}`;
  for (const phrase of [
    '今日、先に判断すること', 'severityScore descending', '自動推奨ではありません', '因果確定ではありません',
    'PLANを見る', 'SIMULATING 24H', 'CANONICAL DAILY LOOP', 'IMAGE DETACHED', 'NO VISUAL ASSET',
    '隠れたWorld Truthは表示しない', "TODAY'S PRIORITIES", "TODAY'S PLAN", 'PLAN READINESS',
    'COMMAND SIGNAL', 'PLAN BOARD', 'MORNING REPLAN', 'ASSIGNMENT READBACK',
    'AUTOは既存simulationへ委任', 'PLAYTEST ROUTE / GUIDANCE ONLY', 'ACTION FEASIBILITY / NOT A QUEST',
    'Provider projection only.', 'Advance canonical time', 'real simulation inputs',
    'Visual QA · trigger simulated WEDO', 'PROVIDER-CONFIRMED MIGRANT IDENTITY',
    'PROVIDER-ANCHORED IDENTITY', 'LIVED GAME-STATE IDENTITY', 'Confidence is epistemic',
    'CONTROLLED CHARACTER', 'No legitimate controller', 'canonical 10 min', 'Research gate:',
    'Field-controlled party truth', 'PROVIDER TOPOLOGY', 'provider-observed disruption',
    'WORLD positions use provider coordinates', 'LOCAL projection unavailable', 'WORLD projection unavailable',
    'NO CONTROLLER', 'WORLD PROVIDER', 'No hidden biography was inferred',
    'institution not updated automatically', 'Physical provenance retained',
    'Persistent save failed and the session switched to volatile recovery mode',
    'Provider state may have advanced without a committed matching game state',
    'Provider reconstructed from the last committed snapshot', 'provider resynchronization failed',
    'Observer-safe response read/write seam', 'session-local', 'no hidden cause inference',
    'PROVIDER ROUTE', 'provider-visible', 'provider-observed', 'visible LOCAL projection',
    'No unseen detour is synthesized', 'hidden current tracking', 'hidden current coordinates',
  ]) assert.ok(!visibleDailySource.includes(phrase), `developer-facing metatext remains: ${phrase}`);
  for (const phrase of ['COMMAND QUEUE', '未処理の指令', 'DUTY REVIEW', '要観察員の勤務照合', 'DUTY BOARD', 'BEGIN OPERATIONS']) {
    assert.ok(app.includes(phrase), `missing in-world replacement: ${phrase}`);
  }
  assert.doesNotMatch(app, />\$\{task\}<\/small>/, 'raw labor task ids must not be rendered in the duty board');
  assert.doesNotMatch(app, /laborTaskDisplayName\(row\.previousTask\)\} \/ \$\{esc\(row\.previousTask\)\}/, 'raw previous task ids must not be shown beside localized labels');
});

test('field and chronology player copy does not expose engine vocabulary', async () => {
  const { readFile } = await import('node:fs/promises');
  const fieldSources = await Promise.all([
    'src/sandbox/externalSimulation.ts',
    'src/sandbox/rendezvousEncounterSimulation.ts',
    'src/sandbox/fieldDecisionSimulation.ts',
    'src/sandbox/externalActions.ts',
  ].map((path) => readFile(path, 'utf8')));
  const visibleEventSource = fieldSources.join('\n');
  for (const phrase of [
    'External society observed through WorldProvider',
    'provider projection materialized',
    'Projection comes from WorldProvider',
    'observed explicit provider evidence',
    'hidden target coordinates',
    'newer provider evidence',
    'observer-bounded provider projection',
    '[epistemically unfounded]',
    'External provider command failed',
  ]) assert.ok(!visibleEventSource.includes(phrase), `engine vocabulary remains in player chronology source: ${phrase}`);
});

test('P31 survival instruments expose exact observed telemetry and only navigate to existing detail surfaces', () => {
  for (const token of [
    'SURVIVAL INSTRUMENTS',
    'desc-survival-instrument',
    'OBSERVED 24H',
    'desc-instrument-pressure',
    'data-instrument-trend=',
    'data-instrument-status=',
  ]) assert.ok(app.includes(token), `missing P31 telemetry token: ${token}`);
  assert.match(app, /command\.resourceSummary\.map/);
  assert.match(app, /data-action="daily-detail"[\s\S]*?data-daily-target="\$\{item\.target\}"/);
  assert.doesNotMatch(app, /SURVIVAL INSTRUMENTS[\s\S]{0,3000}?(?:forecast|predicted|sparkline|efficiency|productivity|success rate)/i);
  const detailHandler = app.match(/if \(action==='daily-detail'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.ok(detailHandler.length > 0, 'daily-detail handler must exist');
  assert.doesNotMatch(detailHandler, /setDailyAssignment|executeCommittedPlan|commitDailyPlan|launchExpedition|resources\.[a-z]+\s*[-+]?=/);
});
