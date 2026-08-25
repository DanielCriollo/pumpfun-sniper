# PumpFun Sniper Bot — Guía Completa de Despliegue

## Arquitectura de los 2 VPS

```
┌─────────────────────────────────────────────────────────┐
│  VPS 1 — Core Trading Engine                            │
│  Ubuntu 22.04 / 24.04 · Node.js 20 · PM2               │
│                                                         │
│  ┌─────────────┐  WS  ┌──────────────────────────────┐ │
│  │  PumpPortal │ ───▶ │  src/index.ts (WebSocket)    │ │
│  │  WebSocket  │      │  + Filters + PositionMgr     │ │
│  └─────────────┘      └──────────────────────────────┘ │
│                                 │                       │
│                          POST (HTTP)                    │
│                                 │                       │
│  ┌──────────────────────────────▼──────────────────┐   │
│  │  src/server.ts  (Fastify · 127.0.0.1:3000)      │   │
│  │  POST /api/panic-sell/:mint                      │   │
│  │  POST /api/toggle-pause                          │   │
│  └──────────────────────────────────────────────────┘   │
│                         ▲                               │
│                    X-Api-Key auth                       │
└─────────────────────────│───────────────────────────────┘
                          │
             HTTP (X-Webhook-Secret)
                          │
┌─────────────────────────▼───────────────────────────────┐
│  VPS 2 — n8n + Telegram Bot                             │
│                                                         │
│  n8n Webhook Node ────▶ Telegram notification           │
│  Telegram trigger ────▶ HTTP call to VPS 1 API          │
└─────────────────────────────────────────────────────────┘
```

---

## PASO 1 — Preparar VPS 1

### 1.1 Instalar Node.js 20 (LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # debe mostrar v20.x
```

### 1.2 Instalar PM2 globalmente

```bash
sudo npm install -g pm2
pm2 --version
# Configurar PM2 para arrancar al inicio del servidor
pm2 startup
# Ejecutar el comando que PM2 te indica (incluye sudo)
```

### 1.3 Instalar plugin de rotación de logs

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

---

## PASO 2 — Clonar el repositorio en VPS 1

```bash
# Crear directorio de trabajo
mkdir -p /opt/bots && cd /opt/bots

# Clonar (usa SSH key o HTTPS con token)
git clone git@github.com:TU_USUARIO/pumpfun-sniper.git
cd pumpfun-sniper

# Verificar estructura
ls -la src/
```

---

## PASO 3 — Configurar variables de entorno

```bash
# Copiar la plantilla
cp .env.example .env

# Editar con nano (o vim)
nano .env

# Permisos restrictivos: solo el propietario puede leer el .env
chmod 600 .env
```

### Valores críticos a rellenar en `.env`:

| Variable | Descripción |
|---|---|
| `RPC_ENDPOINT` | URL de tu RPC Helius/QuickNode con API key |
| `PRIVATE_KEY` | Clave privada en Base58 de tu wallet de trading |
| `API_SECRET_KEY` | `openssl rand -hex 32` |
| `N8N_WEBHOOK_URL` | `http://<IP_VPS2>:5678/webhook/pumpfun-events` |
| `N8N_WEBHOOK_SECRET` | `openssl rand -hex 32` (el mismo que configures en n8n) |

> **⚠️ SEGURIDAD:** La clave privada NUNCA debe estar en el repositorio Git.
> Verifica que `.env` aparece en `.gitignore` antes de cualquier `git push`.

---

## PASO 4 — Instalar dependencias y compilar

```bash
cd /opt/bots/pumpfun-sniper

# Instalar dependencias de producción + dev (para compilar)
npm install

# Compilar TypeScript → JavaScript
npm run build

# Verificar que dist/index.js existe
ls -lh dist/index.js
```

---

## PASO 5 — Arrancar con PM2

```bash
cd /opt/bots/pumpfun-sniper

# Arrancar en modo producción
pm2 start ecosystem.config.js --env production

# Verificar estado
pm2 status

# Ver logs en vivo
pm2 logs pumpfun-sniper

# Guardar la lista de procesos para que sobreviva reinicios del VPS
pm2 save
```

---

## PASO 6 — Flujo de actualización (deploy)

```bash
# En tu máquina local — compilar y subir
npm run build
git add -A
git commit -m "feat: descripción del cambio"
git push origin main

# En VPS 1
cd /opt/bots/pumpfun-sniper
git pull origin main
npm install        # si hay nuevas dependencias
npm run build      # recompilar
pm2 restart pumpfun-sniper --update-env
pm2 logs pumpfun-sniper --lines 50
```

---

## PASO 7 — Seguridad de comunicación entre VPS 1 y VPS 2

### Opción A — Restricción UFW por IP (recomendada para firewall)

En **VPS 1**, abrir el puerto 3000 SOLO para la IP de VPS 2:

```bash
# Habilitar UFW si no lo está
sudo ufw enable

# Denegar todo por defecto
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Permitir SSH (¡hazlo antes de activar UFW!)
sudo ufw allow 22/tcp

# Permitir API interna SOLO desde VPS 2
sudo ufw allow from <IP_VPS2> to any port 3000 proto tcp

# Ver reglas activas
sudo ufw status numbered
```

En **VPS 2**, los webhooks de n8n llegan de internet. Para autenticarlos, usa el header `X-Webhook-Secret` en el nodo HTTP de n8n:

