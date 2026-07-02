module.exports = {
  apps: [
    {
      name: 'ems-bridge',
      cwd: __dirname,
      script: 'src/index.js',
      max_memory_restart: '200M',
      // 設定來自 services/ems-bridge/.env（config.js 讀取）；無 CABINET_HOST 時自動模擬模式
    },
  ],
};
