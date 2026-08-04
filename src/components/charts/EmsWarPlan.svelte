<script lang="ts">
  // 戰時 B1 開設配置圖（全螢幕一頁）＋ 行動儲電櫃供電。
  // 幾何全部來自 JSON（zones 以畫布百分比定位、斜帶用 rot 旋轉），元件只負責畫與算。
  // 單一計算源：總負載／各區用電／負載率／裕度／續航 一律由 power.loads[].parts 推導，JSON 不存彙總值。
  interface Zone { id: string; label: string; kind: string; x: number; y: number; w: number; h: number; rot?: number; sub?: string; star?: boolean; }
  interface Legend { label: string; kind: string; }
  interface Plan { title?: string; sub?: string; zones: Zone[]; legend?: Legend[]; }
  interface Part { zone?: string; n?: string; qty: number; w: number; }
  interface Load { name: string; parts: Part[] }
  interface Cabinet { name: string; kwh: number; kw: number; out?: string; loc?: string; state?: string; }
  interface Power { title?: string; note?: string; usablePct?: number; cabinets: Cabinet[]; loads: Load[]; }

  let { plan, power, onBoard }: { plan: Plan; power?: Power; onBoard: () => void } = $props();

  const loads = $derived(power?.loads ?? []);
  const cabs = $derived(power?.cabinets ?? []);
  const partW = (p: Part) => p.qty * p.w;
  const loadW = (l: Load) => l.parts.reduce((s, p) => s + partW(p), 0);

  const totalW = $derived(loads.reduce((s, l) => s + loadW(l), 0));
  const zoneW = $derived.by(() => {
    const m = new Map<string, number>();
    for (const l of loads) for (const p of l.parts) if (p.zone) m.set(p.zone, (m.get(p.zone) ?? 0) + partW(p));
    return m;
  });
  const capKw = $derived(cabs.reduce((s, c) => s + c.kw, 0));
  const capKwh = $derived(cabs.reduce((s, c) => s + c.kwh, 0));
  const usableKwh = $derived((capKwh * (power?.usablePct ?? 100)) / 100);
  const totalKw = $derived(totalW / 1000);
  const marginKw = $derived(capKw - totalKw);
  const loadPct = $derived(capKw ? (totalKw / capKw) * 100 : 0);
  const hours = $derived(totalKw ? usableKwh / totalKw : 0);

  const kw1 = (w: number) => (w / 1000).toFixed(2);
  const qtySum = (l: Load) => l.parts.reduce((s, p) => s + p.qty, 0);
  // 各區用電：同一份 parts 依 zone 加總，與圖上的徽章同源（不會對不起來）
  const zoneRows = $derived(
    [...zoneW.entries()]
      .map(([id, w]) => ({ label: plan.zones.find((z) => z.id === id)?.label ?? id, w }))
      .sort((a, b) => b.w - a.w),
  );
</script>

