<script lang="ts">
  // 削峰填谷 / 需量控制 即時圖（D3 scale/shape 產生 path，Svelte 渲染 SVG；不用 d3-selection 操作 DOM）。
  // 資料＝peakShaveDemo 假資料（展示，● 標示）；未來接橋接 API 只換資料來源。
  import { scaleLinear } from 'd3-scale';
  import { area, line, curveMonotoneX } from 'd3-shape';
  import { buildPeakShave, TARIFF, PEAK_SHAVE_DEMO, type PeakShaveData, type HourPoint } from '@utils/peakShaveDemo';

  // client 時鐘：nowHour 走真實時間；phase 每 5s 微幅推進做「即時」呼吸感（界限夾制在資料層）
  let nowH = $state(PEAK_SHAVE_DEMO.nowHour);
  let phase = $state(0);
  $effect(() => {
    const tick = () => { const d = new Date(); nowH = d.getHours() + d.getMinutes() / 60; phase += 0.4; };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  });
  const data: PeakShaveData = $derived(buildPeakShave(nowH, phase));

  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  const tone = (k: string) => `var(--color-${k})`;

  // 幾何
  const W = 1000, H = 300, padL = 48, padR = 46, padT = 14, padB = 30;
  const pts = $derived<HourPoint[]>([...data.hours, { ...data.hours[23], h: 24 }]);
  const maxP = $derived(Math.max(...pts.map((p) => Math.max(p.load, p.grid + p.pv + p.discharge))) * 1.12);
  const x = $derived(scaleLinear().domain([0, 24]).range([padL, W - padR]));
  const yP = $derived(scaleLinear().domain([0, maxP]).range([H - padB, padT]));
  const yS = scaleLinear().domain([0, 100]).range([H - padB, padT]);

  const aGrid = $derived(area<HourPoint>().x((p) => x(p.h)).y0(yP(0)).y1((p) => yP(p.grid)).curve(curveMonotoneX)(pts) ?? '');
  const aPv = $derived(area<HourPoint>().x((p) => x(p.h)).y0((p) => yP(p.grid)).y1((p) => yP(p.grid + p.pv)).curve(curveMonotoneX)(pts) ?? '');
  const aDis = $derived(area<HourPoint>().x((p) => x(p.h)).y0((p) => yP(p.grid + p.pv)).y1((p) => yP(p.grid + p.pv + p.discharge)).curve(curveMonotoneX)(pts) ?? '');
  const lLoad = $derived(line<HourPoint>().x((p) => x(p.h)).y((p) => yP(p.load)).curve(curveMonotoneX)(pts) ?? '');
  const lSoc = $derived(line<HourPoint>().x((p) => x(p.h)).y((p) => yS(p.soc)).curve(curveMonotoneX)(pts) ?? '');

  const BANDS = [
    { b: 'off' as const, s: 0, e: 9 },
    { b: 'mid' as const, s: 9, e: 16 },
    { b: 'peak' as const, s: 16, e: 22 },
    { b: 'mid' as const, s: 22, e: 24 },
  ];
  const xticks = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  const pticks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((maxP * f) / 50) * 50));
  const sticks = [0, 25, 50, 75, 100];

  const kpis = $derived([
    { k: '今日綠電', v: fmt(data.kpi.pvKwh), u: 'kWh', tone: 'accent', hint: 'PV 規劃中' },
    { k: '台電購電', v: fmt(data.kpi.gridKwh), u: 'kWh', tone: 'text-secondary', hint: '今日累計' },
    { k: '離峰充電', v: fmt(data.kpi.chargeKwh), u: 'kWh', tone: 'chart-4', hint: '00–09' },
    { k: '尖峰放電', v: fmt(data.kpi.dischargeKwh), u: 'kWh', tone: 'alert', hint: '16–22' },
    { k: '今日省電費', v: '$' + fmt(data.kpi.saveNtd), u: '', tone: 'primary', hint: '削峰套利＋綠電折抵' },
  ]);
</script>

