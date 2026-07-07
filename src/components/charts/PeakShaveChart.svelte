<script lang="ts">
  // 削峰填谷 / 需量控制 即時圖（嵌入「使用端」下半；D3 scale/shape 產生 path，Svelte 渲染 SVG）。
  // 資料＝peakShaveDemo 假資料（展示，● 標示）；未來接橋接 API 只換資料來源。
  import { scaleLinear } from 'd3-scale';
  import { area, line, curveMonotoneX } from 'd3-shape';
  import { buildPeakShave, TARIFF, PEAK_SHAVE_DEMO, type PeakShaveData, type HourPoint } from '@utils/peakShaveDemo';

  // client 時鐘：nowHour 走真實時間；phase 每 5s 微幅推進做「即時」呼吸感（界限夾制在資料層）
  let nowH = $state(PEAK_SHAVE_DEMO.nowHour);
  let phase = $state(0);
  $effect(() => {
    // 只在 setup 時同步「寫」nowH（不讀任何被追蹤的 state，避免 effect 自我重觸發＝無限迴圈）；
    // phase 的累加只在非同步 interval callback 內發生，不列入 effect 相依。
    const d0 = new Date();
    nowH = d0.getHours() + d0.getMinutes() / 60;
    const id = setInterval(() => {
      const d = new Date();
      nowH = d.getHours() + d.getMinutes() / 60;
      phase += 0.4;
    }, 5000);
    return () => clearInterval(id);
  });
  const data: PeakShaveData = $derived(buildPeakShave(nowH, phase));

  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  const tone = (k: string) => `var(--color-${k})`;

  // 幾何
  const W = 1000, H = 300, padL = 46, padR = 44, padT = 20, padB = 26;
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
  const pticks = $derived([0, 0.5, 1].map((f) => Math.round((maxP * f) / 50) * 50));
  const sticks = [0, 50, 100];

  const kpis = $derived([
    { k: '今日綠電', v: fmt(data.kpi.pvKwh), u: 'kWh', tone: 'accent' },
    { k: '台電購電', v: fmt(data.kpi.gridKwh), u: 'kWh', tone: 'text-secondary' },
    { k: '離峰充電', v: fmt(data.kpi.chargeKwh), u: 'kWh', tone: 'chart-4' },
    { k: '尖峰放電', v: fmt(data.kpi.dischargeKwh), u: 'kWh', tone: 'alert' },
    { k: '今日省電費', v: '$' + fmt(data.kpi.saveNtd), u: '', tone: 'primary' },
  ]);
</script>