1. En el nodo **Webhook** de n8n → **Authentication** → **Header Auth**
2. **Header Name:** `X-Webhook-Secret`
3. **Header Value:** el mismo valor que `N8N_WEBHOOK_SECRET` en tu `.env`

### Opción B — SSH Tunnel (sin abrir puertos adicionales)

Si no quieres exponer el puerto 3000 en ningún firewall:

```bash
# En VPS 2, crear un túnel SSH persistente hacia VPS 1
# Esto mapea el puerto 3000 de VPS 1 al puerto local 13000 de VPS 2
ssh -N -L 13000:127.0.0.1:3000 user@<IP_VPS1> &

# Las llamadas desde n8n apuntarán a:
# http://127.0.0.1:13000/api/panic-sell/:mint
```

Para que el túnel sobreviva desconexiones, usar `autossh`:

```bash
sudo apt install autossh
autossh -M 0 -f -N -L 13000:127.0.0.1:3000 \
  -o "ServerAliveInterval 30" \
  -o "ServerAliveCountMax 3" \
  user@<IP_VPS1>
```

---

## PASO 8 — Configurar n8n en VPS 2

### Workflow básico de n8n

1. **Nodo Webhook** (trigger)
   - Método: POST
   - Path: `/pumpfun-events`
   - Authentication: Header `X-Webhook-Secret`

2. **Nodo Switch** (router por tipo de evento)
   - `TOKEN_BOUGHT` → Mensaje Telegram "🟢 Comprado: {{$json.symbol}}"
   - `TP1_TRIGGERED` → Mensaje Telegram "🎯 TP1 ejecutado"
   - `TP2_TRIGGERED` → Mensaje Telegram "🎯🎯 TP2 ejecutado"
   - `SL_TRIGGERED` → Mensaje Telegram "🔴 Stop-Loss ejecutado"
   - `PANIC_SELL` → Mensaje Telegram "🚨 Panic Sell ejecutado"
   - `TRADE_ERROR` → Mensaje Telegram "❌ Error: {{$json.error}}"

3. **Nodo Telegram Bot** → Enviar mensaje al chat ID de tu bot

### Comando de Panic Sell desde Telegram

En n8n, añade un nodo Telegram Trigger:
- Escucha mensajes del bot
- Si el mensaje es `/panic <MINT>`, hace un HTTP Request:
  - **URL:** `http://127.0.0.1:13000/api/panic-sell/<MINT>` (si usas SSH tunnel)
  - **Method:** POST
  - **Headers:** `X-Api-Key: <tu API_SECRET_KEY>`

### Comando de Toggle Pause desde Telegram

- Si el mensaje es `/pause` → POST `http://127.0.0.1:13000/api/toggle-pause`
  - Header: `X-Api-Key: <tu API_SECRET_KEY>`

---

## PASO 9 — Monitoreo y mantenimiento

### Comandos PM2 esenciales

```bash
# Estado de todos los procesos
pm2 status

# Logs en vivo (Ctrl+C para salir)
pm2 logs pumpfun-sniper

# Ver últimas 100 líneas de error
pm2 logs pumpfun-sniper --err --lines 100

# Reiniciar sin downtime (zero-downtime reload)
pm2 reload pumpfun-sniper

# Reinicio forzado
pm2 restart pumpfun-sniper

# Métricas en tiempo real (CPU, RAM)
pm2 monit

# Estado del panel de posiciones (desde VPS 1)
curl -s -H "X-Api-Key: <API_SECRET_KEY>" \
  http://127.0.0.1:3000/api/status | python3 -m json.tool
```

### Panic sell manual desde VPS 1

```bash
# Ejemplo con mint real
MINT="<TOKEN_MINT_ADDRESS>"
API_KEY="<API_SECRET_KEY>"

curl -s -X POST \
  -H "X-Api-Key: $API_KEY" \
  http://127.0.0.1:3000/api/panic-sell/$MINT
```

### Toggle pause manual desde VPS 1

```bash
curl -s -X POST \
  -H "X-Api-Key: $API_KEY" \
  http://127.0.0.1:3000/api/toggle-pause
```

---

## PASO 10 — Protección de Secrets

### Resumen de buenas prácticas

| Práctica | Comando / Configuración |
|---|---|
| Permisos restrictivos en `.env` | `chmod 600 .env` |
| Verificar que `.env` está en `.gitignore` | `git check-ignore -v .env` |
| Usar usuario dedicado (no root) | `adduser botuser && su botuser` |
| Rotar API keys periódicamente | Actualizar `.env` + `pm2 restart` |
| Wallet con saldo mínimo | Solo fondos necesarios por sesión |
| Hacer backup cifrado de la clave | `gpg --symmetric --cipher-algo AES256 private.key` |

### Verificar que el .env no se subió a Git

```bash
# Si ya existe en el historial, eliminar con BFG o filter-branch
# ANTES de hacer esto, asegúrate de que el remote no tiene la key comprometida
git log --all --full-history -- .env
```

---

## Referencia rápida de endpoints de la API interna

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/panic-sell/:mint` | Liquida 100% de una posición |
| `POST` | `/api/toggle-pause` | Pausa/reanuda nuevas compras |
| `GET` | `/api/status` | Estado general del bot y posiciones |
| `GET` | `/api/position/:mint` | Detalle de una posición específica |

Todos los endpoints requieren header: `X-Api-Key: <API_SECRET_KEY>`
