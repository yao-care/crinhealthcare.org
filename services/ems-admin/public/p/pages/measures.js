// 節約能源措施（能源查核申報表十、表十一）與歷年節電率（表十之六）
import { state, get, post, api, h, route, page, card, table, chip, fmtNum, action, btn, formModal, form, modal, toast, can, needOrg, render, note, setQuery } from '../core.js';

export function register() {
  route('/measures', measuresPage, { title: '節約能源措施' });
}

const roc = (y) => y - 1911;
const SOURCES = [['current', '當年度計畫'], ['cross_year', '跨年度成效']];
// 附表三附錄：節約能源措施代碼＝系統類別＋設備類別＋節能方法（常用組合）
const CODE_HINT = '例：AA06 中央空調主機汰舊換新、LG06 照明採電子式安定器、AA07 設置空調節能監控、FA20 冷凍設備加裝變頻、P_61 契約容量合理化（依附表三附錄代碼表）';

function measureFields(accts, year, kind) {
  return [
    { key: 'name', label: kind === 'done' ? '已執行之節約能源措施' : '預計執行之節約能源措施', required: true, wide: true },
    { key: 'code', label: '措施代碼（4 碼）', hint: CODE_HINT, wide: true },
    { key: 'assetId', label: '所屬電號', type: 'select', options: accts.map((a) => [a.id, `${a.external_key || a.name}`]), placeholder: '全院' },
    { key: 'source', label: '措施來源', type: 'select', options: SOURCES, required: true, default: 'current' },
    { key: 'energyType', label: '節約能源種類', type: 'select', options: Object.entries(state.meta.energyTypes || { electricity: '電力（度）' }), required: true, default: 'electricity' },
    { key: 'saving', label: kind === 'done' ? '節約能源量（依能源種類單位）' : '預估節約能源量', type: 'number' },
    { key: 'demandResponse', label: '需量反應負載管理措施（節電量＝實際抑低量 × 抑低時數；計算前期超額節電量時分開計）', type: 'checkbox', wide: true },
    { key: 'periodFrom', label: '執行計畫期間起（年月）', type: 'month' }, { key: 'periodTo', label: '執行計畫期間迄（年月）', type: 'month' },
    { key: 'calcFromMonth', label: `效益計算起月（${roc(year)} 年）`, type: 'number' }, { key: 'calcToMonth', label: '效益計算迄月', type: 'number' },
    { key: 'peakReductionKw', label: '抑低尖峰需量（kW）', type: 'number' }, { key: 'benefitTwd', label: '節能效益金額（元）', type: 'number' }, { key: 'investmentTwd', label: '投資金額（元）', type: 'number' },
    { key: 'target', label: '施行對象（設備或器具）' }, { key: 'area', label: '實施區域' },
    { key: 'method', label: '具體作法', type: 'textarea', wide: true },
    { key: 'calcNote', label: '數值來源與節能量計算說明（表十之一）', type: 'textarea', wide: true, hint: '例：(36W−18W)×2 支×1,200 具×4,380 小時×認列月數比例 100%' },
  ];
}
const toValues = (m) => ({ name: m.name, code: m.code, assetId: m.asset_id, source: m.source, energyType: m.energy_type, saving: m.saving, periodFrom: m.period_from, periodTo: m.period_to,
  demandResponse: !!m.demand_response, calcFromMonth: m.calc_from_month, calcToMonth: m.calc_to_month, peakReductionKw: m.peak_reduction_kw, benefitTwd: m.benefit_twd, investmentTwd: m.investment_twd, target: m.target, area: m.area, method: m.method, calcNote: m.calc_note });

