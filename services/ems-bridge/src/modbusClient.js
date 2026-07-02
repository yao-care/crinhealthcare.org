// Modbus TCP client 包裝：自動重連（指數退避上限 30s）、依讀取計劃批次讀回 raw 字組。
import ModbusRTU from 'modbus-serial';

export function createModbusClient({ host, port, unitId, readPlan }) {
  const client = new ModbusRTU();
  let connected = false;
  let backoffMs = 1000;

  async function connect() {
    try {
      await client.connectTCP(host, { port });
      client.setID(unitId);
      client.setTimeout(3000);
      connected = true;
      backoffMs = 1000;
    } catch (err) {
      connected = false;
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30000);
      await new Promise((r) => setTimeout(r, wait));
      throw err;
    }
  }

  return {
    async readAll() {
      if (!connected) await connect();
      const raw = {};
      try {
        for (const seg of readPlan) {
          const res = seg.fc === 3
            ? await client.readHoldingRegisters(seg.addr, seg.len)
            : await client.readInputRegisters(seg.addr, seg.len);
          raw[seg.key] = res.data;
        }
      } catch (err) {
        connected = false;
        try { client.close(() => {}); } catch { /* 已斷線 */ }
        throw err;
      }
      return raw;
    },
    close() {
      try { client.close(() => {}); } catch { /* noop */ }
    },
  };
}
