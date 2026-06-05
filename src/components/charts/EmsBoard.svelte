<script lang="ts">
  import { scaleLinear } from 'd3-scale';
  import { line } from 'd3-shape';

  interface Trend { act: number[]; fc?: number[]; base?: number; warn?: number; }
  interface ReportRow { item: string; value: string; unit: string; }
  interface PanelRow { label: string; value?: string; cells?: string[]; delta?: { text: string; good: boolean }; pending?: boolean; }
  interface EsgPanel { id: string; icon: string; title: string; compare?: boolean; cols?: string[]; rows: PanelRow[]; }
  interface Hospital { name: string; updated?: string; liveData?: boolean; layout?: 'stack' | 'split'; scenarios: { id: string; label: string }[]; resources: any[]; report?: { esg: ReportRow[]; benchmark: ReportRow[] }; esgPanels?: EsgPanel[]; }

  let { hospital }: { hospital: Hospital } = $props();
  let scenario = $state('peace');
  let liveMode = $state<'fixed' | 'live'>('fixed');
  let exportOpen = $state(false);
  const liveData = $derived(hospital.liveData ?? false);
  // 即時模式但 EMS 尚未接入 → 即時量測項顯示「待接」
  const pending = $derived(liveMode === 'live' && !liveData);
  // 只有「即時模式 + 已接 EMS」才畫即時/預測序列；否則圖表只留基準/警戒參考線
  const showSeries = $derived(liveMode === 'live' && liveData);

  function doExport(kind: 'esg' | 'benchmark') {
    exportOpen = false;
    const label = kind === 'esg' ? 'ESG報告資料' : '節能標竿獎資料';
    const rows: ReportRow[] = hospital.report?.[kind] ?? [];
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [
      `${hospital.name} — ${label}`,
      '項目,數值,單位',
      ...rows.map((r) => [r.item, r.value, r.unit].map((c) => esc(c ?? '')).join(',')),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${hospital.name}_${label}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ESG 語意鍵 → token；其他 color 鍵直接對應 --color-<key>
  const ESG: Record<string, string> = { grey: 'text-secondary', green: 'accent', blue: 'chart-4', amber: 'energy', na: 'border' };
  function tone(key: string): string {
    return `var(--color-${ESG[key] ?? key})`;
  }

  // 從對比表 cells 計算最近兩個有值年度的增減%（碳排類：越低越好 → 升=紅、降=綠、持平=灰）
  function deltaInfo(cells: string[]) {
    const parsed = cells.map((c) => {
      const n = parseFloat(String(c).replace(/[^0-9.\-]/g, ''));
      return isNaN(n) ? null : n;
    });
    const valid = parsed.map((n, i) => ({ n, i })).filter((x) => x.n != null) as { n: number; i: number }[];
    if (valid.length < 2) return null;
    const cur = valid[valid.length - 1].n;
    const prev = valid[valid.length - 2].n;
    if (prev === 0) return null;
    const pct = ((cur - prev) / prev) * 100;
    const idx = valid[valid.length - 1].i;
    if (Math.abs(pct) < 0.05) return { text: '▬', good: null as boolean | null, idx };
    return { text: (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '%', good: pct < 0, idx };
  }

  // 即時(act) + 預測(fc) + 基準線(base) + 警戒線(warn)，用 d3-scale / d3-shape
  function buildChart(trend: Trend) {
    const act = trend?.act ?? [];
    if (!act.length) return null; // 待盤點：無資料，不畫圖
    const fc = trend.fc ?? [];
    const all = [...act, ...fc];
    const vals = [...all, trend.base, trend.warn].filter((v): v is number => v != null);
    const max = Math.max(...vals), min = Math.min(...vals);
    const pad = (max - min) * 0.18 || 1;
    const W = 100, H = 44;
    const x = scaleLinear().domain([0, Math.max(all.length - 1, 1)]).range([0, W]);
    const y = scaleLinear().domain([min - pad, max + pad]).range([H - 2, 2]);
    const lg = line<{ i: number; v: number }>().x((d) => x(d.i)).y((d) => y(d.v));
    const actPts = act.map((v, i) => ({ i, v }));
    const fcPts = fc.length ? [{ i: act.length - 1, v: act[act.length - 1] }, ...fc.map((v, k) => ({ i: act.length + k, v }))] : [];
    return {
      actPath: lg(actPts) ?? '',
      fcPath: fcPts.length ? (lg(fcPts) ?? '') : '',
      baseY: trend.base != null ? y(trend.base) : null,
      warnY: trend.warn != null ? y(trend.warn) : null,
      nowX: x(act.length - 1),
      dotX: x(act.length - 1),
      dotY: y(act[act.length - 1]),
    };
  }
</script>

{#snippet chartSvg(pc: ReturnType<typeof buildChart>, withSeries: boolean)}
  <svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
    {#if pc.warnY != null}<line x1="0" y1={pc.warnY} x2="100" y2={pc.warnY} class="ln-warn" />{/if}
    {#if pc.baseY != null}<line x1="0" y1={pc.baseY} x2="100" y2={pc.baseY} class="ln-base" />{/if}
    {#if withSeries}
      <line x1={pc.nowX} y1="0" x2={pc.nowX} y2="44" class="ln-now" />
      <path d={pc.actPath} class="ln-act" />
      {#if pc.fcPath}<path d={pc.fcPath} class="ln-fc" />{/if}
      <circle cx={pc.dotX} cy={pc.dotY} r="2.4" class="dot-act" />
    {/if}
  </svg>
{/snippet}

<div class="board-page" class:split={hospital.layout === 'split'}>
  <header class="topbar">
    <h1 class="ttl">🔋 平戰轉EMS · {hospital.name}</h1>
    <div class="legend" aria-hidden="true">
      <span><i style="background:var(--color-accent)"></i>再生</span>
      <span><i style="background:var(--color-text-secondary)"></i>市電</span>
      <span><i style="background:var(--color-chart-4)"></i>儲能</span>
      <span><i style="background:var(--color-energy)"></i>化石</span>
      <span class="sep"><span class="ln" style="border-color:var(--color-primary)"></span>即時</span>
      <span><span class="ln dash" style="border-color:var(--color-chart-5)"></span>預測</span>
      <span><span class="ln dash" style="border-color:var(--color-text-secondary)"></span>基準</span>
      <span><span class="ln dash" style="border-color:var(--color-alert)"></span>警戒</span>
      <span class="sep"><i style="background:var(--color-accent);opacity:.25"></i>在線</span>
      <span><i style="background:var(--color-surface)"></i>無資料</span>
    </div>
    <div class="toggle" role="group" aria-label="情境切換">
      {#each hospital.scenarios as s}
        <button type="button" class:active={scenario === s.id} onclick={() => (scenario = s.id)}>{s.label}</button>
      {/each}
    </div>
    <button type="button" class="mode-switch" class:live={liveMode === 'live'} onclick={() => (liveMode = liveMode === 'fixed' ? 'live' : 'fixed')} aria-label="切換固定／即時資料">
      {liveMode === 'fixed' ? '📊 固定資料' : '📡 即時資料'}
    </button>
    <div class="export">
      <button type="button" class="export-btn" onclick={() => (exportOpen = !exportOpen)} aria-haspopup="menu" aria-expanded={exportOpen}>匯出 ▾</button>
      {#if exportOpen}
        <div class="export-menu" role="menu">
          <button type="button" role="menuitem" onclick={() => doExport('esg')}>ESG 報告資料</button>
          <button type="button" role="menuitem" onclick={() => doExport('benchmark')}>節能標竿獎資料</button>
        </div>
      {/if}
    </div>
  </header>

  <div class="board">
    {#each hospital.resources as r}
      {@const d = r[scenario]}
      {@const pc = buildChart(d.perf)}
      <section class="res">
        <div class="res-head">
          <span class="res-name">{r.icon} {r.name}</span>
          <span class="perfwrap">
            <span class="pchart">{#if pc}{@render chartSvg(pc, showSeries)}{:else}<span class="no-data">資料待盤點</span>{/if}</span>
            <span class="lbl">
              {@html d.perf.text}<br />
              <span class="endur">⏳ {pending ? '續航待接量測' : `${d.endur.days} · ${d.endur.pct}`}</span>
            </span>
          </span>
        </div>
        <div class="res-body">
          <!-- 供給端 -->
          <div class="seg">
            <div class="seg-h">🔌 供給端 <small>誰在供</small></div>
            {#each d.supply as s}
              <div class="srow" class:off={pending || !s.online} style="border-left-color:{tone(s.esg)}">
                <span class="nm">{s.name}</span><span class="vv">{pending ? '待接電表' : s.value}</span>
              </div>
            {/each}
            <div class="srow sum"><span class="nm">合計</span><span class="vv">{pending ? '待接' : d.supplySum}</span></div>
            {#if d.detailLabel}<div class="subhd">{d.detailLabel}</div>{/if}
            {#each d.detail as dt}
              <div class="drow" class:warn={dt.warn}><span>{dt.name}</span><span>{dt.value}</span></div>
            {/each}
          </div>
          <!-- 儲存緩衝 -->
          <div class="seg">
            <div class="seg-h">🛢️ 儲存 <small>剩多久</small></div>
            <div class="tanks">
              {#each d.store as st}
                <div class="tank" class:warn={st.warn && !pending}>
                  <div class="days">{#if pending}—{:else if st.days === '待盤點'}<span class="pend-sm">待盤點</span>{:else}{st.days} <small>天</small>{/if}</div>
                  <div class="col"><span class="pct">{pending ? '待接' : st.pct + '%'}</span><i style="height:{pending ? 0 : st.pct}%"></i></div>
                  <div class="nm">{st.name}</div>
                  <div class="cap">{st.cap}</div>
                </div>
              {/each}
            </div>
          </div>
          <!-- 使用端 -->
          <div class="seg">
            <div class="seg-h">⚙️ 使用端 <small>即時·趨勢</small></div>
            <div class="use-big">{pending ? '待接即時量測' : d.use.headline}</div>
            <div class="use-bsub">{d.use.sub}</div>
            <div class="use-grid">
              {#each d.use.blocks as b}
                {#if b.kind === 'status'}
                  <div class="ublock statb" style="border-top-color:{tone(b.color)}">
                    <div class="top"><span class="bn">{b.name}</span><span class="bp">{b.sub}</span></div>
                    <div class="stwrap">
                      <div class="bv">{b.value}</div>
                      {#if pending}
                        <div class="pending-note">運轉狀態待接設備監測</div>
                      {:else}
                        <div class="stbar">{#each b.segs as g}<i style="flex:{g.count};background:{tone(g.color)}"></i>{/each}</div>
                        <div class="stnote">{#each b.segs as g}<span><b>{g.count}</b> {g.label}</span>{/each}</div>
                      {/if}
                    </div>
                  </div>
                {:else}
                  {@const bc = b.trend ? buildChart(b.trend) : null}
                  <div class="ublock" style="border-top-color:{tone(b.color)}">
                    <div class="top"><span class="bn">{b.name}</span><span class="bp">{b.sub}</span></div>
                    <div class="bv">{pending ? '待接' : b.value}</div>
                    {#if bc}<div class="chartbox">{@render chartSvg(bc, showSeries)}</div>{/if}
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        </div>
      </section>
    {/each}
  </div>

  {#if hospital.esgPanels?.length}
    <div class="esg-panels">
      {#each hospital.esgPanels as p}
        <section class="panel" class:cmp={p.cols?.length}>
          <h2 class="panel-h">{p.icon} {p.title}</h2>
          {#if p.cols?.length}
            <div class="panel-row panel-head"><span class="pl">{p.cols[0]}</span>{#each p.cols.slice(1) as c}<span class="pc">{c}</span>{/each}</div>
          {/if}
          <div class="panel-rows">
            {#each p.rows as r}
              <div class="panel-row" class:pend={r.pending}>
                <span class="pl">{r.label}</span>
                {#if r.cells?.length}{@const di = p.compare ? deltaInfo(r.cells) : null}{#each r.cells as c, i}<span class="pc">{c || '—'}{#if di && i === di.idx}<span class="delta" class:good={di.good === true} class:neutral={di.good === null}>{di.text}</span>{/if}</span>{/each}{:else}<span class="pv">{r.value}</span>{/if}
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .board-page {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: var(--space-sm) var(--space-md);
    gap: var(--space-sm);
    background: var(--color-paper);
    overflow: hidden;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    border-bottom: 2px solid var(--color-border);
    padding-bottom: var(--space-xs);
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .ttl { font-size: var(--text-lg); font-weight: 700; flex-shrink: 0; }
  .legend { display: flex; gap: 6px 8px; font-size: var(--text-xs); color: var(--color-text-secondary); align-items: center; flex-wrap: wrap; min-width: 0; }
  .legend span { display: flex; align-items: center; gap: 4px; }
  .legend i { width: 12px; height: 12px; border-radius: var(--radius-sm); display: inline-block; }
  .legend .ln { width: 18px; border-top: 2px solid; display: inline-block; }
  .legend .ln.dash { border-top-style: dashed; }
  .legend .sep { margin-left: var(--space-sm); }
  .toggle { margin-left: auto; display: flex; gap: var(--space-xs); }
  .toggle button {
    font-size: var(--text-sm); padding: 0.3rem 0.8rem; border-radius: var(--radius-sm);
    border: 2px solid var(--color-primary); background: var(--color-paper);
    color: var(--color-primary); cursor: pointer; min-height: 0;
  }
  .toggle button.active { background: var(--color-primary); color: var(--color-paper); }
  .mode-switch { margin-left: var(--space-sm); font-size: var(--text-sm); padding: 0.3rem 0.9rem; border-radius: var(--radius-sm); border: 2px solid var(--color-energy); background: var(--color-paper); color: var(--color-energy); cursor: pointer; min-height: 0; white-space: nowrap; }
  .mode-switch.live { background: var(--color-energy); color: var(--color-paper); }
  .pending-note { margin-top: auto; font-size: var(--text-xs); color: var(--color-text-secondary); font-style: italic; }
  .no-data { font-size: var(--text-xs); color: var(--color-text-secondary); font-style: italic; }
  .pend-sm { font-size: var(--text-sm); color: var(--color-text-secondary); }
  .export { position: relative; }
  .export-btn {
    font-size: var(--text-sm); padding: 0.3rem 0.8rem; border-radius: var(--radius-sm);
    border: 2px solid var(--color-accent); background: var(--color-paper); color: var(--color-accent); cursor: pointer; min-height: 0;
  }
  .export-menu {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 10;
    background: var(--color-paper); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md); display: flex; flex-direction: column; min-width: 170px;
  }
  .export-menu button {
    text-align: left; padding: 0.5rem 0.9rem; border: 0; background: none; cursor: pointer;
    font-size: var(--text-sm); color: var(--color-text); min-height: 0;
  }
  .export-menu button:hover { background: var(--color-primary-pale); }

  .board {
    flex: 1.6 1.6 0; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr;
    gap: var(--space-sm);
  }
  .esg-panels { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 2fr 1fr 1fr; gap: var(--space-sm); }
  /* split：上半資源橫列、下半左大區(SEU)＋右側小面板(碳盤查/社會/治理縱向) */
  .board-page.split { height: 100dvh; overflow: hidden; }
  .board-page.split .board { flex: 0 0 auto; grid-template-columns: repeat(3, 1fr); }
  .board-page.split .esg-panels { flex: 1 1 0; grid-template-columns: 1.7fr 1fr; grid-template-rows: repeat(3, 1fr); min-height: 0; }
  .board-page.split .esg-panels > :first-child { grid-row: 1 / -1; min-height: 0; overflow: auto; }
  .board-page.split .esg-panels > :not(:first-child) { min-height: 0; overflow: auto; }
  .panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-sm) var(--space-md); display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
  .panel-h { font-size: var(--text-base); font-weight: 700; margin-bottom: var(--space-xs); color: var(--color-text); border-bottom: 2px solid var(--color-border); padding-bottom: 4px; }
  .panel-rows { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; }
  .panel-row { display: flex; justify-content: space-between; gap: 10px; font-size: var(--text-sm); padding: 4px 0; border-bottom: 1px solid var(--color-border); }
  .panel-row:last-child { border-bottom: 0; }
  .panel-row .pl { color: var(--color-text-secondary); }
  .panel-row .pv { font-weight: 700; text-align: right; }
  .panel-row.pend .pv { color: var(--color-text-secondary); font-weight: 400; font-style: italic; }
  .panel.cmp .panel-row { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr; align-items: baseline; gap: 6px; }
  .panel-head { font-weight: 700; color: var(--color-text-secondary); border-bottom: 2px solid var(--color-border); }
  .pc { text-align: right; font-weight: 700; }
  .delta { font-size: var(--text-xs); margin-left: 4px; font-weight: 700; color: var(--color-alert); white-space: nowrap; }
  .delta.good { color: var(--color-accent); }
  .delta.neutral { color: var(--color-text-secondary); }
  .res {
    background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md);
    display: flex; flex-direction: column; overflow: hidden; min-height: 0;
  }
  .res-head {
    display: flex; align-items: center; gap: var(--space-sm);
    padding: var(--space-xs) var(--space-md); background: var(--color-primary-pale);
    border-bottom: 2px solid var(--color-border); flex-shrink: 0;
  }
  .res-name { font-size: var(--text-lg); font-weight: 700; white-space: nowrap; flex-shrink: 0; }
  .perfwrap { flex: 1; margin-left: var(--space-md); display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
  .pchart { flex: 1; min-width: 0; height: 42px; }
  .pchart :global(svg) { width: 100%; height: 100%; display: block; }
  .lbl { flex-shrink: 0; font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.3; text-align: right; }
  .lbl :global(b) { color: var(--color-text); font-size: var(--text-sm); }
  .endur { font-weight: 700; color: var(--color-energy); }

  .res-body { flex: 1; display: grid; grid-template-columns: 0.95fr 0.8fr 1.3fr; min-height: 0; }
  .seg { padding: var(--space-sm) var(--space-md); border-right: 1px dashed var(--color-border); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .seg:last-child { border-right: 0; }
  .seg-h { font-size: var(--text-xs); font-weight: 700; color: var(--color-primary); margin-bottom: var(--space-xs); flex-shrink: 0; }
  .seg-h small { color: var(--color-text-secondary); font-weight: 400; }

  .srow { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); padding: 3px 8px; border-left: 5px solid var(--color-border); margin-bottom: 2px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0; background: color-mix(in oklch, var(--color-accent) 12%, transparent); }
  .srow.off { background: var(--color-surface); color: var(--color-text-secondary); }
  .srow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow .vv { font-weight: 700; }
  .srow.off .nm, .srow.off .vv { color: var(--color-text-secondary); }
  .srow.sum { background: none; border-left-color: transparent; border-top: 2px solid var(--color-border); margin-top: 3px; padding-top: 5px; font-weight: 700; color: var(--color-primary); }
  .subhd { font-size: var(--text-xs); font-weight: 700; color: var(--color-text-secondary); margin: 5px 0 2px; }
  .drow { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--color-text-secondary); padding: 2px 0 2px 12px; }
  .drow.warn { color: var(--color-energy); font-weight: 700; }

  .tanks { flex: 1; display: flex; gap: var(--space-sm); align-items: stretch; padding: 4px 0 2px; min-height: 0; }
  .tank { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .tank .days { font-size: var(--text-base); font-weight: 700; color: var(--color-accent); line-height: 1; }
  .tank.warn .days { color: var(--color-energy); }
  .tank .days small { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .tank .col { flex: 1; width: 100%; max-width: 52px; background: var(--color-paper); border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; display: flex; flex-direction: column-reverse; margin: 4px 0; position: relative; }
  .tank .col i { display: block; width: 100%; background: var(--color-primary); }
  .tank.warn .col i { background: var(--color-energy); }
  .tank .col .pct { position: absolute; top: 4px; left: 0; right: 0; text-align: center; font-size: var(--text-xs); font-weight: 700; color: var(--color-text); }
  .tank .nm { font-size: var(--text-xs); font-weight: 700; color: var(--color-text-secondary); text-align: center; }
  .tank .cap { font-size: var(--text-xs); color: var(--color-text-secondary); text-align: center; line-height: 1.2; }

  .use-big { font-size: var(--text-base); font-weight: 700; flex-shrink: 0; }
  .use-bsub { font-size: var(--text-xs); color: var(--color-text-secondary); margin-bottom: 4px; flex-shrink: 0; }
  .use-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 6px; min-height: 0; }
  .ublock { background: var(--color-paper); border-radius: var(--radius-sm); padding: 5px 9px; border-top: 3px solid var(--color-border); display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
  .ublock .top { display: flex; justify-content: space-between; align-items: baseline; }
  .ublock .bn { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .ublock .bp { font-size: var(--text-xs); font-weight: 700; color: var(--color-text-secondary); }
  .ublock .bv { font-size: var(--text-base); font-weight: 700; line-height: 1.05; }
  .ublock .chartbox { flex: 1; min-height: 24px; margin-top: 3px; }
  .ublock .chartbox :global(svg) { width: 100%; height: 100%; display: block; }
  .statb .stwrap { margin-top: auto; }
  .stbar { display: flex; height: 18px; border-radius: var(--radius-sm); overflow: hidden; margin: 4px 0 0; border: 1px solid var(--color-border); }
  .stbar i { display: block; height: 100%; }
  .stnote { display: flex; flex-wrap: wrap; gap: 9px; font-size: var(--text-xs); color: var(--color-text-secondary); margin-top: 4px; }
  .stnote b { font-weight: 700; color: var(--color-text); }

  /* 圖表線條（顏色用 token、拉伸不變形） */
  :global(.ln-warn) { stroke: var(--color-alert); stroke-width: 1.4; stroke-dasharray: 3 2; opacity: 0.8; vector-effect: non-scaling-stroke; }
  :global(.ln-base) { stroke: var(--color-text-secondary); stroke-width: 1.4; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
  :global(.ln-now) { stroke: var(--color-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
  :global(.ln-act) { fill: none; stroke: var(--color-primary); stroke-width: 2.4; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  :global(.ln-fc) { fill: none; stroke: var(--color-chart-5); stroke-width: 2; stroke-dasharray: 4 3; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  :global(.dot-act) { fill: var(--color-primary); }

  @media (max-width: 900px) {
    .board { grid-template-columns: 1fr; grid-template-rows: none; overflow-y: auto; }
    .board-page { height: auto; min-height: 100dvh; overflow: visible; }
    .res { min-height: 60vh; }
  }
</style>