<div class="warplan">
  <!-- 左：平面配置圖（幾何依 JSON；★＝固定電源點，右上角徽章＝該區用電） -->
  <div class="planwrap">
    <div class="ph">
      <span class="pt">{plan.title}</span>
      {#if plan.sub}<span class="ps">{plan.sub}</span>{/if}
      <button type="button" class="toboard" onclick={onBoard}>📊 水·油·氣·環境</button>
    </div>
    <div class="canvasbox">
      <div class="canvas">
        {#each plan.zones as z}
          {@const w = zoneW.get(z.id) ?? 0}
          <div
            class="zone k-{z.kind}"
            class:rot={!!z.rot}
            style="left:{z.x}%; top:{z.y}%; width:{z.w}%; height:{z.h}%;{z.rot ? ` transform:rotate(${z.rot}deg);` : ''}"
          >
            <span class="zl">{z.label}{#if z.star}<i class="star">★</i>{/if}</span>
            {#if z.sub}<span class="zs">{z.sub}</span>{/if}
            {#if w > 0}<span class="zkw">⚡ {kw1(w)} kW</span>{/if}
          </div>
        {/each}
      </div>
    </div>
    {#if plan.legend?.length}
      <div class="legend">
        {#each plan.legend as g}<span class="lg"><i class="sw k-{g.kind}"></i>{g.label}</span>{/each}
        <span class="lg"><i class="star">★</i>固定電源點 ×4</span>
      </div>
    {/if}
  </div>

  <!-- 右：戰時供電（儲電櫃 ×2 → 逐項負載 → 裕度/續航） -->
  {#if power}
    <aside class="pwr">
      <div class="pwr-h">{power.title}{#if power.note}<small>{power.note}</small>{/if}</div>

      <div class="cabs">
        {#each cabs as c}
          <div class="cab">
            <div class="cn">{c.name}</div>
            <div class="cv"><b>{c.kwh}</b><span>kWh</span></div>
            <div class="cr">額定輸出 {c.kw} kW</div>
            <div class="cr">{c.out}</div>
            <div class="cs">{c.state}</div>
          </div>
        {/each}
        <div class="cab sum">
          <div class="cn">合計</div>
          <div class="cv"><b>{capKwh}</b><span>kWh</span></div>
          <div class="cr">額定輸出 {capKw} kW</div>
          <div class="cr">可用電量 {usableKwh} kWh</div>
          <div class="cs">{cabs[0]?.loc ?? ''}</div>
        </div>
      </div>

      <table class="loads">
        <thead><tr><th>供電設備</th><th>數量</th><th>用電</th></tr></thead>
        <tbody>
          {#each loads as l}
            <tr>
              <th scope="row">
                {l.name}
                <small>{l.parts.map((p) => `${p.n} ×${p.qty}（${p.w} W）`).join(' · ')}</small>
              </th>
              <td class="q">{qtySum(l)}</td>
              <td class="k">{kw1(loadW(l))} kW</td>
            </tr>
          {/each}
          <tr class="tot">
            <th scope="row">總負載</th>
            <td class="q">{loads.reduce((s, l) => s + qtySum(l), 0)}</td>
            <td class="k">{totalKw.toFixed(2)} kW</td>
          </tr>
        </tbody>
      </table>

      {#if zoneRows.length}
        <div class="zsum">
          <div class="zh">各區用電</div>
          {#each zoneRows as z}
            <div class="zrow"><span>{z.label}</span><b>{kw1(z.w)} kW</b></div>
          {/each}
        </div>
      {/if}

      <div class="margin">
        <div class="mh">設備裕度</div>
        <div class="bar"><i style="width:{Math.min(100, loadPct)}%"></i></div>
        <div class="mrow"><span>負載率</span><b>{loadPct.toFixed(1)}%</b></div>
        <div class="mrow big"><span>可再承接</span><b>{marginKw.toFixed(1)} kW</b></div>
        <div class="mrow big"><span>續航</span><b>{hours.toFixed(0)} 小時</b></div>
      </div>
    </aside>
  {/if}
</div>

<style>
  .warplan { flex: 1; display: flex; gap: var(--space-sm); min-height: 0; padding: var(--space-xs) var(--space-sm) var(--space-sm); }

  /* ── 平面配置圖 ───────────────────────────────────────── */
  .planwrap { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 2px solid var(--color-accent); border-radius: var(--radius-md); padding: var(--space-xs) var(--space-sm) 4px; background: var(--color-paper); }
  .ph { display: flex; align-items: baseline; gap: var(--space-sm); flex-wrap: wrap; }
  .pt { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); }
  .ps { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .toboard { margin-left: auto; font-size: var(--text-xs); font-weight: 700; padding: 2px 10px; border-radius: var(--radius-sm); border: 1px solid var(--color-primary); background: var(--color-paper); color: var(--color-primary); cursor: pointer; }
  .canvasbox { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 4px 0; }
  /* 畫布：固定長寬比，等比塞進可用空間（kiosk 大螢幕與筆電都不裁切） */
  .canvas { position: relative; aspect-ratio: 1000 / 660; width: 100%; max-height: 100%; max-width: 100%; margin: 0 auto; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-sm); container-type: size; }

  .zone { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; text-align: center; border: 2px solid var(--color-border); border-radius: var(--radius-sm); padding: 2px 4px; overflow: hidden; }
  /* 區塊字級跟著「畫布」縮（cqw），不是跟著視窗（vw）——兩者脫鉤時，
     筆電視窗下畫布變小、字沒跟著小，區塊就會爆字（1440 實測過）。 */
  .zl { font-size: clamp(8px, 1.25cqw, 18px); font-weight: 700; line-height: 1.15; }
  .zs { font-size: clamp(7px, 1cqw, 15px); line-height: 1.2; color: var(--color-text-secondary); overflow-wrap: anywhere; }
  /* 用電徽章脫離文字流（貼右下角），小區塊才不會被它擠爆 */
  .zkw { position: absolute; right: 2px; bottom: 1px; font-size: clamp(7px, 1cqw, 15px); font-weight: 700; color: var(--color-text); background: var(--color-paper); border: 1px solid var(--color-accent); border-radius: var(--radius-sm); padding: 0 4px; line-height: 1.3; }
  .zone:has(.zkw) { padding-bottom: clamp(9px, 1.5cqw, 20px); }
  /* 斜帶（中傷/輕傷）：徽章跟著文字排，貼角會飄到帶子外面看起來像別區的 */
  .zone.rot .zkw { position: static; }
  .zone.rot:has(.zkw) { padding-bottom: 2px; }
  .star { font-style: normal; color: var(--color-energy); margin-left: 3px; }

  /* 分區配色：沿用規劃圖語彙（重傷紅／中傷黃／輕傷綠／檢傷藍／衛材粉／關懷紫／後送橘／動線綠） */
  .k-severe { background: color-mix(in oklab, var(--color-alert) 22%, var(--color-paper)); border-color: var(--color-alert); }
  .k-moderate { background: color-mix(in oklab, var(--color-energy) 55%, var(--color-paper)); border-color: var(--color-energy); }
  .k-light { background: color-mix(in oklab, var(--color-accent) 32%, var(--color-paper)); border-color: var(--color-accent); }
  .k-triage { background: color-mix(in oklab, var(--color-chart-4) 28%, var(--color-paper)); border-color: var(--color-chart-4); }
  .k-nurse { background: color-mix(in oklab, var(--color-chart-4) 14%, var(--color-paper)); border-color: var(--color-chart-4); }
  .k-support { background: color-mix(in oklab, var(--color-energy) 22%, var(--color-paper)); border-color: var(--color-energy); }
  .k-logistics { background: color-mix(in oklab, var(--color-chart-5) 22%, var(--color-paper)); border-color: var(--color-chart-5); }
  .k-care { background: color-mix(in oklab, var(--color-chart-5) 12%, var(--color-paper)); border-color: var(--color-chart-5); }
  /* 備援電力系統＝這頁的供電源頭（儲電櫃 ×2），加粗框讓它跳出來 */
  .k-backup { background: color-mix(in oklab, var(--color-accent) 34%, var(--color-paper)); border-color: var(--color-accent); border-width: 3px; }
  .k-flow { background: color-mix(in oklab, var(--color-energy) 38%, var(--color-alert) 12%); border-color: var(--color-energy); }
  .k-road { background: color-mix(in oklab, var(--color-accent) 18%, var(--color-paper)); border-color: var(--color-accent); color: var(--color-text-secondary); }
  .k-muster { background: transparent; border-style: dashed; border-color: var(--color-alert); color: var(--color-text-secondary); }
  .k-context { background: color-mix(in oklab, var(--color-text-secondary) 10%, var(--color-paper)); border-color: var(--color-border); color: var(--color-text-secondary); }
  .k-shelter { background: transparent; border: none; color: var(--color-text-secondary); }

  .legend { display: flex; flex-wrap: wrap; gap: 4px var(--space-sm); align-items: center; padding-top: 3px; border-top: 1px dashed var(--color-border); }
  .lg { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .sw { width: 14px; height: 10px; border-radius: 2px; border: 1px solid var(--color-border); display: inline-block; }

  /* ── 供電側欄 ───────────────────────────────────────── */
  .pwr { width: clamp(240px, 26%, 460px); display: flex; flex-direction: column; gap: var(--space-xs); min-height: 0; border: 2px solid var(--color-accent); border-radius: var(--radius-md); padding: var(--space-xs) var(--space-sm) var(--space-sm); background: var(--color-paper); }
  .pwr-h { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); }
  .pwr-h small { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }

  .cabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .cab { border: 1px solid var(--color-accent); border-radius: var(--radius-sm); padding: 3px 5px; background: color-mix(in oklab, var(--color-accent) 8%, var(--color-paper)); text-align: center; }
  .cab.sum { background: color-mix(in oklab, var(--color-primary) 10%, var(--color-paper)); border-color: var(--color-primary); }
  .cn { font-size: var(--text-xs); font-weight: 700; line-height: 1.2; }
  .cv { display: flex; align-items: baseline; justify-content: center; gap: 2px; }
  .cv b { font-size: var(--text-lg); font-weight: 700; }
  .cv span { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .cr { font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.25; }
  .cs { font-size: var(--text-xs); font-weight: 700; color: var(--color-accent); }

  .loads { width: 100%; border-collapse: collapse; }
  .loads th, .loads td { border-bottom: 1px solid var(--color-border); padding: 2px 4px; vertical-align: top; }
  .loads thead th { font-size: var(--text-xs); color: var(--color-text-secondary); text-align: right; background: var(--color-surface); }
  .loads thead th:first-child { text-align: left; }
  .loads tbody th { text-align: left; font-size: var(--text-sm); font-weight: 700; }
  .loads tbody th small { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); line-height: 1.25; }
  .loads td { text-align: right; font-size: var(--text-sm); white-space: nowrap; }
  .loads td.k { font-weight: 700; }
  .loads tr.tot th, .loads tr.tot td { border-top: 2px solid var(--color-text); border-bottom: none; font-size: var(--text-base); padding-top: 3px; }

  /* 各區用電：與圖上徽章同源（同一份 parts），放在總負載與裕度之間補實側欄 */
  .zsum { border-top: 1px dashed var(--color-border); padding-top: 3px; }
  .zh { font-size: var(--text-sm); font-weight: 700; color: var(--color-primary); }
  .zrow { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-sm); line-height: 1.5; }
  .zrow span { color: var(--color-text-secondary); }
  .zrow b { font-weight: 700; }

  .margin { margin-top: auto; border-top: 1px dashed var(--color-border); padding-top: var(--space-xs); }
  .mh { font-size: var(--text-sm); font-weight: 700; color: var(--color-primary); }
  .bar { height: 12px; border-radius: var(--radius-sm); background: color-mix(in oklab, var(--color-accent) 22%, var(--color-paper)); border: 1px solid var(--color-accent); overflow: hidden; margin: 3px 0; }
  .bar i { display: block; height: 100%; background: var(--color-accent); }
  .mrow { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-sm); }
  .mrow span { color: var(--color-text-secondary); }
  .mrow b { font-weight: 700; }
  .mrow.big b { font-size: var(--text-lg); }

  @media (max-width: 900px) {
    .warplan { flex-direction: column; }
    .pwr { width: auto; }
    /* 手機：畫布只剩幾百 px，區塊連區名都快放不下 → 只留區名，
       說明與各區用電改看下方供電表（同一份資料，不漏內容） */
    .zs, .zkw { display: none; }
    .zone:has(.zkw) { padding-bottom: 2px; }
  }
</style>
