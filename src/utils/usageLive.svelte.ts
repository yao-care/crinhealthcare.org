// 電力區塊頂列「前日／上月／去年」用電度數：向油水電氣平台的公開彙總 API 取（只有全院三個數字，不含電號或帳單細節）。
// 三態：loading／live（平台有回數字）／fail（連不上，維持 JSON 原本的 perf 文字）。
// 誠實原則：平台沒有的數字顯示「—」，不補推估值。
const API_BASE: string = (import.meta.env.PUBLIC_EMS_ADMIN_API as string | undefined) ?? 'https://ems-admin.crinhealthcare.org';
const POLL_MS = 30 * 60 * 1000;   // AMI 一天才更新一次，半小時看一次就夠
const FETCH_TIMEOUT_MS = 5000;

export interface UsageData {
  today: string;
  day: { date: string; kwh: number; stale?: boolean } | null;
  month: { month: string; kwh: number } | null;
  year: { year: number; kwh: number } | null;
}
export type UsageStatus = 'loading' | 'live' | 'fail';
export interface UsagePoller { readonly status: UsageStatus; readonly data: UsageData | null; start(): () => void; }

export function createUsagePoller(hid: string): UsagePoller {
  let status = $state<UsageStatus>('loading');
  let data = $state<UsageData | null>(null);
  async function tick() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${API_BASE}/api/v1/public/usage/${encodeURIComponent(hid)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (!body.ok || !body.data) throw new Error('no data');
      data = body.data;
      status = 'live';
    } catch {
      if (!data) status = 'fail';   // 已有數字時暫時斷線就沿用上一次
    }
  }
  return {
    get status() { return status; },
    get data() { return data; },
    start() { tick(); const id = setInterval(tick, POLL_MS); return () => clearInterval(id); },
  };
}

const kwh = (v: number) => `${Math.round(v).toLocaleString('zh-TW')} 度`;
// 「前日 17,018 度 · 上月 520,000 度 · 去年 6,302,756 度」；智慧電表晚上傳時前日改標日期
export function usageText(d: UsageData | null): string {
  if (!d) return '';
  const day = d.day ? `${d.day.stale ? `${Number(d.day.date.slice(5, 7))}/${Number(d.day.date.slice(8, 10))}` : '前日'} ${kwh(d.day.kwh)}` : '前日 —';
  const month = d.month ? `上月 ${kwh(d.month.kwh)}` : '上月 —';
  const year = d.year ? `去年 ${kwh(d.year.kwh)}` : '去年 —';
  return [day, month, year].join(' · ');
}
