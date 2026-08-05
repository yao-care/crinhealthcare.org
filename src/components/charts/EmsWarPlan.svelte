<script lang="ts">
  // 戰時 B1 開設配置圖（全螢幕一頁）＋ 行動儲電櫃供電。
  // 幾何全部來自 JSON（zones 以畫布百分比定位、斜帶用 rot 旋轉），元件只負責畫與算。
  // 單一計算源：總負載／各區用電／負載率／裕度／續航 一律由 power.loads[].parts 推導，JSON 不存彙總值。
  interface Zone { id: string; label: string; kind: string; x: number; y: number; w: number; h: number; rot?: number; sub?: string; star?: boolean; }
  interface Legend { label: string; kind: string; }
  interface Vid { id: string; label?: string; src?: string; at?: number; sec?: number; poster?: string; }
  interface Plan { title?: string; sub?: string; zones: Zone[]; legend?: Legend[]; videos?: Vid[]; }
  import { flip } from 'svelte/animate';
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
  // 各區的機動電源（儲電行李箱／氫能拉桿箱…）：圖上該區掛 🔋 標記，一眼看出誰有專屬電源
  const mobiles = $derived(power?.mobile ?? []);
  const mobKwh = (m: { kwh?: number; qty?: number }) => (m.kwh ?? 0) * (m.qty ?? 1);
  const zoneMobile = $derived.by(() => {
    const m = new Map<string, string[]>();
    for (const x of mobiles) {
      if (!x.zone) continue;
      const list = m.get(x.zone) ?? [];
      list.push(`${x.name} ×${x.qty ?? 1}${x.kwh ? ` · ${mobKwh(x)} kWh` : ''}`);
      m.set(x.zone, list);
    }
    return m;
  });
  // 機動電源已知容量合計（各自獨立供電，不併入儲電櫃續航——併起來算會失真）
  const mobTotalKwh = $derived(mobiles.reduce((s, m) => s + mobKwh(m), 0));
  const mobPending = $derived(mobiles.filter((m) => !m.kwh).length);

  // 現場電源盤點：每一台（機動電源同型併一張）都是一張卡，環圈＝占現場可用電量比例。
  // 這份就是側欄上半的全部內容，下面不再重複列一次表。
  const sources = $derived.by(() => {
    const rows: { name: string; qty: number; kwh: number; spec: string; use: string; state: string; main: boolean }[] = [];
    for (const c of cabs) {
      rows.push({
        name: c.name.replace('行動儲電櫃 ', ''),
        qty: 1,
        kwh: (c.kwh * usablePct) / 100,
        spec: `可放電 ${usablePct}%／額定 ${c.kwh} kWh · 輸出 ${c.kw} kW`,
        use: c.loc ?? '',
        state: c.state ?? '',
        main: true,
      });
    }
    const byName = new Map<string, { qty: number; kwh: number; kw: number; out: string; uses: string[] }>();
    for (const m of mobiles) {
      const g = byName.get(m.name) ?? { qty: 0, kwh: 0, kw: m.kw ?? 0, out: m.out ?? '', uses: [] };
      g.qty += m.qty ?? 1;
      g.kwh += mobKwh(m);
      if (m.use) g.uses.push(`${m.use}×${m.qty ?? 1}`);
      byName.set(m.name, g);
    }
    for (const [name, g] of byName) {
      rows.push({
        name: `${name} ×${g.qty}`,
        qty: g.qty,
        kwh: g.kwh,
        spec: g.kwh ? `單台 ${(g.kwh / g.qty).toFixed(1)} kWh · ${g.kw} kW${g.out ? ' · ' + g.out : ''}` : '規格待補',
        use: g.uses.join(' · '),
        state: '',
        main: false,
      });
    }
    return rows;
  });
  const siteKwh = $derived(sources.reduce((s, r) => s + r.kwh, 0));
  const maxSrcKwh = $derived(Math.max(...sources.map((s) => s.kwh), 1));
  // 大字卡：天數為主、餘下小時為輔（不足一天就以小時當主角）
  const endurDays = $derived(Math.floor(hours / 24));
  const endurRestH = $derived(Math.round(hours - endurDays * 24));
  // 現場影片輪播：閃 3 下 → zoom 到中央 → 播完淡出 → 間隔 GAP 再換下一支
  const FLASH_MS = 900, ZOOM_MS = 600, FADE_MS = 500, GAP_MS = 4500, PH_PLAY_MS = 5000;
  // 佇列顯示：原始清單依 rot 旋轉（rot 只在狀態機裡遞增）。
  // ⚠️ 狀態機不可依賴 queue —— 在效果內改 queue 會讓效果自我重啟，播放台永遠活不到 zoom。
  const vids = $derived(plan.videos ?? []);
  let rot = $state(0);
  const queue = $derived.by(() => {
    const n = vids.length;
    if (!n) return [] as Vid[];
    const k = rot % n;
    return [...vids.slice(k), ...vids.slice(0, k)];
  });
  const cur = $derived(queue[0]);
  let playing = $state<Vid | null>(null);
  let phase = $state<'idle' | 'flash' | 'zoom' | 'play' | 'fade'>('idle');
  let stage = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  let stageOn = $state(false);
  let qEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLDivElement | null = $state(null);
  let vidEl: HTMLVideoElement | null = $state(null);

  // 一支影片的完整週期：閃 3 下 → zoom 到中央（同時下方影片往上推）→ 播 → 淡出 → 間隔 4.5 秒
  $effect(() => {
    const list = plan.videos ?? [];   // 唯一依賴：資料本身
    if (!list.length) return;
    let alive = true;
    let i = 0;
    const t: number[] = [];
    const wait = (ms: number) => new Promise<void>((r) => t.push(window.setTimeout(r, ms)));
    (async () => {
      while (alive) {
        phase = 'flash';
        await wait(FLASH_MS);
        if (!alive) return;
        // zoom 起點＝佇列第一格當下的位置，終點是畫布中央（避開左上大字卡與右下佇列）
        const item = qEl?.querySelector('.vit') as HTMLElement | null;
        const box = canvasEl?.getBoundingClientRect();
        const r = item?.getBoundingClientRect();
        if (r && box) stage = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
        playing = list[i % list.length];
        rot = i + 1;                       // 下方影片往上推（flip 動畫）
        phase = 'zoom';
        stageOn = false;
        await wait(30);
        if (!alive) return;
        stageOn = true;                    // 觸發 transition
        await wait(ZOOM_MS);
        if (!alive) return;
        phase = 'play';                    // 效果完成後才開始播
        await new Promise<void>((res) => {
          const el = vidEl;
          if (!playing?.src || !el) return void t.push(window.setTimeout(res, PH_PLAY_MS));
          const cap = (playing.sec ?? 0) * 1000;
          el.currentTime = 0;
          el.play().catch(() => {});
          el.addEventListener('ended', () => res(), { once: true });
          if (cap) t.push(window.setTimeout(res, cap));
        });
        if (!alive) return;
        phase = 'fade';
        await wait(FADE_MS);
        if (!alive) return;
        phase = 'idle';
        stage = null;
        playing = null;
        i += 1;
        await wait(GAP_MS);                // 淡出完成後才起算的間隔
      }
    })();
    return () => { alive = false; t.forEach(clearTimeout); };
  });

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
      <button type="button" class="toboard" onclick={onBoard}>📊 水·油·氣·環境</button>
    </div>
    <div class="canvasbox">
      <div class="canvas" bind:this={canvasEl}>
        {#if sum}
          <!-- 續航大字卡：戰情室第一眼要看到的數，放畫布左上角 -->
          <div class="endcard">
            <div class="ecap">基本維生<br />供電可維持</div>
            {#if endurDays >= 1}
              <div class="enum">{endurDays}</div><div class="eunit">天</div>
              {#if endurRestH}<div class="esub">＋{endurRestH} 小時</div>{/if}
            {:else}
              <div class="enum">{Math.round(hours)}</div><div class="eunit">小時</div>
            {/if}
            <div class="esub2">負載 {totalKw.toFixed(2)} kW · 可用 {usableKwh} kWh</div>
          </div>
        {/if}
        {#each plan.zones as z}
          {@const w = zoneW.get(z.id) ?? 0}
          <div
            class="zone k-{z.kind}"
            class:rot={!!z.rot}
            style="left:{z.x}%; top:{z.y}%; width:{z.w}%; height:{z.h}%;{z.rot ? ` transform:rotate(${z.rot}deg);` : ''}"
          >
            <span class="zl">{z.label}{#if z.star}<i class="star">★</i>{/if}</span>
            {#if z.sub}<span class="zs">{z.sub}</span>{/if}
            {#if zoneMobile.get(z.id)}<span class="zmob" title={zoneMobile.get(z.id)?.join(' · ')}>🔋 {zoneMobile.get(z.id)?.length === 1 ? zoneMobile.get(z.id)?.[0] : zoneMobile.get(z.id)?.join(' · ')}</span>{/if}
            {#if w > 0}<span class="zkw">⚡ {kw1(w)} kW</span>{/if}
          </div>
        {/each}
        {#if queue.length}
          <!-- 影片佇列（右下）：最上面那支要播時外框閃 3 下，播完排到最後、其餘往上遞補 -->
          <div class="vq" bind:this={qEl}>
            {#each queue as v (v.id)}
              <div class="vit" class:flash={phase === 'flash' && v.id === cur?.id} animate:flip={{ duration: 400 }}>
                {#if v.poster}
                  <!-- 佇列用事先抽好的靜態縮圖：用 <video preload=metadata> 會把整支影片載下來，
                       三支同時載會把播放台的載入排在後面（實測播放台卡在 readyState 0） -->
                  <img src={v.poster} alt="{v.label} 縮圖" />
                {/if}
                <span class="vcap">{v.label}</span>
              </div>
            {/each}
          </div>
          <!-- 播放台：由縮圖位置 zoom 到中央，播完淡出露出配置圖 -->
          {#if stage && phase !== 'idle' && phase !== 'flash'}
            <div
              class="vstage"
              class:on={stageOn}
              class:fade={phase === 'fade'}
              style="--x0:{stage.x}px; --y0:{stage.y}px; --w0:{stage.w}px; --h0:{stage.h}px;"
            >
              {#if playing?.src}
                <video bind:this={vidEl} src={playing.src} muted playsinline></video>
              {/if}
              <span class="vcap big">{playing?.label}</span>
            </div>
          {/if}
        {/if}
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
      <div class="pwr-h">⚡ 戰時供電 · 現場電源盤點<small class="ttlsub">{power.title.replace("⚡ 戰時供電 · ", "")}</small>{#if power.note}<small>{power.note}</small>{/if}</div>

      <!-- 現場電源盤點（橫式）：一列一個電源，長條＝可用電量、共用同一把尺。
           不畫「占總量百分比」——設備都是滿電，用比例環圈會被讀成「只剩一點點電」。 -->
      <div class="srcs">
        <div class="srch">現場可用電量 <b>{siteKwh.toFixed(1)} kWh</b><small>以滿電計 · 儲電櫃 {usableKwh} ＋ 機動 {mobTotalKwh.toFixed(1)}</small></div>
        {#each sources as s, i}
          <div class="src" class:main={s.main}>
            <div class="srow1">
              <span class="sname">{s.name}{#if s.main}<b class="tag">主力</b>{/if}</span>
              <span class="skwh">{s.kwh.toFixed(1)}<small>kWh</small></span>
            </div>
            <div class="sbar"><i class="seg s{i % 4}" style="width:{(s.kwh / maxSrcKwh) * 100}%"></i></div>
            <div class="smeta">{s.spec}{#if s.use} · 📍{s.use}{/if}{#if s.state} · <b>{s.state}</b>{/if}</div>
          </div>
        {/each}
      </div>

      <!-- 捲動區＝用電設備；放不下才自動輪播（放得下完全不動） -->
      <div class="loads" use:carousel>
        <div class="lh"><span>用電設備</span><span class="lhq">數量</span><span class="lhk">用電</span></div>
        {#each loads as l, i}
          {@const w = loadW(l)}
          <div class="lrow">
            <div class="ltop"><span class="ln">{l.name}</span><span class="lq">{qtyText(l)}</span><span class="lk">{kw1(w)} kW</span></div>
            <div class="lbar"><i style="width:{maxLoadW ? (w / maxLoadW) * 100 : 0}%; background:{fills[i]}"></i></div>
            <div class="ldet">{l.parts.map((p) => (p.flat ? `${p.n}（${p.w} W）` : `${p.n} ×${p.qty}（${p.w} W）`)).join(' · ')}</div>
          </div>
        {/each}
      </div>
      <!-- 平均總負載釘在清單外：項目多到要輪播時，這個數字仍要一直看得到 -->
      <div class="lrow tot"><div class="ltop"><span class="ln">平均總負載</span><span class="lq"></span><span class="lk">{totalKw.toFixed(2)} kW</span></div></div>

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
          <div class="tlrow"><span class="tlcap">依現況可用<em>儲電櫃 {usableKwh} kWh</em></span><b class="tlbig">{endurText(hours)}</b></div>
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

  .zone { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; text-align: center; border: 2px solid var(--color-border); border-radius: var(--radius-sm); padding: 1px 3px; overflow: hidden; }
  /* 區塊字級跟著「畫布」縮（cqw），不是跟著視窗（vw）——兩者脫鉤時，
     筆電視窗下畫布變小、字沒跟著小，區塊就會爆字（1440 實測過）。 */
  .zl { font-size: clamp(8px, 1.25cqw, 18px); font-weight: 700; line-height: 1.15; }
  .zs { font-size: clamp(7px, 1cqw, 15px); line-height: 1.15; color: var(--color-text-secondary); overflow-wrap: anywhere; }
  /* 用電徽章脫離文字流（貼右下角），小區塊才不會被它擠爆 */
  .zmob { margin-top: 1px; font-size: clamp(7px, 0.95cqw, 14px); font-weight: 700; color: var(--color-text); background: color-mix(in oklab, var(--color-chart-4) 22%, var(--color-paper)); border: 1px solid var(--color-chart-4); border-radius: var(--radius-sm); padding: 0 4px; line-height: 1.2; max-width: 96%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

  /* 續航大字卡（畫布左上）：戰情室第一眼要看到的數 */
  .endcard { position: absolute; left: 1.2%; top: 1.5%; z-index: 3; display: flex; flex-direction: column; align-items: center; padding: 4px 10px 6px; border: 2px solid var(--color-energy); border-radius: var(--radius-md); background: color-mix(in oklab, var(--color-energy) 22%, var(--color-paper)); }
  .ecap { font-size: clamp(9px, 1.35cqw, 19px); font-weight: 700; line-height: 1.15; text-align: center; }
  .enum { font-size: clamp(26px, 5.6cqw, 84px); font-weight: 800; line-height: 1; }
  .eunit { font-size: clamp(10px, 1.5cqw, 21px); font-weight: 700; line-height: 1.1; }
  .esub { font-size: clamp(8px, 1.05cqw, 15px); font-weight: 700; color: var(--color-text-secondary); }
  .esub2 { font-size: clamp(7px, 0.95cqw, 13px); color: var(--color-text-secondary); margin-top: 1px; }

  /* 影片佇列（畫布右下）：縮圖定格在指定秒數、畫面靠右對齊 */
  .vq { position: absolute; right: 1.2%; bottom: 1.5%; z-index: 3; width: 17%; display: flex; flex-direction: column; gap: 5px; }
  .vit { position: relative; aspect-ratio: 16 / 10; border: 2px solid var(--color-energy); border-radius: var(--radius-sm); background: color-mix(in oklab, var(--color-energy) 18%, var(--color-paper)); overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .vit img { width: 100%; height: 100%; object-fit: cover; object-position: right center; }
  /* 輪到它要播：外框閃 3 下（0.3s×3＝0.9s，與 FLASH_MS 對齊） */
  .vit.flash { animation: vflash 0.3s steps(1) 3; }
  @keyframes vflash {
    0%, 49% { border-color: var(--color-alert); box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-alert) 45%, transparent); }
    50%, 100% { border-color: var(--color-energy); box-shadow: none; }
  }
  .vcap { position: absolute; left: 0; right: 0; bottom: 0; padding: 1px 4px; font-size: clamp(7px, 0.95cqw, 14px); font-weight: 700; line-height: 1.25; text-align: center; color: var(--color-paper); background: color-mix(in oklab, var(--color-text) 62%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vph { font-size: clamp(9px, 1.3cqw, 18px); font-weight: 700; color: var(--color-text-secondary); }

  /* 播放台：由縮圖位置 zoom 到畫布中央，播完淡出露出配置圖 */
  .vstage { position: absolute; z-index: 4; left: var(--x0); top: var(--y0); width: var(--w0); height: var(--h0); border: 2px solid var(--color-energy); border-radius: var(--radius-md); overflow: hidden; background: var(--color-text); display: flex; align-items: center; justify-content: center; transition: left 0.6s cubic-bezier(0.22, 1, 0.36, 1), top 0.6s cubic-bezier(0.22, 1, 0.36, 1), width 0.6s cubic-bezier(0.22, 1, 0.36, 1), height 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.5s ease; }
  .vstage.on { left: 7%; top: 22%; width: 68%; height: 74%; }
  .vstage.fade { opacity: 0; }
  .vstage video { width: 100%; height: 100%; object-fit: contain; }
  .vstage .vcap.big { font-size: clamp(11px, 1.8cqw, 26px); padding: 3px 8px; }
  @media (prefers-reduced-motion: reduce) {
    .vit.flash { animation: none; }
    .vstage { transition: opacity 0.5s ease; }
  }

  .legend { display: flex; flex-wrap: wrap; gap: 4px var(--space-sm); align-items: center; padding-top: 3px; border-top: 1px dashed var(--color-border); }
  .lg { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .sw { width: 14px; height: 10px; border-radius: 2px; border: 1px solid var(--color-border); display: inline-block; }

  /* ── 供電側欄 ───────────────────────────────────────── */
  .pwr { container-type: size; width: clamp(240px, 26%, 460px); display: flex; flex-direction: column; gap: var(--space-xs); min-height: 0; border: 2px solid var(--color-accent); border-radius: var(--radius-md); padding: var(--space-xs) var(--space-sm) var(--space-sm); background: var(--color-paper); }
  .pwr-h { font-size: var(--text-base); font-weight: 700; color: var(--color-primary); }
  .pwr-h small { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); }

  /* 現場電源盤點（橫式）：一列一個電源，長條共用同一把尺（最大者滿格）。
     不用比例環圈——設備都是滿電，畫成「占總量 12%」會被讀成只剩一點點電。 */
  .srcs { flex: none; display: flex; flex-direction: column; gap: 2px; }
  .srch { font-size: var(--text-sm); font-weight: 700; color: var(--color-primary); }
  .srch b { color: var(--color-text); }
  .srch small { font-weight: 400; color: var(--color-text-secondary); margin-left: 6px; font-size: var(--text-xs); }
  .src { border-bottom: 1px solid var(--color-border); padding-bottom: 2px; }
  .src.main .sname { color: var(--color-text); }
  .srow1 { display: flex; align-items: baseline; gap: 6px; }
  .sname { flex: 1; font-size: var(--text-sm); font-weight: 700; min-width: 0; }
  .skwh { font-size: var(--text-base); font-weight: 700; white-space: nowrap; }
  .skwh small { font-size: var(--text-xs); font-weight: 400; color: var(--color-text-secondary); margin-left: 2px; }
  .sbar { height: 10px; background: var(--color-surface); border-radius: var(--radius-sm); overflow: hidden; margin: 1px 0; }
  .sbar i { display: block; height: 100%; border-radius: var(--radius-sm); }
  .seg { display: block; height: 100%; }
  .seg.s0 { background: var(--color-accent); }
  .seg.s1 { background: var(--color-chart-4); }
  .seg.s2 { background: var(--color-chart-5); }
  .seg.s3 { background: var(--color-energy); }
  .smeta { font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.25; }
  .smeta b { color: var(--color-accent); font-weight: 700; }
  .tag { font-size: var(--text-xs); font-weight: 700; color: var(--color-paper); background: var(--color-accent); border-radius: var(--radius-sm); padding: 0 5px; margin-left: 5px; }

  /* 逐項負載：名稱/數量/kW 一列，下面接依比例的長條（前三高金銀銅），再一行組成明細 */
  .loads { flex: 1 1 auto; min-height: 5.5em; overflow: hidden; display: flex; flex-direction: column; gap: 2px; }
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
  /* 卡片環圈色序與下方電量組成長條同一組（s0–s3），一眼對得起來 */
  .dval.s1 { stroke: var(--color-chart-4); }
  .dval.s2 { stroke: var(--color-chart-5); }
  .dval.s3 { stroke: var(--color-energy); }
  .dnum { fill: var(--color-text); font-weight: 700; }
  .dcap { fill: var(--color-text-secondary); }
  .gtxt { flex: 1; min-width: 0; }
  .grow { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-sm); }
  .grow span { color: var(--color-text-secondary); }
  .grow b { font-weight: 700; }
  .tl { margin-top: 3px; }
  .tlrow { display: flex; justify-content: space-between; align-items: baseline; }
  .tlcap { font-size: var(--text-sm); font-weight: 700; }
  .tlcap em { font-style: normal; font-weight: 400; font-size: var(--text-xs); color: var(--color-text-secondary); margin-left: 5px; }
  .tlbig { font-size: var(--text-xl); font-weight: 700; color: var(--color-alert); }
  .tlbar { position: relative; height: 14px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
  .tlbar .ref { position: absolute; top: 0; bottom: 0; background: color-mix(in oklab, var(--color-text-secondary) 22%, var(--color-paper)); }
  .tlbar i { position: relative; display: block; height: 100%; background: var(--color-accent); }
  .tlticks { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--color-text-secondary); }

  /* 側欄放不下時的收合順序：先收各項組成明細，再收時間軸刻度（數字與圖形一律留著） */
  /* 側欄放不下時的收合順序：規格待補標籤 → 櫃體重複的文字規格 → 各項組成明細 → 時間軸刻度。
     被收的都是「畫面別處或環圈已經有」的資訊，數字與圖形一律留著。 */
  @container (max-height: 900px) { .smeta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
  @container (max-height: 860px) { .srch small { display: none; } .loads { min-height: 4em; } .sbar { height: 7px; margin: 0; } .srcs { gap: 0; } .src { padding-bottom: 1px; } .skwh { font-size: var(--text-sm); } }
  @container (max-height: 860px) { .ldet { display: none; } }
  @container (max-height: 760px) { .loads { min-height: 4.5em; } .smeta { display: none; } }
  @container (max-height: 720px) { .tlticks { display: none; } .pwr-h small { display: none; } }

  @media (max-width: 900px) {
    .warplan { flex-direction: column; }
    .pwr { width: auto; }
    /* 手機：畫布只剩幾百 px，區塊連區名都快放不下 → 只留區名，
       說明與各區用電改看下方供電表（同一份資料，不漏內容） */
    .zs, .zkw { display: none; }
    .zone:has(.zkw) { padding-bottom: 2px; }
  }
</style>
