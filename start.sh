#!/bin/bash
# Entrypoint: 9Router + cloudflared + Telegram bot + health proxy (ONE container).
# Flow:
#   1. Seed 9Router config from env vars (seed.py, idempotent).
#   2. Start 9Router on :20128, wait until it answers.
#      Fallback: if it does not start with the pre-seeded DB, let 9Router
#      boot once on an empty DB (so it creates its own schema), then
#      re-seed into that DB and start for real.
#   3. Start cloudflared (tunnel langz1337.my.id -> localhost:20128),
#      only if TUNNEL_TOKEN is set.
#   4. Start health proxy on $PORT (Render health check + UptimeRobot).
#   5. Start Telegram bot, only if TELEGRAM_BOT_TOKEN is set.
#   6. Monitor loop: restart any child that dies.
set -u
export HOME="${HOME:-/root}"
export ROUTER_PORT="${ROUTER_PORT:-20128}"
DB="$HOME/.9router/db/data.sqlite"
APP_DIR="/app"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [start] $*"; }

router_ready() {
  code=$(curl -s --max-time 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${ROUTER_PORT}/v1/models" 2>/dev/null || echo 000)
  [ "$code" = "200" ]
}

wait_router() { # wait_router <seconds>
  local deadline=$((SECONDS + $1))
  while [ $SECONDS -lt $deadline ]; do
    if router_ready; then return 0; fi
    sleep 2
  done
  return 1
}

start_router() {
  setsid 9router --host 127.0.0.1 --port "$ROUTER_PORT" --no-browser --skip-update \
    > /tmp/9router.log 2>&1 < /dev/null &
  echo $!
}

# --- 1. seed ---------------------------------------------------------------
log "seeding 9Router config from env vars..."
if ! python3 "$APP_DIR/seed.py"; then
  log "FATAL seed.py failed (missing env var or DB error). Refusing to start."
  exit 1
fi

# --- 2. 9Router ------------------------------------------------------------
log "starting 9Router on :$ROUTER_PORT ..."
ROUTER_PID=$(start_router)
if wait_router 40; then
  log "9Router ready (pid $ROUTER_PID)"
else
  log "WARNING 9Router did not answer with the pre-seeded DB; trying clean-boot fallback..."
  kill "$ROUTER_PID" 2>/dev/null; sleep 3
  mv "$DB" "$DB.seeded" 2>/dev/null || true
  ROUTER_PID=$(start_router)
  if wait_router 40; then
    log "9Router booted clean; re-seeding into its own DB..."
    kill "$ROUTER_PID" 2>/dev/null; sleep 3
    if ! python3 "$APP_DIR/seed.py"; then
      log "FATAL re-seed failed."
      exit 1
    fi
    ROUTER_PID=$(start_router)
    if wait_router 40; then
      log "9Router ready after re-seed (pid $ROUTER_PID)"
    else
      log "FATAL 9Router still not ready after re-seed. See /tmp/9router.log."
      exit 1
    fi
  else
    log "FATAL 9Router did not start even on a clean DB. See /tmp/9router.log."
    exit 1
  fi
fi

# --- 3. cloudflared (tunnel) ----------------------------------------------
CLOUDFLARED_PID=""
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  log "starting cloudflared (tunnel langz1337.my.id -> localhost:$ROUTER_PORT)..."
  setsid env TUNNEL_TOKEN="$TUNNEL_TOKEN" cloudflared tunnel run --protocol http2 \
    > /tmp/cloudflared.log 2>&1 < /dev/null &
  CLOUDFLARED_PID=$!
  log "cloudflared started (pid $CLOUDFLARED_PID)"
else
  log "WARNING TUNNEL_TOKEN not set; langz1337.my.id will stay down (Error 1033). Gateway still works via the onrender.com URL."
fi

# --- 4. health proxy on $PORT ----------------------------------------------
HEALTH_PID=""
if [ -n "${PORT:-}" ]; then
  log "starting health proxy on :$PORT ..."
  setsid node "$APP_DIR/health.js" > /tmp/health.log 2>&1 < /dev/null &
  HEALTH_PID=$!
  log "health proxy started (pid $HEALTH_PID)"
else
  log "WARNING \$PORT not set (not on Render?); health proxy skipped."
fi

# --- 5. Telegram bot --------------------------------------------------------
mkdir -p "$HOME/.config/opencode"
cp "$APP_DIR/bot/opencode.json" "$HOME/.config/opencode/opencode.json"
BOT_PID=""
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  log "starting Telegram bot..."
  (cd "$APP_DIR/bot" && setsid node bot.js > /tmp/bot.log 2>&1 < /dev/null &)
  sleep 3
  BOT_PID=$(pgrep -f 'node bot.js' | head -1 || true)
  log "Telegram bot started (pid ${BOT_PID:-?})"
else
  log "WARNING TELEGRAM_BOT_TOKEN not set; bot skipped."
fi

log "all services up. 9Router=:${ROUTER_PORT} tunnel=${CLOUDFLARED_PID:-none} health=${HEALTH_PID:-none} bot=${BOT_PID:-none}"

# --- 6. monitor loop --------------------------------------------------------
while true; do
  sleep 30
  if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    log "9Router died; restarting..."
    ROUTER_PID=$(start_router)
    wait_router 40 || log "WARNING 9Router restart did not become ready; will retry next cycle."
  fi
  if [ -n "$CLOUDFLARED_PID" ] && ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    log "cloudflared died; restarting..."
    setsid env TUNNEL_TOKEN="$TUNNEL_TOKEN" cloudflared tunnel run --protocol http2 \
      > /tmp/cloudflared.log 2>&1 < /dev/null &
    CLOUDFLARED_PID=$!
  fi
  if [ -n "$HEALTH_PID" ] && ! kill -0 "$HEALTH_PID" 2>/dev/null; then
    log "health proxy died; restarting..."
    setsid node "$APP_DIR/health.js" > /tmp/health.log 2>&1 < /dev/null &
    HEALTH_PID=$!
  fi
  if [ -n "$BOT_PID" ] && ! kill -0 "$BOT_PID" 2>/dev/null; then
    log "Telegram bot died; restarting..."
    (cd "$APP_DIR/bot" && setsid node bot.js > /tmp/bot.log 2>&1 < /dev/null &)
    sleep 3
    BOT_PID=$(pgrep -f 'node bot.js' | head -1 || true)
  fi
done
