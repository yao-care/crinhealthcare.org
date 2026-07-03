<script lang="ts">
  // v2 看詳情：單一資源(電/水/油/氣)鑽取詳情頁。可捲動、供/儲/使完整攤開、設備層具名清單(含管理人/聯絡)。
  import { barFills } from '@utils/ems';
  import { createEssPoller, applyEssToScenario, applyEssToDevices } from '@utils/essLive.svelte';

  interface Supply { name: string; value: string; online: boolean; esg: string; pct?: string; react?: string; autonomous?: boolean; warn?: boolean; live?: string; }
  interface Store { name: string; days: string; cap: string; pct: number; warn?: boolean; state?: string; critical?: boolean; metrics?: { k: string; v: string }[]; flags?: { label: string; tone: string }[]; live?: string; }
  interface UseBlock { name: string; pctOfTotal?: string; lastYear?: string; current?: string; unit?: string; daily?: number[]; lastYearDaily?: number[]; critical?: boolean; color?: string; }
  interface Scenario { perf: { text: string }; endur: { days: string; pct: string; live?: string }; supply: Supply[]; supplySum: string; store: Store[]; use: { headline: string; sub: string; blocks: UseBlock[] }; }
  interface Device { name: string; loc?: string; system?: string; status?: string; reading?: string; daily?: number[]; refDaily?: number[]; unit?: string; manager?: string; contact?: string; vendor?: string; live?: string; }
  interface Resource { id: string; icon: string; name: string; peace: Scenario; war: Scenario; devices?: Device[]; }
  interface Hospital { name: string; version?: string; updated?: string; liveData?: boolean; scenarios: { id: string; label: string }[]; resources: Resource[]; }

  let { hospital, resourceId, backHref }: { hospital: Hospital; resourceId: string; backHref: string } = $props();
  const r = $derived(hospital.resources.find((x) => x.id === resourceId));
  let scenario = $state('peace');
  const war = $derived(scenario !== 'peace');
  const other = $derived(hospital.scenarios.find((s) => s.id !== scenario) ?? hospital.scenarios[0]);

  // 儲能櫃即時資料（同 EmsBoardV2）：只在 liveData 醫院的電力資源頁輪詢
  const ess = hospital.liveData && resourceId === 'power' ? createEssPoller() : null;
  $effect(() => { if (ess) return ess.start(); });
  const d = $derived(r ? (ess ? applyEssToScenario(war ? r.war : r.peace, ess.data, war) : (war ? r.war : r.peace)) : null);
  const devices = $derived(r?.devices?.length ? (ess ? applyEssToDevices(r.devices, ess.data) : r.devices) : []);

  const ESG: Record<string, string> = { grey: 'text-secondary', green: 'accent', blue: 'chart-4', amber: 'energy', na: 'border' };
  const tone = (k: string) => `var(--color-${k})`;
  function roc(iso?: string) { if (!iso) return ''; const [y, m, dd] = iso.split('-').map(Number); return y ? `${y - 1911}/${m ?? ''}/${dd ?? ''}` : iso; }

  // 完整每日長條 + 去年同期參考線（比 Dashboard 卡片大）
  function chart(daily?: number[], ref?: number[]) {
    if (!daily?.length) return null;
    const W = 300, H = 90, n = daily.length;
    const all = [...daily, ...(ref ?? [])];
    const max = Math.max(...all, 1);
    const bw = W / n;
    const fills = barFills(daily);
    const bars = daily.map((v, i) => ({ x: i * bw + bw * 0.15, w: bw * 0.7, h: (v / max) * H, y: H - (v / max) * H, fill: fills[i] }));
    const refLine = ref?.length ? ref.map((v, i) => `${i * bw + bw / 2},${H - (v / max) * H}`).join(' ') : '';
    return { bars, refLine, W, H };
  }
</script>

