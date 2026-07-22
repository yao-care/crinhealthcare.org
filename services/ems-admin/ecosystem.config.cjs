module.exports = {
  apps: [
    {
      name: 'ems-admin',
      cwd: __dirname,
      script: 'src/index.js',
      max_memory_restart: '200M',
      // 設定來自 services/ems-admin/.env（config.js 讀取）
    },
  ],
};
