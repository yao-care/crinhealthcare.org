<script lang="ts">
  // 救災電力異常（全螢幕一頁）：1 台行動儲電櫃 → 依需求推往多個據點。
  // 上：事件時間軸；左：各據點卡（亮起＝櫃子現在推到這裡）；右：同一台櫃子在各據點能撐多久的比較。
  // 單一計算源：各據點負載／負載率／續航一律由 sites[].loads（台數×瓦數）推導，JSON 不存彙總值。
  import { carousel } from '@utils/carousel';
  import { reliefSiteSummary, reliefUsableKwh, endurText, barFills, type ReliefSite, type ReliefCabinet } from '@utils/ems';
  interface Relief { title?: string; sub?: string; cabinet: ReliefCabinet; steps?: { label: string; sub?: string; dest?: boolean }[]; sites: ReliefSite[]; rotateSec?: number; }

  let { relief, onBoard }: { relief: Relief; onBoard: () => void } = $props();

  const cab = $derived(relief.cabinet);
  const usableKwh = $derived(reliefUsableKwh(cab));
  const sites = $derived(relief.sites.map((s) => ({ ...s, sum: reliefSiteSummary(s, cab) })));
  const kw2 = (w: number) => (w / 1000).toFixed(2);

  // 1 台櫃子一次只能供一處：active 那張亮起＝供電中，其餘淡化＝未供電（數字是「若改推過來」的試算）。
  // 現在櫃子推到哪：kiosk 無人操作時依 rotateSec 輪播；有人點選後暫停輪播 HOLD_MS 再接續
  const HOLD_MS = 60000;
  let active = $state(0);
  let holdUntil = 0;
  $effect(() => {
    const n = relief.sites.length;
    const ms = (relief.rotateSec ?? 12) * 1000;
    if (n < 2 || !ms) return;
    const id = window.setInterval(() => {
      if (Date.now() < holdUntil) return;
      active = (active + 1) % n;
    }, ms);
    return () => clearInterval(id);
  });
  function pick(i: number) {
    active = i;
    holdUntil = Date.now() + HOLD_MS;
  }

  const cur = $derived(sites[active] ?? sites[0]);
  // 比較長條：共用同一把尺（刻度取 6 小時的倍數，最久者不頂滿）
  const maxH = $derived(Math.max(...sites.map((s) => s.sum.hours), 1));
  const axisH = $derived(Math.ceil((maxH * 1.08) / 6) * 6);
  const ticks = $derived(Array.from({ length: axisH / 6 + 1 }, (_, i) => i * 6));
  // 卡片內設備長條：三張卡共用同一把尺，跨卡也比得出哪項吃電
  const maxPartW = $derived(Math.max(...relief.sites.flatMap((s) => s.loads.map((l) => l.qty * l.w)), 1));
</script>