<section class="ps block" style="border-color:{tone('chart-4')}">
  <header class="bhead">
    <span class="bname">📉 削峰填谷 · 需量控制</span>
    <span class="src">● 展示資料</span>
    <span class="bperf">離峰充電（00–09）· 尖峰放電（16–22）· 依台電夏月三段式時間電價套利</span>
  </header>

  <div class="ps-body">
    <!-- KPI 磁磚 -->
    <div class="kpis">
      {#each kpis as t}
        <div class="kpi" style="border-top-color:{tone(t.tone)}">
          <span class="kk">{t.k}</span>
          <span class="kv" style="color:{tone(t.tone)}">{t.v}{#if t.u}<em>{t.u}</em>{/if}</span>
          <span class="kh">{t.hint}</span>
        </div>
      {/each}
    </div>

    <!-- 24h D3 即時圖 -->
    <div class="chart">
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="削峰填谷 24 小時即時圖">
        <!-- TOU 電價色帶背景 -->
        {#each BANDS as bd}
          <rect x={x(bd.s)} y={padT} width={x(bd.e) - x(bd.s)} height={H - padB - padT}
                fill="color-mix(in oklch, {tone(TARIFF[bd.b].tone)} 9%, transparent)" />
        {/each}
        <!-- y 格線（kW） -->
        {#each pticks as t}
          <line x1={padL} x2={W - padR} y1={yP(t)} y2={yP(t)} class="grid" />
          <text x={padL - 6} y={yP(t)} class="ytxt" text-anchor="end" dominant-baseline="middle">{fmt(t)}</text>
        {/each}
        <!-- 堆疊面積：購電 → +PV → +放電（頂到負載線；尖峰時放電把購電往下壓＝削峰） -->
        <path d={aGrid} fill="color-mix(in oklch, var(--color-text-secondary) 30%, var(--color-paper))" />
        <path d={aPv} fill="color-mix(in srgb, var(--color-accent) 48%, var(--color-paper))" />
        <path d={aDis} fill="color-mix(in srgb, var(--color-chart-4) 55%, var(--color-paper))" />
        <!-- 負載線 -->
        <path d={lLoad} class="load" />
        <!-- SOC 線（右軸，虛線） -->
        <path d={lSoc} class="soc" />
        {#each sticks as t}
          <text x={W - padR + 6} y={yS(t)} class="ytxt soc" text-anchor="start" dominant-baseline="middle">{t}%</text>
        {/each}
        <!-- x 軸刻度 + 時段標籤 -->
        {#each xticks as t}
          <text x={x(t)} y={H - padB + 16} class="xtxt" text-anchor="middle">{t}</text>
        {/each}
        {#each BANDS as bd}
          <text x={(x(bd.s) + x(bd.e)) / 2} y={padT + 12} class="bandlbl" text-anchor="middle" fill={tone(TARIFF[bd.b].tone)}>{TARIFF[bd.b].label} ${TARIFF[bd.b].price}</text>
        {/each}
        <!-- now 標記 -->
        <line x1={x(data.nowHour)} x2={x(data.nowHour)} y1={padT} y2={H - padB} class="now" />
        <text x={x(data.nowHour)} y={H - padB + 16} class="nowtxt" text-anchor="middle">now</text>
      </svg>
      <!-- 圖例 -->
      <div class="legend">
        <span><i class="sw load"></i>負載</span>
        <span><i class="sw grid"></i>台電購電</span>
        <span><i class="sw pv"></i>太陽能</span>
        <span><i class="sw dis"></i>儲電櫃放電</span>
        <span><i class="sw soc"></i>SOC</span>
      </div>
    </div>
  </div>
</section>

<style>
  .block { display: flex; flex-direction: column; border: 3px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; min-height: 0; }
  .bhead { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .bname { font-size: var(--text-lg); font-weight: 700; white-space: nowrap; }
  .src { font-size: var(--text-xs); font-weight: 700; color: var(--color-energy); white-space: nowrap; }
  .bperf { font-size: var(--text-xs); color: var(--color-text-secondary); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .ps-body { flex: 1; display: flex; gap: var(--space-sm); padding: var(--space-xs) var(--space-sm); min-height: 0; }
  /* 左：KPI 直排；右：圖 */
  .kpis { display: flex; flex-direction: column; gap: 6px; flex: 0 0 clamp(120px, 15%, 190px); min-height: 0; }
  .kpi { display: flex; flex-direction: column; background: var(--color-paper); border: 1px solid var(--color-border); border-top: 3px solid var(--color-chart-1); border-radius: var(--radius-sm); padding: 3px 8px; }
  .kpi .kk { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .kpi .kv { font-size: var(--text-lg); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .kpi .kv em { font-size: var(--text-xs); font-style: normal; font-weight: 400; color: var(--color-text-secondary); margin-left: 3px; }
  .kpi .kh { font-size: var(--text-xs); color: var(--color-text-secondary); }

  .chart { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .chart svg { flex: 1; width: 100%; min-height: 0; display: block; }
  .grid { stroke: color-mix(in oklch, var(--color-border) 60%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .load { fill: none; stroke: var(--color-text); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .soc { fill: none; stroke: var(--color-primary); stroke-width: 1.5; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
  .now { stroke: var(--color-alert); stroke-width: 1.5; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .ytxt { font-size: 15px; fill: var(--color-text-secondary); }
  .ytxt.soc { fill: var(--color-primary); }
  .xtxt { font-size: 15px; fill: var(--color-text-secondary); }
  .bandlbl { font-size: 14px; font-weight: 700; opacity: 0.85; }
  .nowtxt { font-size: 14px; font-weight: 700; fill: var(--color-alert); }

  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 2px 4px 0; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend .sw { width: 12px; height: 10px; border-radius: 2px; display: inline-block; }
  .legend .sw.load { height: 0; border-top: 2px solid var(--color-text); border-radius: 0; }
  .legend .sw.grid { background: color-mix(in oklch, var(--color-text-secondary) 30%, var(--color-paper)); }
  .legend .sw.pv { background: color-mix(in srgb, var(--color-accent) 48%, var(--color-paper)); }
  .legend .sw.dis { background: color-mix(in srgb, var(--color-chart-4) 55%, var(--color-paper)); }
  .legend .sw.soc { height: 0; border-top: 2px dashed var(--color-primary); border-radius: 0; }
</style>