{#if r && d}
  <article class="detail">
    <header class="dhead">
      <a class="back" href={backHref}>← 戰情總覽</a>
      <h1 class="dt">{r.icon} {r.name} · {hospital.name}</h1>
      <button type="button" class="scn" class:war onclick={() => (scenario = other.id)}>
        {war ? '☀️ ' : '🚨 '}轉{other.label}
      </button>
      <span class="ver">版本 {hospital.version || '—'} · 更新 {roc(hospital.updated)}</span>
    </header>

    <p class="perf">{war ? `⏳ 續航 ${d.endur.days || '—'} · 餘 ${d.endur.pct || '—'}` : (d.perf?.text || '')}</p>

    <!-- 供給端 -->
    <section class="sec">
      <h2>🔌 供給端 <small>誰在供{war ? '・能否自主' : ''}</small></h2>
      <div class="srows">
        {#each d.supply as s}
          <div class="srow" class:off={!s.online} class:abn={s.warn} style="border-left-color:{tone(ESG[s.esg] ?? 'border')}">
            <span class="nm">{s.name}{#if s.autonomous}<span class="tag">自主</span>{/if}</span>
            <span class="vv" class:vlive={s.live === 'ess' && ess?.status === 'live'} class:vdemo={s.live === 'ess' && ess?.status === 'demo'}>{s.value || '—'}</span>
            <span class="ex">{s.pct || ''}{#if s.react} · {s.react}{/if}{#if !s.online} · 離線{/if}</span>
          </div>
        {/each}
        {#if d.supplySum}<div class="ssum">合計：{d.supplySum}</div>{/if}
      </div>
    </section>

    <!-- 儲存端 -->
    <section class="sec">
      <h2>🔋 儲存端 <small>剩多久{war ? '・夠不夠' : ''}</small></h2>
      <div class="cards">
        {#each d.store as st}
          <div class="stcard" class:crit={st.critical} class:wide={st.metrics?.length} class:mdemo={st.live === 'ess' && ess?.status === 'demo'} class:warn={st.warn}>
            <div class="stn">{st.name}{#if st.critical}<span class="tag crit">關鍵</span>{/if}{#if st.live === 'ess' && ess && ess.status !== 'loading'}<span class="srcbadge" class:demo={ess.status === 'demo'}>● {ess.status === 'live' ? '即時' : '展示資料'}</span>{/if}</div>
            {#if st.flags?.length}
              <div class="stflags">
                {#each st.flags as f}<span class="pill {f.tone}">{f.label}</span>{/each}
              </div>
            {/if}
            {#if st.cap}<div class="strow"><span>容量</span><b>{st.cap}</b></div>{/if}
            <div class="strow"><span>{st.metrics?.length ? 'SOC' : '存量'}</span><b>{st.pct ? st.pct + '%' : '—'}</b></div>
            <div class="bar"><i style="width:{st.pct || 0}%"></i></div>
            <div class="strow"><span>可供</span><b>{st.days || '—'}</b></div>
            {#if st.state}<div class="strow"><span>狀態</span><b>{st.state}</b></div>{/if}
            {#if st.metrics?.length}
              <!-- 儀表板格點：標籤 secondary／數值 semibold＋tabular-nums；狀態靠 pills，數值墨色 -->
              <div class="stgrid">
                {#each st.metrics as m}
                  <div class="stcell"><span class="sk">{m.k}</span><span class="sv">{m.v}</span></div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </section>

    <!-- 使用端：完整攤開、不輪播、大圖 -->
    <section class="sec">
      <h2>⚙️ 使用端 <small>{war ? '維生優先・可卸載' : '分項・每日趨勢・去年同期對比'}</small></h2>
      <div class="ucards">
        {#each d.use.blocks as b}
          {@const c = chart(b.daily, b.lastYearDaily)}
          <div class="ucard" class:crit={b.critical} style="border-top-color:{tone(b.color ?? 'chart-1')}">
            <div class="uh"><span class="un">{b.name}{#if b.critical}<span class="tag crit">維生</span>{/if}</span><span class="up">佔總量 {b.pctOfTotal || '—'}</span></div>
            <div class="unums"><span><em>去年同期</em><b>{b.lastYear || '—'}</b></span><span class="now"><em>現況電表</em><b>{b.current || '—'}{#if b.unit} {b.unit}{/if}</b></span></div>
            <div class="ubox">
              {#if c}
                <svg viewBox="0 0 {c.W} {c.H}" preserveAspectRatio="none" aria-hidden="true">
                  {#each c.bars as bar}<rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.fill} />{/each}
                  {#if c.refLine}<polyline points={c.refLine} class="ref" />{/if}
                </svg>
              {:else}<span class="nodata">每日統計 · 待盤點</span>{/if}
            </div>
          </div>
        {/each}
      </div>
    </section>

    <!-- 設備層具名清單（有資料才顯示）：每台一條滿版列＝左 即時訊息／中 趨勢圖／右 維護者 -->
    {#if r.devices?.length}
      <section class="sec">
        <h2>🛠️ 設備清單 <small>左 即時訊息 ・ 中 趨勢 ・ 右 維護者（出問題找誰）</small></h2>
        <div class="devrows">
          {#each devices as v}
            {@const c = chart(v.daily, v.refDaily)}
            <div class="devrow">
              <div class="dz dleft">
                <div class="dname">{v.name}{#if v.system} <small>{v.system}</small>{/if}</div>
                {#if v.loc}<div class="dloc">📍 {v.loc}</div>{/if}
                <div class="dmeta">
                  {#if v.status}<span class="dstatus">{v.status}</span>{/if}
                  {#if v.live === 'ess' && ess && ess.status !== 'loading'}<span class="srcbadge" class:demo={ess.status === 'demo'}>● {ess.status === 'live' ? '即時' : '展示資料'}</span>{/if}
                  {#if v.reading}<span class="dreading" class:vlive={v.live === 'ess' && ess?.status === 'live'} class:vdemo={v.live === 'ess' && ess?.status === 'demo'}>{v.reading}</span>{/if}
                </div>
              </div>
              <div class="dz dmid">
                {#if c}
                  <svg viewBox="0 0 {c.W} {c.H}" preserveAspectRatio="none" aria-hidden="true">
                    {#each c.bars as bar}<rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.fill} />{/each}
                    {#if c.refLine}<polyline points={c.refLine} class="ref" />{/if}
                  </svg>
                {:else}<span class="nodata">趨勢資料待盤點</span>{/if}
              </div>
              <div class="dz dright">
                <div class="drlabel">維護權責</div>
                <div class="drrow"><span>管理人</span><b>{v.manager || '—'}</b></div>
                <div class="drrow"><span>聯絡</span><b>{v.contact || '—'}</b></div>
                <div class="drrow"><span>維護廠商</span><b>{v.vendor || '—'}</b></div>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </article>
{:else}
  <article class="detail"><a class="back" href={backHref}>← 戰情總覽</a><p class="perf">找不到此資源。</p></article>
{/if}

<style>
  .detail { max-width: 1100px; margin: 0 auto; padding: var(--space-md) var(--container-pad) var(--space-xl); }
  .dhead { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; border-bottom: 2px solid var(--color-border); padding-bottom: var(--space-sm); margin-bottom: var(--space-sm); }
  .back { font-size: var(--text-sm); font-weight: 700; color: var(--color-primary); text-decoration: none; padding: 4px 10px; border: 1px solid var(--color-primary); border-radius: var(--radius-sm); }
  .dt { font-size: var(--text-2xl); font-weight: 800; margin: 0; flex: 1; min-width: 0; }
  .scn { font-size: var(--text-sm); font-weight: 700; padding: 0.4rem 1rem; border-radius: var(--radius-md); border: 2px solid var(--color-text-secondary); background: var(--color-surface); color: var(--color-text-secondary); cursor: pointer; }
  .scn.war { border-color: var(--color-alert); background: var(--color-alert); color: var(--color-paper); }
  .ver { font-size: var(--text-xs); color: var(--color-text-secondary); width: 100%; }
  .perf { font-size: var(--text-lg); font-weight: 700; color: var(--color-text); margin: 0 0 var(--space-md); }

  .sec { margin-bottom: var(--space-lg); }
  .sec h2 { font-size: var(--text-lg); font-weight: 800; color: var(--color-primary); border-bottom: 1px solid var(--color-border); padding-bottom: 4px; margin: 0 0 var(--space-sm); }
  .sec h2 small { font-size: var(--text-sm); font-weight: 400; color: var(--color-text-secondary); }

  .srows { display: flex; flex-direction: column; gap: 6px; }
  .srow { display: grid; grid-template-columns: 1.4fr 1fr 1.2fr; align-items: center; gap: 10px; font-size: var(--text-base); padding: 8px 12px; border-left: 6px solid var(--color-border); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; background: color-mix(in oklch, var(--color-accent) 8%, transparent); }
  .srow.off { background: var(--color-surface); color: var(--color-text-secondary); }
  .srow.abn { background: color-mix(in oklch, var(--color-alert) 18%, var(--color-paper)); border-left-color: var(--color-alert); }
  .srow .nm { font-weight: 700; } .srow .vv { font-weight: 800; } .srow .ex { font-size: var(--text-sm); color: var(--color-text-secondary); text-align: right; }
  .ssum { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); padding: 6px 12px; border-top: 2px solid var(--color-border); margin-top: 2px; }
  .tag { font-size: var(--text-xs); font-weight: 700; color: var(--color-accent); border: 1px solid var(--color-accent); border-radius: var(--radius-sm); padding: 0 5px; margin-left: 6px; white-space: nowrap; }
  .tag.crit { color: var(--color-paper); background: var(--color-alert); border-color: var(--color-alert); }

  .cards { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
  .stcard { flex: 1 1 200px; max-width: 280px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-sm) var(--space-md); }
  .stcard.warn, .stcard.crit { border-color: var(--color-alert); }
  .stn { font-size: var(--text-base); font-weight: 800; margin-bottom: 6px; }
  .strow { display: flex; justify-content: space-between; font-size: var(--text-sm); color: var(--color-text-secondary); padding: 2px 0; }
  .strow b { color: var(--color-text); font-weight: 700; }
  .stcard .bar { height: 10px; background: var(--color-paper); border: 1px solid var(--color-border); border-radius: 99px; overflow: hidden; margin: 3px 0; }
  .stcard .bar i { display: block; height: 100%; background: var(--color-primary); }
  .stcard.warn .bar i, .stcard.crit .bar i { background: var(--color-alert); }
  /* ── 儀表板卡（智慧儲存設備）：pills＋標籤/數值格點；數值墨色、狀態靠 pill ── */
  .stcard.wide { max-width: 420px; flex: 1.6 1 280px; }
  .stflags { display: flex; flex-wrap: wrap; gap: 5px; margin: 2px 0 4px; }
  .pill { font-size: var(--text-xs); font-weight: 700; line-height: 1.5; padding: 0 8px; border-radius: 99px; border: 1px solid var(--color-border); color: var(--color-text-secondary); background: var(--color-paper); white-space: nowrap; }
  .pill.ok { color: var(--color-accent); border-color: var(--color-accent); background: color-mix(in oklch, var(--color-accent) 10%, transparent); }
  .pill.warn { color: var(--color-energy); border-color: var(--color-energy); background: color-mix(in oklch, var(--color-energy) 12%, transparent); }
  .pill.alert { color: var(--color-alert); border-color: var(--color-alert); background: color-mix(in oklch, var(--color-alert) 12%, transparent); }
  .stgrid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; margin-top: 5px; padding-top: 4px; border-top: 1px dashed var(--color-border); }
  .stcell { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 2px 0; border-bottom: 1px dashed color-mix(in oklch, var(--color-border) 55%, transparent); }
  .stcell .sk { font-size: var(--text-xs); color: var(--color-text-secondary); white-space: nowrap; }
  .stcell .sv { font-size: var(--text-sm); font-weight: 700; color: var(--color-text); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stcard.mdemo { background: color-mix(in oklch, var(--color-energy) 6%, var(--color-surface)); }
  .srcbadge { font-size: var(--text-xs); font-weight: 700; color: var(--color-accent); margin-left: 6px; white-space: nowrap; }
  .srcbadge.demo { color: var(--color-energy); }
  .vv.vlive, .dreading.vlive { color: var(--color-accent); }
  .vv.vdemo, .dreading.vdemo { color: var(--color-energy); }

  .ucards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-sm); }
  .ucard { background: var(--color-surface); border: 1px solid var(--color-border); border-top: 4px solid var(--color-chart-1); border-radius: var(--radius-md); padding: var(--space-sm) var(--space-md); }
  .ucard.crit { box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--color-alert) 30%, transparent); }
  .uh { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .un { font-size: var(--text-base); font-weight: 800; } .up { font-size: var(--text-sm); color: var(--color-text-secondary); }
  .unums { display: flex; gap: var(--space-lg); margin: 6px 0; }
  .unums em { font-size: var(--text-xs); color: var(--color-text-secondary); font-style: normal; display: block; }
  .unums b { font-size: var(--text-lg); } .unums .now b { color: var(--color-primary); }
  .ubox { height: 90px; } .ubox svg { width: 100%; height: 100%; display: block; }
  .ubox .ref { fill: none; stroke: var(--color-text-secondary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .nodata { font-size: var(--text-sm); color: var(--color-text-secondary); font-style: italic; }

  /* 設備：每台一條滿版列(左 即時/中 趨勢/右 維護者) */
  .devrows { display: flex; flex-direction: column; gap: var(--space-sm); }
  .devrow { width: 100%; display: grid; grid-template-columns: minmax(180px, 1.1fr) minmax(0, 2fr) minmax(190px, 1.1fr); gap: var(--space-md); align-items: stretch; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-sm) var(--space-md); }
  .dz { min-width: 0; }
  .dleft { display: flex; flex-direction: column; gap: 4px; }
  .dname { font-size: var(--text-base); font-weight: 800; }
  .dname small { font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }
  .dloc { font-size: var(--text-sm); color: var(--color-text-secondary); }
  .dmeta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
  .dstatus { font-size: var(--text-xs); font-weight: 700; color: var(--color-energy); background: color-mix(in oklch, var(--color-energy) 14%, transparent); border: 1px solid var(--color-energy); border-radius: var(--radius-sm); padding: 1px 7px; }
  .dreading { font-size: var(--text-sm); font-weight: 800; color: var(--color-primary); }
  .dmid { display: flex; align-items: center; justify-content: center; border-left: 1px dashed var(--color-border); border-right: 1px dashed var(--color-border); padding: 0 var(--space-sm); min-height: 64px; }
  .dmid svg { width: 100%; height: 64px; display: block; }
  .dmid .ref { fill: none; stroke: var(--color-text-secondary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .dright { display: flex; flex-direction: column; gap: 3px; }
  .drlabel { font-size: var(--text-xs); font-weight: 700; color: var(--color-text-secondary); }
  .drrow { display: flex; justify-content: space-between; gap: 8px; font-size: var(--text-sm); }
  .drrow span { color: var(--color-text-secondary); } .drrow b { font-weight: 700; text-align: right; }
  @media (max-width: 640px) { .devrow { grid-template-columns: 1fr; } .dmid { border: 0; border-top: 1px dashed var(--color-border); border-bottom: 1px dashed var(--color-border); padding: var(--space-xs) 0; } }
</style>