<div class="ps-embed">
  <div class="ps-h">
    <span class="ps-title">📉 削峰填谷 · 需量控制</span>
    <span class="ps-src">● 展示資料</span>
    <span class="ps-hint">離峰充(00–09) · 尖峰放(16–22) · 台電夏月三段式</span>
  </div>

  <!-- KPI 橫排 chips（前置小標頭） -->
  <div class="ps-kpis">
    <span class="kpis-h">今日累計</span>
    {#each kpis as t}
      <div class="kchip" style="border-left-color:{tone(t.tone)}">
        <span class="kk">{t.k}</span>
        <b class="kv" style="color:{tone(t.tone)}">{t.v}{#if t.u}<em>{t.u}</em>{/if}</b>
      </div>
    {/each}
  </div>

  <!-- 24h D3 即時圖 -->
  <div class="chart">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="削峰填谷 24 小時即時圖">
      {#each BANDS as bd}
        <rect x={x(bd.s)} y={padT} width={x(bd.e) - x(bd.s)} height={H - padB - padT}
              fill="color-mix(in srgb, {tone(TARIFF[bd.b].tone)} 9%, transparent)" />
      {/each}
      {#each pticks as t}
        <line x1={padL} x2={W - padR} y1={yP(t)} y2={yP(t)} class="grid" />
        <text x={padL - 5} y={yP(t)} class="ytxt" text-anchor="end" dominant-baseline="middle">{fmt(t)}</text>
      {/each}
      <!-- 堆疊：購電 → +PV → +放電（頂到負載線；尖峰放電把購電往下壓＝削峰） -->
      <path d={aGrid} fill="color-mix(in srgb, var(--color-text-secondary) 30%, var(--color-paper))" />
      <path d={aPv} fill="color-mix(in srgb, var(--color-accent) 48%, var(--color-paper))" />
      <path d={aDis} fill="color-mix(in srgb, var(--color-chart-4) 55%, var(--color-paper))" />
      <path d={lLoad} class="load" />
      <path d={lSoc} class="soc" />
      {#each sticks as t}
        <text x={W - padR + 5} y={yS(t)} class="ytxt soc" text-anchor="start" dominant-baseline="middle">{t}%</text>
      {/each}
      {#each xticks as t}
        <text x={x(t)} y={H - padB + 15} class="xtxt" text-anchor="middle">{t}</text>
      {/each}
      {#each BANDS as bd}
        <text x={(x(bd.s) + x(bd.e)) / 2} y={3} class="bandlbl" text-anchor="middle" dominant-baseline="hanging" fill={tone(TARIFF[bd.b].tone)}>{TARIFF[bd.b].label} ${TARIFF[bd.b].price}</text>
      {/each}
      <line x1={x(data.nowHour)} x2={x(data.nowHour)} y1={padT} y2={H - padB} class="now" />
      <text x={x(data.nowHour)} y={H - padB + 15} class="nowtxt" text-anchor="middle">現在</text>
    </svg>
    <div class="legend">
      <span><i class="sw load"></i>負載</span>
      <span><i class="sw grid"></i>台電購電</span>
      <span><i class="sw pv"></i>太陽能</span>
      <span><i class="sw dis"></i>儲電櫃放電</span>
      <span><i class="sw soc"></i>電池電量</span>
    </div>
  </div>
</div>

<style>
  .ps-embed { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .ps-h { display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; }
  .ps-title { font-size: var(--text-sm); font-weight: 700; color: var(--color-primary); white-space: nowrap; }
  .ps-src { font-size: var(--text-xs); font-weight: 700; color: var(--color-energy); white-space: nowrap; }
  .ps-hint { font-size: var(--text-xs); color: var(--color-text-secondary); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .ps-kpis { display: flex; flex-wrap: wrap; align-items: stretch; gap: 4px 6px; padding: 4px 0 2px; flex-shrink: 0; }
  /* KPI 小標頭：與 chips 同排、右側細分隔線，標明這排是今日累計數 */
  .kpis-h { display: flex; align-items: center; font-size: var(--text-xs); font-weight: 700; color: var(--color-text-secondary); padding-right: 7px; border-right: 1px solid var(--color-border); white-space: nowrap; }
  .kchip { display: flex; flex-direction: column; line-height: 1.1; background: var(--color-paper); border: 1px solid var(--color-border); border-left: 3px solid var(--color-chart-1); border-radius: var(--radius-sm); padding: 2px 7px; }
  .kchip .kk { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .kchip .kv { font-size: var(--text-sm); font-weight: 700; font-variant-numeric: tabular-nums; }
  .kchip .kv em { font-size: var(--text-xs); font-style: normal; font-weight: 400; color: var(--color-text-secondary); margin-left: 2px; }

  .chart { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .chart svg { flex: 1; width: 100%; min-height: 0; display: block; }
  .grid { stroke: color-mix(in srgb, var(--color-border) 60%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .load { fill: none; stroke: var(--color-text); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .soc { fill: none; stroke: var(--color-primary); stroke-width: 1.5; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
  .now { stroke: var(--color-alert); stroke-width: 1.5; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .ytxt { font-size: 16px; fill: var(--color-text-secondary); }
  .ytxt.soc { fill: var(--color-primary); }
  .xtxt { font-size: 16px; fill: var(--color-text-secondary); }
  /* 電價帶標籤：放大＋白色描邊光暈，壓在 SOC 虛線/圖上也清楚可讀 */
  .bandlbl { font-size: 21px; font-weight: 700; paint-order: stroke; stroke: var(--color-paper); stroke-width: 3.5px; stroke-linejoin: round; }
  .nowtxt { font-size: 15px; font-weight: 700; fill: var(--color-alert); }

  .legend { display: flex; flex-wrap: wrap; gap: 3px 12px; padding-top: 2px; font-size: var(--text-xs); color: var(--color-text-secondary); flex-shrink: 0; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend .sw { width: 12px; height: 9px; border-radius: 2px; display: inline-block; }
  .legend .sw.load { height: 0; border-top: 2px solid var(--color-text); border-radius: 0; }
  .legend .sw.grid { background: color-mix(in srgb, var(--color-text-secondary) 30%, var(--color-paper)); }
  .legend .sw.pv { background: color-mix(in srgb, var(--color-accent) 48%, var(--color-paper)); }
  .legend .sw.dis { background: color-mix(in srgb, var(--color-chart-4) 55%, var(--color-paper)); }
  .legend .sw.soc { height: 0; border-top: 2px dashed var(--color-primary); border-radius: 0; }
</style>
