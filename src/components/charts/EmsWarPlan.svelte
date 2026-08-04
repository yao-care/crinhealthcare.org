<script lang="ts">
  // 戰時 B1 開設配置圖（全螢幕一頁）＋ 行動儲電櫃供電。
  // 幾何全部來自 JSON（zones 以畫布百分比定位、斜帶用 rot 旋轉），元件只負責畫與算。
  // 單一計算源：總負載／各區用電／負載率／裕度／續航 一律由 power.loads[].parts 推導，JSON 不存彙總值。
  interface Zone { id: string; label: string; kind: string; x: number; y: number; w: number; h: number; rot?: number; sub?: string; star?: boolean; }
  interface Legend { label: string; kind: string; }
  interface Plan { title?: string; sub?: string; zones: Zone[]; legend?: Legend[]; }
  import { carousel } from '@utils/carousel';
  import { warPowerSummary, endurText, barFills, type WarPower, type WarPowerLoad, type WarPowerPart } from '@utils/ems';
  type Part = WarPowerPart;
  type Load = WarPowerLoad;

  let { plan, power, onBoard }: { plan: Plan; power?: WarPower; onBoard: () => void } = $props();

  const loads = $derived(power?.loads ?? []);
  const cabs = $derived(power?.cabinets ?? []);
  const partW = (p: Part) => p.qty * p.w;
  const loadW = (l: Load) => l.parts.reduce((s, p) => s + partW(p), 0);

  // 彙總全部走 @utils/ems 的 warPowerSummary（與五區塊盤面同一份，數字不會兩套）
  const sum = $derived(warPowerSummary(power));
  const zoneW = $derived(sum?.byZone ?? new Map<string, number>());
  const capKw = $derived(sum?.capKw ?? 0);
  const capKwh = $derived(sum?.capKwh ?? 0);
  const usableKwh = $derived(sum?.usableKwh ?? 0);
  const totalKw = $derived(sum?.totalKw ?? 0);
  const marginKw = $derived(sum?.marginKw ?? 0);
  const loadPct = $derived(sum?.loadPct ?? 0);
  const hours = $derived(sum?.hours ?? 0);

  const kw1 = (w: number) => (w / 1000).toFixed(2);
  const usablePct = $derived(power?.usablePct ?? 100);
  // 長條比例與配色（前三高金/銀/銅，與站上其他圖表同一套規則）
  const maxLoadW = $derived(Math.max(...loads.map(loadW), 1));
  const fills = $derived(barFills(loads.map(loadW)));
  // 原廠以整場定額計的項目（flat）不逐台，數量欄顯示「—」
  const qtyText = (l: Load) => (l.parts.every((p) => p.flat) ? '—' : String(l.parts.reduce((s, p) => s + p.qty, 0)));
  // 未歸區的整場定額（抽吸/備用、設備裕度）：總負載扣掉可歸區的部分，
  // 讓「圖上各區徽章 + 這一筆」剛好等於平均總負載，不會加起來少一截
  const sharedW = $derived(
    (sum?.totalKw ?? 0) * 1000 - [...zoneW.values()].reduce((s, w) => s + w, 0),
  );
  // 續航時間軸刻度：至少 5 天，續航更久就把軸拉長（不讓長條頂滿看不出還有多少）
  const tlMax = $derived(Math.max(5, Math.ceil(hours / 24) + 1));
  const tlTicks = $derived(Array.from({ length: tlMax + 1 }, (_, i) => i));
</script>

