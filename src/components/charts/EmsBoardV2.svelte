<script lang="ts">
  // v2 五大區塊 Dashboard（電/環境參數/水/油/氣）。骨架用比例(%)、卡片固定尺寸+自適應換行。
  // 平時主軸＝效率/成本/ESG；戰時主軸＝續航/餘裕/維生（標題列推出 ⏳續航 徽章）。
  // 「資料→呈現」規則集中在 @utils/ems（供給紅底/bar 前三高配色/環境分級底色）。
  import { isSupplyAbnormal, barFills, envSeverity } from '@utils/ems';
  interface Supply { name: string; value: string; online: boolean; esg: string; pct?: string; react?: string; autonomous?: boolean; warn?: boolean; }
  interface Store { name: string; days: string; cap: string; pct: number; warn?: boolean; state?: string; critical?: boolean; }
  interface UseBlock { name: string; value?: string; pctOfTotal?: string; lastYear?: string; current?: string; unit?: string; daily?: number[]; lastYearDaily?: number[]; critical?: boolean; color?: string; items?: string[]; }
  interface Scenario { perf: { text: string }; endur: { days: string; pct: string }; supply: Supply[]; supplySum: string; store: Store[]; use: { headline: string; sub: string; blocks: UseBlock[] }; }
  interface Resource { id: string; icon: string; name: string; peace: Scenario; war: Scenario; }
  interface EnvFloor { floor: string; temp: string; rh: string; co2: string; }
  interface EnvBuilding { name: string; floors: EnvFloor[]; }
  interface Env {
    peace: { buildings: EnvBuilding[] }; war: { buildings: EnvBuilding[] };
    thresholds?: { temp?: { min?: number; max?: number }; rh?: { min?: number; max?: number }; co2?: { max?: number } };
    criticalFloors?: string[];
    carbon?: { title: string; cols: string[]; rows: { label: string; cells: string[] }[] };
  }
  interface Hospital { name: string; location?: string; version?: string; updated?: string; scenarios: { id: string; label: string }[]; resources: Resource[]; env?: Env; show?: string[]; }

  let { hospital }: { hospital: Hospital } = $props();
  let scenario = $state('peace');
  const war = $derived(scenario !== 'peace');
  const other = $derived(hospital.scenarios.find((s) => s.id !== scenario) ?? hospital.scenarios[0]);

  // hospital.show：限定只顯示這些區塊（power/water/oil/gas/env）；未設則全顯示。隱藏其餘後，留下的區塊靠 flex 自動撐滿。
  const show: string[] | null = hospital.show ?? null;
  const visible = (id: string) => !show || show.includes(id);
  const r2list = $derived(hospital.resources.filter((r) => ['water', 'oil', 'gas'].includes(r.id) && visible(r.id)));

  // 使用端輪播：項目過多放不下時，每 5 秒自動換頁(垂直捲動)，輪到所有項目。放得下就不動。
  function carousel(node: HTMLElement) {
    const id = setInterval(() => {
      const max = node.scrollHeight - node.clientHeight;
      if (max <= 4) return; // 放得下，不輪播
      // 已到底→回頂；否則前進約一頁，但夾在底部內（內容僅略微溢出時，一頁步距會超過總溢出量，不夾住會誤判成「該歸零」而永遠停在頂端）
      const next = node.scrollTop >= max - 2 ? 0 : Math.min(node.scrollTop + node.clientHeight * 0.92, max);
      node.scrollTo({ top: next, behavior: 'smooth' });
    }, 5000);
    return { destroy() { clearInterval(id); } };
  }

  // 區塊邊框色（依附圖：電綠 / 環境紅 / 水藍 / 油橘 / 氣紫）
  const FRAME: Record<string, string> = { power: 'accent', water: 'chart-4', oil: 'energy', gas: 'chart-5' };
  const ESG: Record<string, string> = { grey: 'text-secondary', green: 'accent', blue: 'chart-4', amber: 'energy', na: 'border' };
  const tone = (key: string) => `var(--color-${key})`;

  function roc(iso?: string): string {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y) return iso;
    return `${y - 1911}/${m ?? ''}/${d ?? ''}`;
  }

  // 使用端卡片小圖：每日 daily 長條 + 去年同期 lastYearDaily 參考線
  function chart(daily?: number[], ref?: number[]) {
    if (!daily?.length) return null;
    const W = 100, H = 40, n = daily.length;
    const all = [...daily, ...(ref ?? [])];
    const max = Math.max(...all, 1);
    const bw = W / n;
    const fills = barFills(daily);
    const bars = daily.map((v, i) => ({ x: i * bw + bw * 0.15, w: bw * 0.7, h: (v / max) * H, y: H - (v / max) * H, fill: fills[i] }));
    const refLine = ref?.length ? ref.map((v, i) => `${i * bw + bw / 2},${H - (v / max) * H}`).join(' ') : '';
    return { bars, refLine, W, H };
  }
