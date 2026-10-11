import { projectChronicle } from '../chronicleVisibility.js';
import { esc } from './viewHelpers.js';
import type { SandboxApp } from '../app.js';
type AppViewContext = ReturnType<SandboxApp['viewContext']>;

export function renderPdaChroniclePanel(ctx: AppViewContext): string {
    const viewpoint=ctx.chronicleViewpoint();
    const entries=projectChronicle(ctx.state,viewpoint).slice().reverse();
    const byDay=new Map<number,typeof entries>();
    for(const entry of entries){const bucket=byDay.get(entry.day)??[];bucket.push(entry);byDay.set(entry.day,bucket);}
    const days=[...byDay.entries()].sort((a,b)=>b[0]-a[0]);
    return `<section class="desc-pda-data-panel desc-pda-chronicle-panel"><header><div><span>VISIBLE HISTORY / EVENT LOG</span><h2>年代記</h2></div><em>${viewpoint.kind==='settlement'?'SETTLEMENT':'FIELD'}</em></header><div class="desc-pda-chronicle-ledger">${days.length?days.map(([day,dayEntries])=>`<section><header><strong>DAY ${day}</strong><span>${dayEntries.length} EVENTS</span></header>${dayEntries.map((entry)=>`<article><time>${String(Math.floor(entry.minuteOfDay/60)).padStart(2,'0')}:${String(entry.minuteOfDay%60).padStart(2,'0')}</time><div><strong>${esc(entry.title)}</strong><p>${esc(entry.text)}</p></div></article>`).join('')}</section>`).join(''):'<p class="desc-pda-empty">可視イベントなし。</p>'}</div></section>`;
  }