<div class="warplan">
  <!-- 左：平面配置圖（幾何依 JSON；★＝固定電源點，右上角徽章＝該區用電） -->
  <div class="planwrap">
    <div class="ph">
      <span class="pt">{plan.title}</span>
      {#if plan.sub}<span class="ps">{plan.sub}</span>{/if}
      {#if sum}
        <!-- 依現況負載可用多久：戰情室最先要看的一個數，放標題列右側 -->
        <span class="endur">⏳ 現況可用 <b>{endurText(hours)}</b><small>負載 {totalKw.toFixed(2)} kW · 可用電量 {usableKwh} kWh</small></span>
      {/if}
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

      <!-- 儲電櫃電量柱：整支＝額定容量，綠段＝可放電（DoD），上方斜紋段＝不可放電的保留電量。
           DoD 用「柱子被切成兩段」直接看出來，不是寫一行字。 -->
      {#snippet cabCol(rated: number, usable: number, big: boolean)}
        <div class="col" role="img" aria-label="額定 {rated} kWh，可放電 {usable} kWh（{usablePct}% DoD），保留 {rated - usable} kWh">
          <i class="fill" class:big style="height:{usablePct}%"><span class="clab">{usable}<small>kWh</small></span></i>
          <span class="rsv" style="height:{100 - usablePct}%"><small>保留 {100 - usablePct}%</small></span>
        </div>
      {/snippet}
      <div class="cabs">
        {#each cabs as c}
          <div class="cab">
            <div class="cn">{c.name.replace('行動儲電櫃 ', '')}</div>
            {@render cabCol(c.kwh, (c.kwh * usablePct) / 100, false)}
            <div class="cr">額定 {c.kwh} kWh</div>
            <div class="chip">輸出 {c.kw} kW</div>
            <div class="cs">{c.state}</div>
          </div>
        {/each}
        <div class="cab sum">
          <div class="cn">合計 ×{cabs.length}</div>
          {@render cabCol(capKwh, usableKwh, true)}
          <div class="cr">額定 {capKwh} kWh</div>
          <div class="chip">輸出 {capKw} kW</div>
          <div class="cs">{cabs[0]?.loc ?? ''}</div>
        </div>
      </div>

      <!-- 逐項負載：長條依用電比例（前三高走站上金/銀/銅配色），數字仍在右側 -->
      <div class="loads" use:carousel>
        <div class="lh"><span>供電設備</span><span class="lhq">數量</span><span class="lhk">用電</span></div>
        {#each loads as l, i}
          {@const w = loadW(l)}
          <div class="lrow">
            <div class="ltop"><span class="ln">{l.name}</span><span class="lq">{qtyText(l)}</span><span class="lk">{kw1(w)} kW</span></div>
            <div class="lbar"><i style="width:{maxLoadW ? (w / maxLoadW) * 100 : 0}%; background:{fills[i]}"></i></div>
            <div class="ldet">{l.parts.map((p) => (p.flat ? `${p.n}（${p.w} W）` : `${p.n} ×${p.qty}（${p.w} W）`)).join(' · ')}</div>
          </div>
        {/each}
        <div class="lrow tot"><div class="ltop"><span class="ln">平均總負載</span><span class="lq"></span><span class="lk">{totalKw.toFixed(2)} kW</span></div></div>
      </div>

      <!-- 各區用電不另列清單：圖上每區的 ⚡ 徽章就是（同一份 parts），這裡只補未歸區的整場定額 -->
      {#if sharedW > 0}
        <div class="zsum">圖上 ⚡ 徽章＝各區用電；另有全場共用（抽吸·備用·裕度）<b>{kw1(sharedW)} kW</b></div>
      {/if}

      <div class="margin">
        <!-- 「設備裕度」一詞在原廠負載表裡是保留負載（算在總負載內），這裡講的是儲電櫃還剩多少出力，
             兩者不同 → 這塊叫「供電餘裕」，避免同名不同義 -->
        <div class="mh">供電餘裕與續航</div>
        <div class="gauges">
          <!-- 負載率環圈：已用 vs 額定輸出 -->
          <svg class="donut" viewBox="0 0 120 120" role="img" aria-label="負載率 {loadPct.toFixed(1)}%，可再承接 {marginKw.toFixed(1)} kW">
            <circle class="dtrack" cx="60" cy="60" r="46" />
            <circle
              class="dval" cx="60" cy="60" r="46"
              stroke-dasharray="{(Math.min(100, loadPct) / 100) * 289} 289"
              transform="rotate(-90 60 60)"
            />
            <text class="dnum" x="60" y="56" text-anchor="middle" font-size="26">{loadPct.toFixed(1)}%</text>
            <text class="dcap" x="60" y="78" text-anchor="middle" font-size="15">負載率</text>
          </svg>
          <div class="gtxt">
            <div class="grow"><span>目前負載</span><b>{totalKw.toFixed(2)} kW</b></div>
            <div class="grow"><span>可再承接</span><b>{marginKw.toFixed(1)} kW</b></div>
            <div class="grow"><span>額定輸出</span><b>{capKw} kW</b></div>
          </div>
        </div>
        <!-- 續航時間軸：刻度到 5 天，標出原廠單台 2–3 天備援續航供對照 -->
        <div class="tl">
          <div class="tlrow"><span class="tlcap">依現況可用</span><b class="tlbig">{endurText(hours)}</b></div>
          <div class="tlbar">
            <span class="ref" style="left:{(2 / tlMax) * 100}%; width:{(1 / tlMax) * 100}%"></span>
            <i style="width:{Math.min(100, (hours / 24 / tlMax) * 100)}%"></i>
          </div>
          <div class="tlticks">{#each tlTicks as t}<span>{t}天</span>{/each}</div>
        </div>
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
  /* 現況可用多久：標題列的主角，字要大、要一眼看到 */
  .endur { margin-left: auto; display: flex; align-items: baseline; gap: 6px; font-size: var(--text-sm); font-weight: 700; color: var(--color-text); background: color-mix(in oklab, var(--color-energy) 26%, var(--color-paper)); border: 2px solid var(--color-energy); border-radius: var(--radius-md); padding: 2px 12px; }
  .endur b { font-size: var(--text-xl); font-weight: 700; }
  .endur small { font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }
  .toboard { font-size: var(--text-xs); font-weight: 700; padding: 2px 10px; border-radius: var(--radius-sm); border: 1px solid var(--color-primary); background: var(--color-paper); color: var(--color-primary); cursor: pointer; }
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
  .pwr { container-type: size; width: clamp(240px, 26%, 460px); display: flex; flex-direction: column; gap: var(--space-xs); min-height: 0; border: 2px solid var(--color-accent); border-radius: var(--radius-md); padding: var(--space-xs) var(--space-sm) var(--space-sm); background: var(--color-paper); }
  .pwr-h { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); }
  .pwr-h small { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }

  /* 儲電櫃：電量柱（與五區塊盤面「儲存端」同一套視覺語彙——直筒填色＋水面上下換字色） */
  .cabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .cab { display: flex; flex-direction: column; align-items: center; gap: 2px; border: 1px solid var(--color-accent); border-radius: var(--radius-sm); padding: 3px 5px; background: color-mix(in oklab, var(--color-accent) 8%, var(--color-paper)); text-align: center; }
  .cab.sum { background: color-mix(in oklab, var(--color-primary) 10%, var(--color-paper)); border-color: var(--color-primary); }
  .cn { font-size: var(--text-xs); font-weight: 700; line-height: 1.2; }
  /* 電量柱：整支＝額定；下段實色＝可放電（DoD），上段斜紋＝保留不可放 */
  .col { width: 100%; max-width: 84px; height: clamp(52px, 7vh, 96px); background: var(--color-paper); border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; display: flex; flex-direction: column-reverse; }
  .col .fill { display: flex; align-items: center; justify-content: center; width: 100%; background: var(--color-accent); }
  .cab.sum .col .fill { background: var(--color-primary); }
  .clab { font-size: var(--text-sm); font-weight: 700; color: var(--color-paper); line-height: 1.1; }
  .clab small { font-size: var(--text-xs); font-weight: 400; margin-left: 2px; }
  .col .fill.big .clab { font-size: var(--text-base); }
  .rsv { display: flex; align-items: center; justify-content: center; width: 100%; color: var(--color-text-secondary); background: repeating-linear-gradient(-45deg, var(--color-surface) 0 4px, var(--color-border) 4px 6px); }
  .rsv small { font-size: var(--text-xs); }
  .cr { font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.25; }
  .chip { font-size: var(--text-xs); font-weight: 700; border: 1px solid var(--color-border); border-radius: 99px; padding: 0 7px; background: var(--color-paper); white-space: nowrap; }
  .cs { font-size: var(--text-xs); font-weight: 700; color: var(--color-accent); }

  /* 逐項負載：名稱/數量/kW 一列，下面接依比例的長條（前三高金銀銅），再一行組成明細 */
  .loads { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 2px; }
  .lh { position: sticky; top: 0; z-index: 1; }
  .lh { display: flex; align-items: baseline; gap: 6px; font-size: var(--text-xs); color: var(--color-text-secondary); background: var(--color-surface); padding: 1px 4px; border-radius: var(--radius-sm); }
  .lh span:first-child { flex: 1; }
  .lhq { width: 3.2em; text-align: right; }
  .lhk { width: 5em; text-align: right; }
  .lrow { border-bottom: 1px solid var(--color-border); padding-bottom: 2px; }
  .ltop { display: flex; align-items: baseline; gap: 6px; }
  .ln { flex: 1; font-size: var(--text-sm); font-weight: 700; min-width: 0; }
  .lq { width: 3.2em; text-align: right; font-size: var(--text-sm); }
  .lk { width: 5em; text-align: right; font-size: var(--text-sm); font-weight: 700; white-space: nowrap; }
  .lbar { height: 9px; background: var(--color-surface); border-radius: var(--radius-sm); overflow: hidden; margin: 1px 0; }
  .lbar i { display: block; height: 100%; border-radius: var(--radius-sm); }
  .ldet { font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.25; }
  .lrow.tot { border-bottom: none; border-top: 2px solid var(--color-text); padding-top: 2px; }
  .lrow.tot .ln, .lrow.tot .lk { font-size: var(--text-base); }

  /* 各區用電：與圖上徽章同源（同一份 parts），橫條看比重 */
  .zsum { border-top: 1px dashed var(--color-border); padding-top: 3px; font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.35; }
  .zsum b { color: var(--color-text); }

  /* 供電餘裕：負載率環圈＋續航時間軸（灰段＝原廠單台 2–3 天備援續航，供對照） */
  .margin { margin-top: auto; border-top: 1px dashed var(--color-border); padding-top: var(--space-xs); }
  .mh { font-size: var(--text-sm); font-weight: 700; color: var(--color-primary); }
  .gauges { display: flex; align-items: center; gap: var(--space-sm); }
  .donut { width: clamp(64px, 7vw, 104px); height: auto; flex: none; }
  .dtrack { fill: none; stroke: var(--color-surface); stroke-width: 14; }
  .dval { fill: none; stroke: var(--color-accent); stroke-width: 14; stroke-linecap: round; }
  .dnum { fill: var(--color-text); font-weight: 700; }
  .dcap { fill: var(--color-text-secondary); }
  .gtxt { flex: 1; min-width: 0; }
  .grow { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-sm); }
  .grow span { color: var(--color-text-secondary); }
  .grow b { font-weight: 700; }
  .tl { margin-top: 3px; }
  .tlrow { display: flex; justify-content: space-between; align-items: baseline; }
  .tlcap { font-size: var(--text-sm); font-weight: 700; }
  .tlbig { font-size: var(--text-xl); font-weight: 700; color: var(--color-alert); }
  .tlbar { position: relative; height: 14px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
  .tlbar .ref { position: absolute; top: 0; bottom: 0; background: color-mix(in oklab, var(--color-text-secondary) 22%, var(--color-paper)); }
  .tlbar i { position: relative; display: block; height: 100%; background: var(--color-accent); }
  .tlticks { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--color-text-secondary); }

  /* 側欄放不下時的收合順序：先收各項組成明細，再收時間軸刻度（數字與圖形一律留著） */
  @container (max-height: 860px) { .ldet { display: none; } }
  @container (max-height: 720px) { .tlticks { display: none; } .col { height: clamp(40px, 5vh, 64px); } .pwr-h small { display: none; } }

  @media (max-width: 900px) {
    .warplan { flex-direction: column; }
    .pwr { width: auto; }
    /* 手機：畫布只剩幾百 px，區塊連區名都快放不下 → 只留區名，
       說明與各區用電改看下方供電表（同一份資料，不漏內容） */
    .zs, .zkw { display: none; }
    .zone:has(.zkw) { padding-bottom: 2px; }
  }
</style>
