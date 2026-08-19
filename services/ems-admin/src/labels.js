// 欄位中文名稱／說明／建議值 —— 以「路徑」為鍵，不是以「鍵名」為鍵。
//
// 為什麼要用路徑：同一個鍵名在不同位置意思完全不同。最明顯的是 pct——
//   resources[].@.supply[].pct  是自由文字（實際內容例：「插座110/220V · 82.6h」）
//   resources[].@.store[].pct   是 0–100 的數字（電量百分比）
// 舊版用扁平的 key→中文對照，兩者都標成「百分比」，院方看到「百分比: 插座110/220V」。
//
// 路徑寫法：物件用 .、陣列項目用 []，情境分支 peace/war 統一寫成 @（見 canonical()）。
// 沒對到的路徑會退回「鍵名通用表」FALLBACK，再退回鍵名本身。

// resources[].peace / resources[].war、env.peace / env.war 兩組結構完全相同，底下的欄位合併成 @。
// 只在後面還有欄位時才改寫——peace/war 這兩節本身要保留原路徑，才拿得到「平時」「戰時/救災」。
export function canonical(path) {
  return path
    .replace(/^resources\[\]\.(peace|war)\./, 'resources[].@.')
    .replace(/^env\.(peace|war)\./, 'env.@.');
}

// ── 欄位分層（決定「常用欄位」模式要顯示什麼）──
//
// 院方的抱怨是「我只想改幾個數字，為什麼要看到色票和座標」。803 一份 JSON 會長出約 1,570 個欄位，
// 其中約 257 個是機器代碼與座標。分成三層，預設只顯示第 1 層：
//   1 常用：日常會更新的讀值、狀態、日期
//   2 設定：名稱、標題、說明、單位——會改但不常改
//   3 勿動：機器代碼與座標（id / 色票 / kind / live / x,y,w,h,rot / tone / zone…）
//
// 預設用「鍵名」判層（同名的欄位意思通常一樣），少數例外在下面的 P 表用 t: 明寫覆蓋。
const TIER1_KEYS = new Set([
  'value', 'reading', 'status', 'current', 'lastYear', 'pctOfTotal', 'daily', 'lastYearDaily', 'refDaily',
  'days', 'cap', 'state', 'temp', 'rh', 'co2', 'updated', 'supplySum', 'text', 'online', 'critical',
  'pending', 'cells', 'v',
]);
const TIER3_KEYS = new Set([
  'id', 'icon', 'color', 'kind', 'live', 'esg', 'tone', 'layout', 'x', 'y', 'w', 'h', 'rot',
  'star', 'zone', 'flat', 'at', 'sec', 'poster', 'src', 'usablePct', 'autonomous', 'essential', 'compare',
]);
const tierOf = (key) => (TIER1_KEYS.has(key) ? 1 : TIER3_KEYS.has(key) ? 3 : 2);

