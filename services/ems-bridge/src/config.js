// 設定：.env（services/ems-bridge/.env）＋ CLI flags。無 CABINET_HOST 或 --sim → 模擬模式。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

export const config = {
  cabinetHost: process.env.CABINET_HOST || '',
  cabinetPort: Number(process.env.CABINET_PORT || 502),
  unitId: Number(process.env.UNIT_ID || 1),
  pollMs: Number(process.env.POLL_MS || 2000),
  httpPort: Number(process.env.HTTP_PORT || 8460),
  // 電池組定址（規格書 §7：base=(Par-1)*800+(Ser+1)*200），實機對表時以 env 調整
  packParInd: Number(process.env.PACK_PAR_IND || 1),
  packSerInd: Number(process.env.PACK_SER_IND || 0),
  sim: flag('--sim') || !process.env.CABINET_HOST,
  // 僅供本地視覺測試：讓模擬資料以 source:'live' 回報（正式環境絕不可用）
  simAsLive: flag('--sim-as-live'),
  corsOrigins: (process.env.CORS_ORIGINS || 'https://crinhealthcare.org').split(','),
};

// 本地開發（astro dev 4321 / preview 4399）一律放行
export function corsAllowed(origin) {
  if (!origin) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return config.corsOrigins.includes(origin);
}
