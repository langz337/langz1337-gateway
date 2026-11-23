# 9Router gateway + cloudflared + Telegram bot, single container (Render free).
# Base: Node 24 (matches the VM the gateway was built on; 9Router needs >= 20.18).
FROM node:24-slim

# System tools:
#   python3 + python3-bcrypt  -> seed.py (rebuilds 9Router config from env vars)
#   sqlite3                  -> debugging the 9Router DB if needed
#   curl + ca-certificates   -> downloading cloudflared, health checks
#   util-linux               -> `script` (gives OpenCode the TTY it requires)
#   procps                   -> `pkill`/`pgrep` (bot kills orphaned agent runs)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-bcrypt sqlite3 curl ca-certificates util-linux procps \
    && rm -rf /var/lib/apt/lists/*

# cloudflared (same version as the VM: v2026.11.1, linux-amd64).
RUN curl -fsSL -L -o /usr/local/bin/cloudflared \
      https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

# 9Router gateway + OpenCode CLI (pinned to the versions verified on the VM).
RUN npm install -g --no-audit --no-fund 9router@0.5.123 opencode-ai@1.19.6 \
    && 9router --version \
    && opencode --version

# App files.
WORKDIR /app
COPY seed.py health.js start.sh ./
COPY bot/ ./bot/
RUN chmod +x /app/start.sh \
    && mkdir -p /app/bot/agent-work \
    && mkdir -p /root/.9router/db /root/.config/opencode

# 9Router listens on 20128 internally; health.js binds Render's $PORT.
ENV HOME=/root
ENV ROUTER_PORT=20128
EXPOSE 20128

CMD ["/app/start.sh"]