// label：欄位名稱｜hint：灰字說明｜suggest：datalist 建議值｜t：分層（覆蓋鍵名判斷）
// where：這個欄位顯示在看板的哪裡（回答「我不知道哪個欄位對應看板上哪一塊」）
const P = {
  // ── 基本資料 ──
  name: { label: '院所名稱' },
  boardTitle: { label: '看板抬頭', hint: '留空＝自動用「院名 🔋 韌性電網決策支援系統」' },
  location: { label: '地點', hint: '例：臺中市太平區' },
  updated: { label: '資料更新日', hint: '西元 YYYY-MM-DD' },
  version: { label: '版本標記', hint: '顯示在看板頁尾，例：v1' },
  hideMeta: { label: '隱藏版本與更新日', hint: '勾選後看板不顯示上面兩欄' },
  liveData: { label: '啟用即時資料', hint: '由 ems-bridge 供給即時值；未接實機請勿勾選' },
  layout: { label: '看板版面', hint: 'v2 為現行版面' },
  show: { label: '顯示的資源區塊', hint: '不勾選＝看板不顯示該區塊' },
  peakShave: { label: '顯示削峰填谷區' },
  peakShaveHide: { label: '削峰填谷要隱藏的 chip', hint: '每行一個 chip 標題' },
  scenarios: { label: '情境頁籤' },
  'scenarios[].id': { label: '代碼', hint: 'peace＝平時、war＝戰時，請勿更動', suggest: ['peace', 'war'] },
  'scenarios[].label': { label: '頁籤顯示名稱' },

  // ── 資源區塊 ──
  resources: { label: '資源區塊' },
  'resources[].id': { label: '代碼', hint: '對應看板區塊，請勿更動', suggest: ['power', 'water', 'oil', 'gas'] },
  'resources[].icon': { label: '圖示', suggest: ['⚡', '💧', '⛽', '🔥'] },
  'resources[].name': { label: '顯示名稱' },
  'resources[].peace': { label: '平時' },
  'resources[].war': { label: '戰時/救災' },

  // 效能摘要
  'resources[].@.perf': { label: '效能摘要（折線圖）' },
  'resources[].@.perf.act': { label: '實際值序列' },
  'resources[].@.perf.fc': { label: '預測值序列' },
  'resources[].@.perf.base': { label: '基準線' },
  'resources[].@.perf.warn': { label: '警戒線' },
  'resources[].@.perf.text': { label: '摘要文字', t: 1, where: '平時：資源區塊標題列的右側灰字', hint: '例：用電 6,302,756 度 · 電力碳排 2,988 t' },

  // 續航
  'resources[].@.endur': { label: '續航' },
  'resources[].@.endur.days': { label: '可撐天數', hint: '文字，例：3.2 天', t: 1, where: '戰時：資源區塊標題列右側「⏳ 撐 ○ · 餘 ○」的前半' },
  'resources[].@.endur.pct': { label: '存量百分比', hint: '文字，例：78%（低於 30% 會標紅）', t: 1, where: '戰時：標題列「⏳ 撐 ○ · 餘 ○」的後半' },
  'resources[].@.endur.live': { label: '即時來源代碼', hint: '留空＝不接即時資料' },

  // 供給端
  'resources[].@.supply': { label: '供給端', where: '資源區塊左上角「🔌 供給端」那一欄' },
  'resources[].@.supply[].name': { label: '來源名稱', where: '供給端每一列的左半' },
  'resources[].@.supply[].value': { label: '狀態/數值', hint: '例：供電中、待命、2,150 kW', t: 1, where: '供給端每一列的右半（大字）' },
  'resources[].@.supply[].online': { label: '供應中', t: 1, hint: '取消勾選＝該列在看板上變灰（停供）' },
  'resources[].@.supply[].esg': { label: 'ESG 分類', hint: '決定該列左側色條顏色' },
  'resources[].@.supply[].pct': { label: '容量/說明', hint: '自由文字，例：22.8KV → 急重症大樓', t: 2, where: '平時：接在數值後面的小字' },
  'resources[].@.supply[].react': { label: '反應時間', hint: '例：10 秒內', where: '戰時：接在數值後面的小字' },
  'resources[].@.supply[].autonomous': { label: '可自主供應', hint: '戰時會在名稱旁加「自主」標記' },
  'resources[].@.supply[].warn': { label: '標為異常', t: 1, hint: '勾選＝該列在看板上變紅底' },
  'resources[].@.supply[].live': { label: '即時來源代碼', hint: '留空＝不接即時資料' },
  'resources[].@.supplySum': { label: '供給合計文字', t: 1, where: '供給端最後一列「合計」' },

  // 明細
  'resources[].@.detailLabel': { label: '明細區標題' },
  'resources[].@.detail': { label: '明細' },
  'resources[].@.detail[].name': { label: '項目' },
  'resources[].@.detail[].value': { label: '數值', t: 1 },
  'resources[].@.detail[].warn': { label: '標為異常', t: 1 },

  // 儲存端
  'resources[].@.store': { label: '儲存端', where: '資源區塊左下角「🔋 儲存端」那一欄' },
  'resources[].@.store[].name': { label: '設備名稱', where: '每個儲槽磁磚的標題' },
  'resources[].@.store[].days': { label: '可撐天數', hint: '文字，例：24.5–82.6 h', t: 1, where: '儲槽磁磚左側「續航」下方的大字' },
  'resources[].@.store[].cap': { label: '容量', hint: '文字，例：5,700 kW · 有效油量 13,085 L', t: 1, where: '儲槽磁磚的容量說明' },
  'resources[].@.store[].pct': { label: '存量百分比', hint: '數字 0–100（不含 % 符號）', t: 1, where: '儲槽磁磚的水位條高度與百分比數字' },
  'resources[].@.store[].warn': { label: '標為異常', t: 1, hint: '勾選＝磁磚變黃底' },
  'resources[].@.store[].state': { label: '狀態文字', hint: '例：充電中、放電中', t: 1 },
  'resources[].@.store[].critical': { label: '維生關鍵設備', t: 1, hint: '勾選＝磁磚變紅框' },
  'resources[].@.store[].metrics': { label: '儀表格點', where: '智慧儲能磁磚右側的標籤/數值格' },
  'resources[].@.store[].metrics[].k': { label: '格點名稱' },
  'resources[].@.store[].metrics[].v': { label: '格點數值', t: 1 },
  'resources[].@.store[].flags': { label: '狀態標籤', where: '智慧儲能磁磚右上的狀態 pill' },
  'resources[].@.store[].flags[].label': { label: '標籤文字' },
  'resources[].@.store[].flags[].tone': { label: '顏色' },
  'resources[].@.store[].live': { label: '即時來源代碼', hint: '留空＝不接即時資料' },

  // 使用端
  'resources[].@.use': { label: '使用端', where: '資源區塊右半整欄' },
  'resources[].@.use.headline': { label: '標題', t: 2 },
  'resources[].@.use.sub': { label: '副標', t: 2, where: '使用端欄位最上方的說明字' },
  'resources[].@.use.blocks': { label: '分項卡', where: '使用端欄位裡那一張張的卡片' },
  'resources[].@.use.blocks[].name': { label: '卡片名稱', where: '卡片標題（例：空調、照明）' },
  'resources[].@.use.blocks[].value': { label: '主要數值', t: 1 },
  'resources[].@.use.blocks[].sub': { label: '副標' },
  'resources[].@.use.blocks[].color': { label: '色票', suggest: ['primary', 'accent', 'energy', 'alert', 'text-secondary', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'] },
  'resources[].@.use.blocks[].kind': { label: '卡片型別', hint: 'trend＝走勢圖、status＝狀態清單' },
  'resources[].@.use.blocks[].trend': { label: '走勢圖' },
  'resources[].@.use.blocks[].trend.act': { label: '實際值序列' },
  'resources[].@.use.blocks[].trend.fc': { label: '預測值序列' },
  'resources[].@.use.blocks[].trend.base': { label: '基準線' },
  'resources[].@.use.blocks[].trend.warn': { label: '警戒線' },
  'resources[].@.use.blocks[].segs': { label: '分段條' },
  'resources[].@.use.blocks[].segs[].label': { label: '分段名稱' },
  'resources[].@.use.blocks[].segs[].count': { label: '數量' },
  'resources[].@.use.blocks[].segs[].color': { label: '色票' },
  'resources[].@.use.blocks[].pctOfTotal': { label: '佔總量', hint: '文字，例：53%', t: 1, where: '卡片上的佔比數字' },
  'resources[].@.use.blocks[].lastYear': { label: '去年同期', t: 1 },
  'resources[].@.use.blocks[].current': { label: '現況電表讀值', hint: '例：3,739,418', t: 1, where: '卡片主要數字' },
  'resources[].@.use.blocks[].unit': { label: '單位', suggest: ['kWh', 'kW', '度', 'CMD', 'L', 'm³'] },
  'resources[].@.use.blocks[].daily': { label: '每日數值序列', t: 1, where: '卡片上的長條圖' },
  'resources[].@.use.blocks[].lastYearDaily': { label: '去年每日序列', t: 1, where: '卡片長條圖上的參考線' },
  'resources[].@.use.blocks[].critical': { label: '維生關鍵', t: 1 },
  'resources[].@.use.blocks[].items': { label: '條列項目', t: 1, hint: '戰時收治區型卡片：每行一項（床數、動線、演練時程…）', where: '卡片內容取代電表數字' },
  'resources[].@.use.blocks[].img': { label: '圖片路徑', hint: '相對於網站根目錄，例：/img/803/a.jpg' },
  'resources[].@.use.blocks[].imgs': { label: '輪播圖路徑' },
  'resources[].@.use.blocks[].caption': { label: '圖說' },
  'resources[].@.use.map': { label: '配置圖' },
  'resources[].@.use.map.title': { label: '配置圖標題' },
  'resources[].@.use.map.legend': { label: '圖例說明' },
  'resources[].@.use.map.boxes': { label: '配置方塊' },
  'resources[].@.use.map.boxes[].label': { label: '方塊文字' },
  'resources[].@.use.map.boxes[].kind': { label: '方塊型別', suggest: ['zone', 'core', 'sub'] },
  'resources[].@.use.map.boxes[].star': { label: '標示為固定電源 ★' },

  // 戰時平面配置圖
  'resources[].@.plan': { label: '平面配置圖', hint: '座標是 0–100 的畫布百分比，改動前建議先看過看板效果' },
  'resources[].@.plan.title': { label: '配置圖標題' },
  'resources[].@.plan.sub': { label: '配置圖副標' },
  'resources[].@.plan.zones': { label: '分區方塊' },
  'resources[].@.plan.zones[].id': { label: '分區代碼', hint: '供電規劃的「所屬分區」要對到這個代碼' },
  'resources[].@.plan.zones[].label': { label: '分區名稱' },
  'resources[].@.plan.zones[].kind': { label: '分區型別', suggest: ['triage', 'severe', 'moderate', 'light', 'support', 'logistics', 'care', 'road', 'context', 'shelter', 'muster'] },
  'resources[].@.plan.zones[].x': { label: '左上角 X', hint: '0–100（畫布寬度百分比）' },
  'resources[].@.plan.zones[].y': { label: '左上角 Y', hint: '0–100（畫布高度百分比）' },
  'resources[].@.plan.zones[].w': { label: '寬度', hint: '0–100（畫布寬度百分比）' },
  'resources[].@.plan.zones[].h': { label: '高度', hint: '0–100（畫布高度百分比）' },
  'resources[].@.plan.zones[].rot': { label: '旋轉角度', hint: '度，繞方塊中心；0＝不旋轉' },
  'resources[].@.plan.zones[].sub': { label: '分區說明' },
  'resources[].@.plan.zones[].star': { label: '標示為固定電源 ★' },
  'resources[].@.plan.zones[].no': { label: '陳展編號', t: 1, hint: '配置圖上的圓框數字；留空＝該區不編號', where: '戰時配置圖分區左上角的圓框數字' },
  'resources[].@.plan.zones[].demo': { label: '陳展型態', t: 1, hint: '留空＝不列入陳展計數', where: '戰時配置圖下方圖例的「動態陳展 ×N／靜態陳展 ×N」' },
  'resources[].@.plan.legend': { label: '圖例' },
  'resources[].@.plan.legend[].label': { label: '圖例文字' },
  'resources[].@.plan.legend[].kind': { label: '對應分區型別' },
  'resources[].@.plan.videos': { label: '現場影片輪播' },
  'resources[].@.plan.videos[].id': { label: '影片代碼' },
  'resources[].@.plan.videos[].label': { label: '影片標題' },
  'resources[].@.plan.videos[].src': { label: '影片路徑', hint: '放 public/videos/，填 /videos/xxx.mp4；留空＝只顯示佔位方塊' },
  'resources[].@.plan.videos[].at': { label: '縮圖取第幾秒' },
  'resources[].@.plan.videos[].poster': { label: '縮圖路徑' },
  'resources[].@.plan.videos[].sec': { label: '只播前幾秒', hint: '0＝整支播完' },

  // 戰時供電規劃
  'resources[].@.power': { label: '供電規劃', hint: '總負載、續航、裕度全部由下面的「負載項目」自動算出，不用自己填彙總數字' },
  'resources[].@.power.title': { label: '區塊標題' },
  'resources[].@.power.note': { label: '備註' },
  'resources[].@.power.usablePct': { label: '可用電量比例', hint: '額定容量中實際可用的百分比（扣掉 SOC 下限），例：90' },
  'resources[].@.power.cabinets': { label: '儲電櫃' },
  'resources[].@.power.cabinets[].name': { label: '名稱' },
  'resources[].@.power.cabinets[].kwh': { label: '容量 (kWh)' },
  'resources[].@.power.cabinets[].kw': { label: '輸出 (kW)' },
  'resources[].@.power.cabinets[].out': { label: '輸出型式' },
  'resources[].@.power.cabinets[].loc': { label: '位置' },
  'resources[].@.power.cabinets[].state': { label: '狀態' },
  'resources[].@.power.mobile': { label: '機動電源', hint: '規格未提供者只列出、不併入容量與續航計算' },
  'resources[].@.power.mobile[].name': { label: '名稱' },
  'resources[].@.power.mobile[].qty': { label: '台數' },
  'resources[].@.power.mobile[].zone': { label: '所屬分區', hint: '填配置圖的「分區代碼」，圖上該區會出現 🔋' },
  'resources[].@.power.mobile[].use': { label: '供什麼用' },
  'resources[].@.power.mobile[].kwh': { label: '單台容量 (kWh)', hint: '0＝規格待補' },
  'resources[].@.power.mobile[].kw': { label: '單台輸出 (kW)', hint: '0＝規格待補' },
  'resources[].@.power.mobile[].out': { label: '輸出型式' },
  'resources[].@.power.mobile[].weight': { label: '重量' },
  'resources[].@.power.mobile[].spec': { label: '其他規格' },
  'resources[].@.power.mobile[].state': { label: '狀態' },
  'resources[].@.power.loads': { label: '負載項目' },
  'resources[].@.power.loads[].name': { label: '負載名稱' },
  'resources[].@.power.loads[].essential': { label: '計入維生續航', hint: '場地照明這類請取消勾選，不計入大字卡的維生續航' },
  'resources[].@.power.loads[].parts': { label: '用電明細' },
  'resources[].@.power.loads[].parts[].zone': { label: '所屬分區', hint: '填配置圖的「分區代碼」' },
  'resources[].@.power.loads[].parts[].n': { label: '設備品名' },
  'resources[].@.power.loads[].parts[].qty': { label: '台數' },
  'resources[].@.power.loads[].parts[].w': { label: '每台瓦數 (W)' },
  'resources[].@.power.loads[].parts[].flat': { label: '整場定額計', hint: '原廠以整場定額計、不逐台，勾選後台數欄顯示「—」' },

  // 設備
  'resources[].devices': { label: '設備清單' },
  'resources[].devices[].name': { label: '設備名稱' },
  'resources[].devices[].loc': { label: '位置' },
  'resources[].devices[].system': { label: '所屬系統' },
  'resources[].devices[].status': { label: '狀態' },
  'resources[].devices[].reading': { label: '即時值' },
  'resources[].devices[].daily': { label: '每日數值序列' },
  'resources[].devices[].refDaily': { label: '參考序列' },
  'resources[].devices[].unit': { label: '單位' },
  'resources[].devices[].manager': { label: '管理人' },
  'resources[].devices[].contact': { label: '聯絡方式' },
  'resources[].devices[].vendor': { label: '維護廠商' },
  'resources[].devices[].live': { label: '即時來源代碼', hint: '留空＝不接即時資料' },

  // ── 環境參數 ──
  env: { label: '環境參數' },
  'env.peace': { label: '平時' },
  'env.war': { label: '戰時/救災' },
  'env.@.buildings': { label: '大樓' },
  'env.@.buildings[].name': { label: '大樓名稱' },
  'env.@.buildings[].floors': { label: '樓層' },
  'env.@.buildings[].floors[].floor': { label: '樓層', hint: '例：3F、B1' },
  'env.@.buildings[].floors[].temp': { label: '溫度', hint: '例：24.5（°C）' },
  'env.@.buildings[].floors[].rh': { label: '相對濕度', hint: '例：55（%）' },
  'env.@.buildings[].floors[].co2': { label: 'CO₂', hint: '例：620（ppm）' },
  'env.thresholds': { label: '異常門檻', hint: '超出範圍的樓層會在看板標紅' },
  'env.thresholds.temp': { label: '溫度 (°C)' },
  'env.thresholds.rh': { label: '相對濕度 (%)' },
  'env.thresholds.co2': { label: 'CO₂ (ppm)' },
  'env.thresholds.temp.min': { label: '下限' },
  'env.thresholds.temp.max': { label: '上限' },
  'env.thresholds.rh.min': { label: '下限' },
  'env.thresholds.rh.max': { label: '上限' },
  'env.thresholds.co2.max': { label: '上限' },
  'env.criticalFloors': { label: '關鍵樓層', hint: '每行一個，會在看板標示為維生區域' },
  'env.carbon': { label: '碳盤查表' },
  'env.carbon.title': { label: '表格標題' },
  'env.carbon.cols': { label: '欄位標題', hint: '每行一欄，順序即表格由左到右' },
  'env.carbon.rows': { label: '資料列' },
  'env.carbon.rows[].label': { label: '列名' },
  'env.carbon.rows[].cells': { label: '各欄數值', hint: '每行一欄，數量請與「欄位標題」一致' },

  // ── 報表 / ESG ──
  report: { label: '匯出報表' },
  'report.esg': { label: 'ESG 指標' },
  'report.benchmark': { label: '標竿獎項' },
  'report.esg[].item': { label: '項目' },
  'report.esg[].value': { label: '數值' },
  'report.esg[].unit': { label: '單位' },
  'report.benchmark[].item': { label: '項目' },
  'report.benchmark[].value': { label: '數值' },
  'report.benchmark[].unit': { label: '單位' },
  esgPanels: { label: 'ESG 面板' },
  'esgPanels[].id': { label: '代碼' },
  'esgPanels[].icon': { label: '圖示' },
  'esgPanels[].title': { label: '面板標題' },
  'esgPanels[].compare': { label: '顯示比較欄' },
  'esgPanels[].cols': { label: '欄位標題', hint: '每行一欄' },
  'esgPanels[].rows': { label: '資料列' },
  'esgPanels[].rows[].label': { label: '列名' },
  'esgPanels[].rows[].value': { label: '數值' },
  'esgPanels[].rows[].cells': { label: '各欄數值', hint: '每行一欄' },
  'esgPanels[].rows[].delta': { label: '變化標記' },
  'esgPanels[].rows[].delta.text': { label: '變化文字', hint: '例：▲ 3.2%' },
  'esgPanels[].rows[].delta.good': { label: '此變化是正面的', hint: '勾選＝綠色，不勾＝紅色' },
  'esgPanels[].rows[].pending': { label: '資料待補' },
};

// 對不到路徑時的鍵名通用表（最後一道，避免出現英文欄位名）
const FALLBACK = {
  name: '名稱', value: '數值', label: '標籤', title: '標題', id: '代碼', icon: '圖示',
  unit: '單位', warn: '異常', live: '即時來源代碼', critical: '維生關鍵', item: '項目',
  min: '下限', max: '上限', text: '文字', sub: '副標', color: '色票', kind: '型別',
};

// enum 值的中文顯示
export const ENUM_LABELS = {
  esg: { grey: '灰電（市電/化石）', green: '綠電', blue: '藍能（儲能）', amber: '備援（柴油等）', na: '未分類' },
  tone: { ok: '綠（正常）', warn: '黃（注意）', alert: '紅（警示）', off: '灰（停用）' },
  kind: { trend: 'trend（走勢圖）', status: 'status（狀態清單）' },
  layout: { stack: 'stack（舊版堆疊）', split: 'split（舊版左右）', v2: 'v2（現行）' },
  show: { power: '電力', water: '水', oil: '油', gas: '氣', env: '環境參數' },
  demo: { dyn: '動態陳展', sta: '靜態陳展' },
};

export function metaFor(path, key) {
  const hit = P[canonical(path)];
  const base = hit || { label: FALLBACK[key] || key };
  return { ...base, t: base.t || tierOf(key) };
}
