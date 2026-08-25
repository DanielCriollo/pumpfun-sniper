// PM2 Ecosystem — VPS 1 (Core Trading Engine)
// Uso: pm2 start ecosystem.config.js --env production
// Docs: https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [
    {
      name: 'pumpfun-sniper',

      // Entrypoint compilado
      script: './dist/index.js',

      // Modo fork (no cluster): solo 1 instancia para acceso exclusivo al WebSocket
      instances: 1,
      exec_mode: 'fork',

      // Reinicio automático si crashea
      autorestart: true,
      watch: false,

      // Reiniciar si supera 512 MB de RAM (protección contra memory leaks)
      max_memory_restart: '512M',

      // Estrategia de reinicio con backoff exponencial (evita loops de crash)
      exp_backoff_restart_delay: 100, // ms iniciales
      max_restarts: 15,
      min_uptime: '15s',  // si muere antes, no cuenta como "up"
      restart_delay: 5000, // ms entre reinicios normales

      // Tiempo máximo para que la app emita ready (si usas process.send('ready'))
      listen_timeout: 10000,

      // Tiempo para que el proceso termine limpiamente antes de SIGKILL
      kill_timeout: 8000,

      // Variables de entorno de producción
      // El archivo .env se carga desde el código con dotenv
      env_production: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },

      // Variables de entorno de desarrollo (pm2 start --env development)
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },

      // --- Logs ---
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,

      // Rotar logs cuando superen 10 MB (requiere: pm2 install pm2-logrotate)
      // pm2 set pm2-logrotate:max_size 10M
      // pm2 set pm2-logrotate:retain 7
    },
  ],
};