<div class="relief">
  <div class="rh">
    <span class="rt">{relief.title}</span>
    {#if relief.sub}<span class="rs">{relief.sub}</span>{/if}
    <button type="button" class="toboard" onclick={onBoard}>📊 水·油·氣·環境</button>
  </div>

  {#if relief.steps?.length}
    <!-- 事件時間軸：dest 那一步帶出「現在推到哪」 -->
    <ol class="steps">
      {#each relief.steps as st, i}
        <li class="step" class:last={i === relief.steps.length - 1}>
          <b class="sn">{i + 1}</b>
          <span class="sl">{st.label}</span>
          {#if st.dest && cur}<span class="ss">→ {cur.icon} {cur.name}</span>{:else if st.sub}<span class="ss">{st.sub}</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}

  <div class="rbody">
    <div class="sites">
      {#each sites as s, i}
        {@const fills = barFills(s.loads.map((l) => l.qty * l.w))}
        <button type="button" class="site" class:on={i === active} onclick={() => pick(i)} aria-pressed={i === active}>
          <div class="sh">
            <span class="sname">{s.icon} {s.name}</span>
            {#if i === active}<span class="pill live">🔋 供電中</span>{:else}<span class="pill">未供電</span>{/if}
          </div>
          {#if s.role}<div class="srole">{s.role}</div>{/if}
          <div class="sbig">
            <span class="cap">{i === active ? '可撐' : '若改推過來可撐'}</span>
            <b>{endurText(s.sum.hours)}</b>
          </div>
          <div class="skw">負載 <b>{s.sum.kw.toFixed(2)} kW</b> · 負載率 {s.sum.loadPct.toFixed(1)}%</div>
          <div class="lh"><span>關鍵設備</span><span class="lhk">用電</span></div>
          <div class="loads" use:carousel>
            {#each s.loads as l, j}
              {@const w = l.qty * l.w}
              <div class="lrow">
                <div class="ltop"><span class="ln">{l.n} <small>×{l.qty}</small></span><span class="lk">{kw2(w)} kW</span></div>
                <div class="lbar"><i style="width:{(w / maxPartW) * 100}%; background:{fills[j]}"></i></div>
              </div>
            {/each}
          </div>
        </button>
      {/each}
    </div>

    <aside class="side">
      <div class="cab">
        <div class="ch">🔋 {cab.name} <small>×1</small></div>
        <div class="cgrid">
          <div><span>目前電量</span><b>{cab.socPct ?? 100}%</b></div>
          <div><span>可放電（保留 {cab.floorPct ?? 0}%）</span><b>{usableKwh.toFixed(1)} kWh</b></div>
          <div><span>容量</span><b>{cab.kwh} kWh</b></div>
          <div><span>額定輸出</span><b>{cab.kw} kW</b></div>
        </div>
      </div>

      <!-- 同一台櫃子推到各據點能撐多久：共用同一把尺，調度決策一眼看 -->
      <div class="cmp">
        <div class="mh">推到哪裡 · 撐多久 <small>一次只供一處</small></div>
        {#each sites as s, i}
          <button type="button" class="crow" class:on={i === active} onclick={() => pick(i)}>
            <div class="ctop"><span>{s.icon} {s.name}</span><b>{endurText(s.sum.hours)}</b></div>
            <div class="cbar"><i style="width:{(s.sum.hours / axisH) * 100}%"></i></div>
          </button>
        {/each}
        <div class="cticks">{#each ticks as t}<span>{t}h</span>{/each}</div>
      </div>

      {#if cur}
        <div class="now">
          <div class="mh">現在供電 · {cur.icon} {cur.name}</div>
          <div class="grow"><span>目前負載</span><b>{cur.sum.kw.toFixed(2)} kW</b></div>
          <div class="grow"><span>可再承接</span><b>{cur.sum.marginKw.toFixed(1)} kW</b></div>
          <div class="grow big"><span>依現況可用</span><b>{endurText(cur.sum.hours)}</b></div>
        </div>
      {/if}
    </aside>
  </div>
</div>

<style>
  .relief { flex: 1; display: flex; flex-direction: column; gap: var(--space-sm); min-height: 0; padding: var(--space-xs) var(--space-sm) var(--space-sm); }
  .rh { display: flex; align-items: baseline; gap: var(--space-sm); flex-wrap: wrap; }
  .rt { font-size: var(--text-lg); font-weight: 700; color: var(--color-alert); }
  .rs { font-size: var(--text-sm); color: var(--color-text-secondary); }
  .toboard { margin-left: auto; font-size: var(--text-xs); font-weight: 700; padding: 2px 10px; border-radius: var(--radius-sm); border: 1px solid var(--color-primary); background: var(--color-paper); color: var(--color-primary); cursor: pointer; }

  /* 事件時間軸：四段箭頭，最後一段（供電中）用綠收尾 */
  .steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 4px; flex-shrink: 0; }
  .step { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 6px 14px 6px 22px; background: color-mix(in oklab, var(--color-alert) 14%, var(--color-paper)); border: 2px solid var(--color-alert); border-radius: var(--radius-sm); clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%); }
  .step:first-child { clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%); padding-left: 12px; }
  .step.last { background: color-mix(in oklab, var(--color-accent) 22%, var(--color-paper)); border-color: var(--color-accent); }
  .sn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 1.6em; height: 1.6em; border-radius: 50%; background: var(--color-alert); color: var(--color-paper); font-size: var(--text-xs); }
  .step.last .sn { background: var(--color-accent); }
  .sl { font-size: var(--text-base); font-weight: 700; white-space: nowrap; }
  .ss { font-size: var(--text-xs); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }

  .rbody { flex: 1; display: flex; gap: var(--space-sm); min-height: 0; }
  .sites { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-sm); min-height: 0; min-width: 0; }

  /* 據點卡：亮起＝櫃子現在推到這裡 */
  .site { all: unset; box-sizing: border-box; cursor: pointer; display: flex; flex-direction: column; gap: 4px; min-height: 0; min-width: 0; padding: var(--space-sm); border: 2px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); transition: border-color 0.3s, background 0.3s, box-shadow 0.3s; }
  .site.on { border: 3px solid var(--color-accent); background: color-mix(in oklab, var(--color-accent) 8%, var(--color-paper)); box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-accent) 25%, transparent); }
  .site:not(.on) { opacity: 0.5; }
  .site:not(.on) .sbig b { font-size: var(--text-xl); color: var(--color-text-secondary); }
  .site:focus-visible { outline: 3px solid var(--color-primary); outline-offset: 2px; }
  .sh { display: flex; align-items: center; gap: 6px; }
  .sname { flex: 1; min-width: 0; font-size: var(--text-lg); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill { flex: none; font-size: var(--text-xs); font-weight: 700; padding: 0 8px; border-radius: var(--radius-sm); border: 1px solid var(--color-border); color: var(--color-text-secondary); background: var(--color-paper); }
  .pill.live { color: var(--color-paper); background: var(--color-accent); border-color: var(--color-accent); }
  .srole { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .sbig { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 10px; padding: 4px 0; border-top: 1px dashed var(--color-border); border-bottom: 1px dashed var(--color-border); }
  .sbig .cap { font-size: var(--text-sm); font-weight: 700; color: var(--color-text-secondary); }
  .sbig b { font-size: var(--text-3xl); line-height: 1.05; font-weight: 800; color: var(--color-text); }
  .site.on .sbig b { color: var(--color-accent); }
  .skw { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .skw b { color: var(--color-text); }

  .lh { display: flex; gap: 6px; font-size: var(--text-xs); color: var(--color-text-secondary); background: var(--color-paper); padding: 1px 4px; border-radius: var(--radius-sm); }
  .lh span:first-child { flex: 1; }
  .lhk { width: 5em; text-align: right; }
  /* 有界＋輪播：放得下不動、放不下才每 5 秒換頁 */
  .loads { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 6px; }
  .lrow { border-bottom: 1px solid var(--color-border); padding-bottom: 2px; }
  .ltop { display: flex; align-items: baseline; gap: 6px; }
  .ln { flex: 1; min-width: 0; font-size: var(--text-sm); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ln small { font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }
  .lk { width: 5em; text-align: right; font-size: var(--text-sm); font-weight: 700; white-space: nowrap; }
  .lbar { height: 12px; margin-top: 2px; background: var(--color-paper); border-radius: var(--radius-sm); overflow: hidden; }
  .lbar i { display: block; height: 100%; border-radius: var(--radius-sm); }

  /* ── 右欄 ── */
  .side { width: clamp(240px, 27%, 500px); display: flex; flex-direction: column; gap: var(--space-sm); min-height: 0; border: 2px solid var(--color-accent); border-radius: var(--radius-md); padding: var(--space-sm); background: var(--color-paper); }
  .ch { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); }
  .ch small { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .cgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 4px; }
  .cgrid div { display: flex; flex-direction: column; padding: 2px 8px; background: var(--color-surface); border-radius: var(--radius-sm); }
  .cgrid span { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .cgrid b { font-size: var(--text-base); font-weight: 700; }
  .mh { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); margin-bottom: 2px; }
  .mh small { font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); margin-left: 6px; }
  .cmp { border-top: 1px dashed var(--color-border); padding-top: var(--space-xs); }
  .crow { all: unset; box-sizing: border-box; display: block; width: 100%; cursor: pointer; padding: 6px 6px; margin-bottom: 4px; border-radius: var(--radius-sm); }
  .crow.on { background: color-mix(in oklab, var(--color-accent) 12%, var(--color-paper)); }
  .crow:focus-visible { outline: 3px solid var(--color-primary); }
  .ctop { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-base); font-weight: 700; }
  .cbar { height: 26px; margin-top: 2px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
  .cbar i { display: block; height: 100%; background: var(--color-text-secondary); transition: background 0.3s; }
  .crow.on .cbar i { background: var(--color-accent); }
  .cticks { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--color-text-secondary); padding: 0 4px; }
  .now { margin-top: auto; border-top: 1px dashed var(--color-border); padding-top: var(--space-xs); }
  .grow { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-base); }
  .grow span { color: var(--color-text-secondary); }
  .grow.big b { font-size: var(--text-2xl); color: var(--color-alert); }

  @media (prefers-reduced-motion: reduce) {
    .site, .cbar i { transition: none; }
  }

  /* 判準是畫布寬（外層 .fit 的 container: board）不是視窗寬 */
  @container board (width < 900px) {
    .steps { flex-direction: column; }
    .step, .step:first-child { clip-path: none; padding-left: 12px; }
    .rbody { flex-direction: column; }
    .sites { grid-template-columns: minmax(0, 1fr); }
    .loads { overflow: visible; }
    .side { width: auto; }
  }
</style>