async function measuresPage(_, qy) {
  const orgId = needOrg();
  const year = Number(qy.year) || state.year;
  const w = can('report.write', orgId);
  const accts = (await get('assets', { orgId, limit: 500 })).filter((a) => a.item_code === 'ELE-GRID' || a.asset_type === 'power_account');
  const [done, plan] = await Promise.all([get('energy-measures', { orgId, year, kind: 'done' }), get('energy-measures', { orgId, year: year + 1, kind: 'plan' })]);
  const acctName = (id) => { const a = accts.find((x) => x.id === id); return a ? a.external_key || a.name : '全院'; };
  const edit = (kind, y, m) => formModal(m ? `修改：${m.name}` : kind === 'done' ? `新增 ${roc(y)} 年已執行措施` : `新增 ${roc(y)} 年計畫措施`, measureFields(accts, y, kind), m ? toValues(m) : {}, async (v) => {
    await post('energy-measures', { ...v, id: m?.id, orgId, year: y, kind }); toast('已儲存'); render();
  });
  const remove = (m) => {
    const f = form([{ key: 'reason', label: '刪除原因', required: true, wide: true }]);
    modal(`刪除措施：${m.name}`, f.el, { okText: '刪除', onOk: async () => { const v = f.read(); if (!v) return false; await api(`energy-measures/${m.id}`, { method: 'DELETE', query: { reason: v.reason } }); toast('已刪除'); render(); } });
  };
  const cols = (kind, y) => [
    { label: '電號', render: (m) => acctName(m.asset_id) }, { label: '代碼', render: (m) => m.code || '—' }, { label: '措施', key: 'name' },
    { label: '來源', render: (m) => (m.source === 'cross_year' ? '跨年度成效' : '當年度計畫') }, { label: '能源', render: (m) => (state.meta.energyTypes || {})[m.energy_type] || m.energy_type },
    { label: kind === 'done' ? '節約量' : '預估節約量', render: (m) => fmtNum(m.saving), num: true }, { label: '效益（元）', render: (m) => fmtNum(m.benefit_twd), num: true },
    { label: '投資（元）', render: (m) => fmtNum(m.investment_twd), num: true }, { label: '計算說明', render: (m) => (m.calc_note ? '✓' : chip('未填', 'warn')) },
    { label: '動作', render: (m) => (w ? h('span', action('修改', () => edit(kind, y, m)), ' ', action('刪除', () => remove(m), 'ghost')) : '—') },
  ];
  // 歷年節電率（每個電號一張）
  const rates = await Promise.all((accts.length ? accts : [null]).map(async (a) => ({ a, t: await get('energy-saving-rate', { orgId, assetId: a?.id || '', year }) })));
  const editYear = (a, r) => formModal(`${a ? a.external_key || a.name : '全院'}：填寫歷年值`, [
    { key: 'year', label: '年度（西元）', type: 'number', required: true }, { key: 'savingKwh', label: '非需量反應節電量（度，留空＝依措施加總）', type: 'number' },
    { key: 'drSavingKwh', label: '需量反應節電量（度，留空＝依措施加總）', type: 'number' },
    { key: 'usageKwh', label: '年度用電量（度，購電＋自發－售電；留空＝依資料集）', type: 'number' }, { key: 'deductKwh', label: '可扣除用電量（度，只適用 104–113 年）', type: 'number' },
    { key: 'note', label: '扣除項目說明（新建築、新設備、安全考量用電區域、工程施作、新法規、電動車充電）', type: 'textarea', wide: true }],
  r ? { year: r.year, savingKwh: r.saving, drSavingKwh: r.dr, usageKwh: r.usage, deductKwh: r.deduct, note: r.note } : { year: 2015 }, async (v) => {
    await api('energy-saving-years', { method: 'PUT', body: { orgId, assetId: a?.id || null, ...v } }); toast('已儲存'); render();
  });
  const rateCards = rates.map(({ a, t }) => {
    const last = t.rows[t.rows.length - 1];
    if (a?.attrs?.militaryUnit) return card(`歷年節電率｜電號 ${a.external_key || a.name}`, note('此電號列入國防部國軍部隊用戶清冊，免受節約能源目標規範；仍須辦理能源查核申報。'));
    const pctTxt = (v) => (v === null || v === undefined ? '—' : `${fmtNum(v, 2)}%`);
    return card(`歷年節電率${a ? `｜電號 ${a.external_key || a.name}` : ''}`,
      last?.rate !== null && last?.rate !== undefined ? note(`${roc(last.year)} 年平均年節電率 ${fmtNum(last.rate, 2)}%（目標 ${t.target}%）${last.year >= 2025 ? `，年度節電率 ${pctTxt(last.annualRate)}` : ''}${last.rate < t.target ? '：未達目標，申報時須填未達目標說明及改善計畫' : ''}`, last.rate < t.target ? 'warn' : '') : null,
      h('p', { class: 'muted pf-small' }, `114 年起適用新規定：只累計 114 年起的節電量與用電量，另加前期超額節電量 ${fmtNum(t.excess, 0)} 度（依 104–113 年資料計算）。`),
      table([{ label: '年度', render: (r) => `${roc(r.year)} 年` }, { label: '規定', key: 'period' }, { label: '節電量（度）', render: (r) => fmtNum(r.saving, 0), num: true }, { label: '需量反應（度）', render: (r) => fmtNum(r.dr, 0), num: true },
        { label: '用電量（度）', render: (r) => fmtNum(r.usage, 0), num: true }, { label: '扣除（度）', render: (r) => fmtNum(r.deduct, 0), num: true },
        { label: '年度節電率', render: (r) => pctTxt(r.annualRate), num: true }, { label: '平均年節電率', render: (r) => pctTxt(r.rate), num: true }, { label: '來源', render: (r) => [r.from, r.note].filter(Boolean).join('；') },
        { label: '動作', render: (r) => (w ? action('修改', () => editYear(a, r)) : '—') }], t.rows, { empty: '還沒有歷年資料：可以先填 104 年起的節電量與用電量' }),
      w ? h('div', { class: 'pf-actions' }, action('＋填寫某年度', () => editYear(a))) : null);
  });
  return page('節約能源措施', {
    intro: '能源用戶（契約容量超過 800 kW 的電號）每年申報已執行的節能措施與下一年度計畫，並計算平均年節電率。這裡登錄的資料會帶入「非生產性質行業能源查核申報」報告。',
    actions: [h('label', { class: 'pf-small' }, '年度 ', h('select', { onchange: (e) => setQuery({ year: e.target.value }) }, [0, 1, 2, 3, 4].map((d) => state.year + 1 - d).map((y) => h('option', { value: y, selected: y === year || undefined }, `${y}（民國 ${roc(y)}）`))))],
  },
  !accts.length ? note('還沒有台電電號標的：請先在標的台帳新增「外購電力 › 台電電號」。', 'warn') : null,
  card(`表十之二 ${roc(year)} 年已執行措施`, w ? h('div', { class: 'pf-actions' }, action('＋新增已執行措施', () => edit('done', year), 'primary')) : null, table(cols('done', year), done, { empty: '本年度沒有登錄已執行措施' })),
  card(`表十一 ${roc(year + 1)} 年節約能源措施執行計畫`, w ? h('div', { class: 'pf-actions' }, action('＋新增計畫措施', () => edit('plan', year + 1), 'primary')) : null, table(cols('plan', year + 1), plan, { empty: '尚未登錄下一年度計畫' })),
  ...rateCards);
}