</script>

<!-- 能源區塊（電/水/油/氣）：供給端(左上)/儲存端(左下)/使用端(右)；戰時標題列推出續航徽章 -->
{#snippet energyBlock(r: Resource)}
  {@const d = r[scenario]}
  <section class="block" style="border-color:{tone(FRAME[r.id] ?? 'border')}">
    <header class="bhead">
      <span class="bname">{r.icon} {r.name}</span>
      <a class="detail" href={`detail/${r.id}`}>🔎 看詳情</a>
      {#if war}
        <span class="endur" class:low={parseFloat(d.endur.pct) < 30}>⏳ 撐 {d.endur.days || '—'} · 餘 {d.endur.pct || '—'}</span>
      {:else if d.perf?.text}
        <span class="bperf">{d.perf.text}</span>
      {/if}
    </header>
    <div class="bbody">
      <div class="leftcol">
        <div class="seg supply">
          <div class="seg-h">🔌 供給端 <small>{war ? '誰還在供·能否自主' : '誰在供'}</small></div>
          {#each d.supply as s}
            <div class="srow" class:off={!s.online} class:abn={isSupplyAbnormal(s)} style="border-left-color:{tone(ESG[s.esg] ?? 'border')}">
              <span class="nm">{s.name}{#if war && s.autonomous}<span class="auto">自主</span>{/if}</span>
              <span class="vv">{s.value || '—'}{#if war && s.react}<small> {s.react}</small>{:else if !war && s.pct}<small> {s.pct}</small>{/if}</span>
            </div>
          {/each}
          {#if d.supplySum}<div class="srow sum"><span class="nm">合計</span><span class="vv">{d.supplySum}</span></div>{/if}
        </div>
        <div class="seg store">
          <div class="seg-h">🔋 儲存端 <small>{war ? '剩多久·夠不夠' : '剩多久'}</small></div>
          <div class="tanks">
            {#each d.store as st}
              <div class="tank" class:warn={st.warn} class:crit={st.critical}>
                <div class="days">{st.days || '—'}</div>
                <div class="col"><span class="pct">{st.pct ? st.pct + '%' : '—'}</span>{#if st.pct}<span class="pct over" style="clip-path: inset(calc(100% - {st.pct}%) 0 0 0)">{st.pct}%</span>{/if}<i style="height:{st.pct || 0}%"></i></div>
                <div class="tn">{st.name}</div>
                <div class="tc">{st.cap}{#if st.state} · {st.state}{/if}</div>
              </div>
            {/each}
          </div>
        </div>
      </div>
      <div class="usecol">
        <div class="seg-h">⚙️ 使用端 <small>{war ? '維生優先·可卸載' : '即時·趨勢'}</small>{#if d.use.blocks.length > 2}<span class="roll">● 自動輪播</span>{/if}</div>
        <div class="cards" use:carousel>
          {#each d.use.blocks as b}
            {@const c = chart(b.daily, b.lastYearDaily)}
            <div class="card" class:crit={b.critical} style="border-top-color:{tone(b.color ?? 'chart-1')}">
              <div class="ch">
                <span class="cn">{b.name}{#if b.critical}<span class="cb">維生</span>{/if}</span>
                {#if !b.items?.length}<span class="cp">佔總量 {b.pctOfTotal || '—'}</span>{/if}
              </div>
              {#if b.items?.length}
                <!-- 收治區型卡片：卡身＝該區用電設備清單（品名×數量），取代電表欄 -->
                <ul class="citems">
                  {#each b.items as it}<li>{it}</li>{/each}
                </ul>
              {:else}
                <div class="cnums">
                  <span class="cnum"><em>去年同期</em><b>{b.lastYear || '—'}</b></span>
                  <span class="cnum now"><em>現況電表</em><b>{b.current || '—'}</b></span>
                </div>
                <div class="cchart">
                  {#if c}
                    <svg viewBox="0 0 {c.W} {c.H}" preserveAspectRatio="none" aria-hidden="true">
                      {#each c.bars as bar}<rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.fill} />{/each}
                      {#if c.refLine}<polyline points={c.refLine} class="ref" />{/if}
                    </svg>
                  {:else}<span class="nodata">每日統計 · 待盤點</span>{/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </section>
{/snippet}

<div class="v2">
  <header class="top">
    <h1 class="ttl">🔋 平戰轉EMS · {hospital.name}</h1>
    <button type="button" class="scn" class:war onclick={() => (scenario = other.id)}>
      {war ? '☀️ ' : '🚨 '}轉{other.label}
    </button>
    <dl class="meta">
      <div><dt>版本</dt><dd>{hospital.version || '—'}</dd></div>
      <div><dt>更新</dt><dd>{roc(hospital.updated)}</dd></div>
    </dl>
  </header>

  <div class="grid">
    <!-- 上半：電力（寬）+ 環境參數（窄） -->
    <div class="r r1">
      {#each hospital.resources.filter((r) => r.id === 'power' && visible('power')) as r}
        {@render energyBlock(r)}
      {/each}

      <!-- 環境參數（特例：無供/儲/使、無看詳情；主角＝各樓層，碳盤查置底縮小） -->
      {#if hospital.env && visible('env')}
        {@const env = hospital.env}
        {@const blds = (war ? env.war : env.peace).buildings}
        {@const first = blds[0]}
        {@const rest = blds.slice(1)}
        {#snippet bldTable(bld: EnvBuilding)}
          <div class="bld">
            <div class="bld-h">{bld.name}</div>
            <table class="floors">
              <thead><tr><th></th><th>溫℃</th><th>濕%</th><th>CO₂</th></tr></thead>
              <tbody>
                {#each bld.floors as f}
                  {@const key = env.criticalFloors?.includes(`${bld.name}${f.floor}`)}
                  <tr class:keyfl={key}>
                    <th scope="row">{f.floor}</th>
                    <td class="sev-{envSeverity('temp', f.temp, { critical: key })}">{f.temp || '—'}</td>
                    <td class="sev-{envSeverity('rh', f.rh, { critical: key })}">{f.rh || '—'}</td>
                    <td class="sev-{envSeverity('co2', f.co2, { critical: key })}">{f.co2 || '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/snippet}
        <section class="block env" style="border-color:{tone('alert')}">
          <header class="bhead">
            <span class="bname">🇹🇼 環境參數</span>
            <span class="bperf">{war ? '關鍵區域(ICU/手術室)環境維持' : '室內溫濕·CO₂ 空品'} ・ ★ICU/手術室 濕度標準 50–80%</span>
          </header>
          <!-- 排法：最高樓(急重症)靠左；右邊上方碳盤查、下方醫療+綜合。全部【底部對齊】(B1 同基準線)使樓層橫向一致；全樓層不捲動。 -->
          <div class="env-body">
            {#if first}{@render bldTable(first)}{/if}
            <div class="rightcol">
              {#if env.carbon}
                <div class="carbon-wrap">
                  <div class="carbon-h">📈 {env.carbon.title}</div>
                  <table class="carbon">
                    <thead><tr>{#each env.carbon.cols as c}<th>{c}</th>{/each}</tr></thead>
                    <tbody>
                      {#each env.carbon.rows as row}
                        <tr><th scope="row">{row.label}</th>{#each row.cells as cell}<td>{cell || '—'}</td>{/each}</tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
              <div class="right-blds">
                {#each rest as bld}{@render bldTable(bld)}{/each}
              </div>
            </div>
          </div>
        </section>
      {/if}
    </div>

    <!-- 下半：水 / 油 / 氣（依 hospital.show 篩選；全隱藏則整列不顯示，上半電力撐滿全高） -->
    {#if r2list.length}
      <div class="r r2">
        {#each r2list as r}
          {@render energyBlock(r)}
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .v2 {
    /* 流體字級：依視窗寬度等比縮放（小螢幕自動變小、桌機/大螢幕回設計值）。
       覆寫全站 --text-*，元件內所有 var(--text-*) 自動跟著縮。 */
    --text-xs: clamp(8px, 1.0vw, 14px);
    --text-sm: clamp(9px, 1.2vw, 16px);
    --text-base: clamp(10px, 1.45vw, 18px);
    --text-lg: clamp(11px, 1.7vw, 20px);
    --text-xl: clamp(13px, 2.2vw, 26px);
    height: 100dvh; display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); background: var(--color-paper); overflow: hidden;
  }

  /* 盤面控制項(看詳情/情境切換)：解除全站 44px 觸控下限，依盤面字級緊湊呈現
     (kiosk 以大螢幕展示為主、非觸控優先；全站其他頁面仍維持 44px 無障礙)。 */
  .v2 a, .v2 button { min-width: 0; min-height: 0; }

  /* 頂列 */
  .top { display: flex; align-items: center; gap: var(--space-md); border-bottom: 2px solid var(--color-border); padding-bottom: var(--space-xs); flex-shrink: 0; }
  .ttl { font-size: var(--text-xl); font-weight: 700; margin: 0; }
  .scn { margin-left: auto; font-size: var(--text-base); font-weight: 700; padding: 0.4rem 1.1rem; border-radius: var(--radius-md); border: 2px solid var(--color-text-secondary); background: var(--color-surface); color: var(--color-text-secondary); cursor: pointer; white-space: nowrap; }
  .scn.war { border-color: var(--color-alert); background: var(--color-alert); color: var(--color-paper); }
  .meta { display: flex; gap: var(--space-sm); margin: 0; }
  .meta div { display: flex; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
  .meta dt { background: var(--color-surface); color: var(--color-text-secondary); font-size: var(--text-xs); padding: 2px 8px; margin: 0; }
  .meta dd { font-size: var(--text-sm); font-weight: 700; padding: 2px 10px; margin: 0; }

  /* 骨架：上下兩列，比例(%)分配 */
  .grid { flex: 1; display: flex; flex-direction: column; gap: var(--space-sm); min-height: 0; }
  .r { display: flex; gap: var(--space-sm); min-height: 0; }
  .r1 { flex: 1.05; }
  .r2 { flex: 1; }
  .r1 > .block:first-child { flex: 1.6; }
  .r1 > .env { flex: 1; }
  .r2 > .block { flex: 1; }

  /* 區塊 */
  .block { display: flex; flex-direction: column; border: 3px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; min-height: 0; }
  .bhead { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .bname { font-size: var(--text-lg); font-weight: 700; white-space: nowrap; }
  .detail { font-size: var(--text-xs); font-weight: 700; padding: 2px 8px; border-radius: var(--radius-sm); background: var(--color-primary-pale); color: var(--color-primary); text-decoration: none; white-space: nowrap; }
  .bperf { font-size: var(--text-xs); color: var(--color-text-secondary); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 戰時：續航/餘裕徽章推到最前 */
  .endur { margin-left: auto; font-size: var(--text-sm); font-weight: 700; color: var(--color-energy); background: color-mix(in oklch, var(--color-energy) 14%, transparent); border: 1px solid var(--color-energy); border-radius: var(--radius-sm); padding: 1px 8px; white-space: nowrap; }
  .endur.low { color: var(--color-alert); background: color-mix(in oklch, var(--color-alert) 14%, transparent); border-color: var(--color-alert); }

  .bbody { flex: 1; display: grid; grid-template-columns: 0.85fr 1.6fr; min-height: 0; }
  .leftcol { display: flex; flex-direction: column; border-right: 1px dashed var(--color-border); min-height: 0; }
  .seg { padding: 4px var(--space-sm); min-height: 0; }
  .seg-h { font-size: var(--text-xs); font-weight: 700; color: var(--color-primary); margin-bottom: 3px; }
  .seg-h small { color: var(--color-text-secondary); font-weight: 400; }
  .supply { flex: 1; overflow: auto; }
  .store { flex: 0.85; border-top: 1px dashed var(--color-border); display: flex; flex-direction: column; }

  .srow { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); padding: 2px 6px; border-left: 5px solid var(--color-border); margin-bottom: 2px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0; background: color-mix(in oklch, var(--color-accent) 10%, transparent); }
  .srow.off { background: var(--color-surface); color: var(--color-text-secondary); }
  /* 供給端異常 → 紅底（@utils/ems isSupplyAbnormal） */
  .srow.abn { background: color-mix(in oklch, var(--color-alert) 22%, var(--color-paper)); border-left-color: var(--color-alert) !important; color: var(--color-text); }
  .srow.abn .vv { color: var(--color-alert); }
  .srow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow .nm .auto { font-size: var(--text-xs); font-weight: 700; color: var(--color-accent); border: 1px solid var(--color-accent); border-radius: var(--radius-sm); padding: 0 4px; margin-left: 5px; }
  .srow .vv { font-weight: 700; white-space: nowrap; }
  .srow .vv small { color: var(--color-text-secondary); font-weight: 400; }
  .srow.sum { background: none; border-left-color: transparent; border-top: 2px solid var(--color-border); margin-top: 2px; font-weight: 700; color: var(--color-primary); }

  .tanks { flex: 1; display: flex; gap: var(--space-sm); align-items: stretch; min-height: 0; padding: 2px 0; }
  .tank { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .tank .days { font-size: var(--text-base); font-weight: 700; color: var(--color-accent); line-height: 1.1; }
  .tank.warn .days, .tank.crit .days { color: var(--color-alert); }
  .tank .col { flex: 1; width: 100%; max-width: 46px; background: var(--color-paper); border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; display: flex; flex-direction: column-reverse; margin: 3px 0; position: relative; min-height: 24px; }
  .tank .col i { display: block; width: 100%; background: var(--color-primary); }
  .tank.warn .col i, .tank.crit .col i { background: var(--color-alert); }
  .tank .col .pct { position: absolute; top: 2px; left: 0; right: 0; text-align: center; font-size: var(--text-xs); font-weight: 700; color: var(--color-text); }
  /* 淹到水位線以下的數字改用淺色（疊在深色填充上才看得清）；clip 量綁 pct，水面以上露出底層深字 */
  .tank .col .pct.over { top: 0; bottom: 0; padding-top: 2px; color: var(--color-paper); }
  .tank .tn { font-size: var(--text-xs); font-weight: 700; text-align: center; }
  .tank .tc { font-size: var(--text-xs); color: var(--color-text-secondary); text-align: center; line-height: 1.15; }

  /* 使用端：固定尺寸卡片 + 自適應換行 */
  .usecol { display: flex; flex-direction: column; padding: 4px var(--space-sm); min-height: 0; }
  .seg-h .roll { font-size: var(--text-xs); font-weight: 700; color: var(--color-accent); margin-left: 8px; }
  /* overflow:hidden → 放不下的卡片由 use:carousel 自動換頁輪播 */
  .cards { flex: 1; display: flex; flex-wrap: wrap; gap: var(--space-sm); align-content: flex-start; overflow: hidden; min-height: 0; scroll-behavior: smooth; }
  .card { width: clamp(140px, 16vw, 220px); flex: 0 0 auto; background: var(--color-paper); border: 1px solid var(--color-border); border-top: 3px solid var(--color-chart-1); border-radius: var(--radius-sm); padding: 5px 9px; display: flex; flex-direction: column; gap: 3px; }
  .card.crit { box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--color-alert) 35%, transparent); }
  .ch { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 6px; flex-wrap: wrap; }
  .cn { font-size: var(--text-sm); font-weight: 700; min-width: 0; }
  .cb { font-size: var(--text-xs); font-weight: 700; color: var(--color-paper); background: var(--color-alert); border-radius: var(--radius-sm); padding: 0 5px; margin-left: 4px; white-space: nowrap; display: inline-block; }
  .cp { font-size: var(--text-xs); color: var(--color-text-secondary); white-space: nowrap; }
  .cnums { display: flex; gap: var(--space-sm); }
  .cnum { display: flex; flex-direction: column; line-height: 1.1; }
  .cnum em { font-size: var(--text-xs); color: var(--color-text-secondary); font-style: normal; }
  .cnum b { font-size: var(--text-base); }
  .cnum.now b { color: var(--color-primary); }
  .citems { margin: 0; padding: 0 0 0 2px; list-style: none; font-size: var(--text-xs); line-height: 1.45; }
  .citems li { display: flex; align-items: baseline; gap: 5px; }
  .citems li::before { content: '·'; font-weight: 700; color: var(--color-text-secondary); }
  .cchart { height: 40px; margin-top: 2px; }
  .cchart svg { width: 100%; height: 100%; display: block; }
  /* bar fill 由 @utils/ems barFills 提供(前三高不同色)，逐條 inline */
  .cchart .ref { fill: none; stroke: var(--color-text-secondary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .nodata { font-size: var(--text-xs); color: var(--color-text-secondary); font-style: italic; }

  /* 環境參數：最高樓(急重症)靠左；右邊上方碳盤查、下方醫療+綜合。全部底部對齊→B1 同基準線、樓層橫向一致。全樓層不捲動。 */
  .env-body { flex: 1; display: flex; gap: var(--space-sm); align-items: flex-end; padding: var(--space-xs) var(--space-sm); min-height: 0; overflow: hidden; }
  .rightcol { flex: 1; align-self: stretch; display: flex; flex-direction: column; min-width: 0; }
  .right-blds { margin-top: auto; display: flex; gap: var(--space-sm); align-items: flex-end; }
  .right-blds .bld { flex: 1; }
  .env-body > .bld { flex: 0 1 auto; }
  .bld { min-width: 0; }
  .bld-h { font-size: var(--text-sm); font-weight: 700; text-align: center; margin-bottom: 2px; }
  .floors { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
  .floors th, .floors td { border: 1px solid var(--color-border); padding: 1px 4px; text-align: center; line-height: 1.25; }
  .floors thead th { background: var(--color-surface); color: var(--color-text-secondary); }
  .floors tbody th { background: var(--color-surface); font-weight: 700; }
  /* 環境分級底色（@utils/ems envSeverity）：warn 琥珀、crit 紅 */
  .floors td.sev-warn { background: color-mix(in oklch, var(--color-energy) 38%, var(--color-paper)); font-weight: 700; }
  .floors td.sev-crit { background: var(--color-alert); color: var(--color-paper); font-weight: 700; }
  .floors tr.keyfl th { color: var(--color-primary); }
  .floors tr.keyfl th::after { content: ' ★'; color: var(--color-primary); }
  .carbon-wrap { min-width: 0; flex-shrink: 0; margin-bottom: var(--space-xs); }
  .carbon-h { font-size: var(--text-xs); font-weight: 700; color: var(--color-text-secondary); margin-bottom: 2px; }
  .carbon { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
  .carbon th, .carbon td { border: 1px solid var(--color-border); padding: 1px 5px; text-align: right; }
  .carbon thead th { background: var(--color-surface); color: var(--color-text-secondary); }
  .carbon tbody th { text-align: left; font-weight: 400; color: var(--color-text-secondary); }
  /* 注意：不加會改變骨架的 @media——五區塊 % 佈局在任何寬高都維持(kiosk 等比縮放)。 */
</style>
