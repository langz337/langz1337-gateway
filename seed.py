#!/usr/bin/env python3
"""
Seed 9Router SQLite config from environment variables.
Idempotent: safe to run on every container start (INSERT OR REPLACE).

Why this exists: Render free tier has an EPHEMERAL filesystem. The 9Router
config lives in a SQLite DB (~/.9router/db/data.sqlite) which is WIPED on
every restart/redeploy. This script rebuilds the config from env vars on
every boot, so the gateway always comes back with the same providers,
API key and combo -- no dashboard clicking needed.

What it seeds (and ONLY this):
  - providerConnections: groq + openrouter (the two working providers).
    Zen / Muse / GLM / Poolside / Ollama are DELIBERATELY NOT seeded
    (Zen needs OAuth login, Muse DNS is dead, GLM/Poolside have no key,
    Ollama local models do not move to Render).
  - apiKeys: one /v1 key named "vm-local" (value from ROUTER_API_KEY).
  - combos: "bansos-hunt" with only the WORKING models, groq 120b last
    (the combo is answered by its LAST model).
  - settings: dashboard password hash, ONLY if ROUTER_DASHBOARD_PASSWORD
    is set (needs python3-bcrypt; otherwise warns and skips).
  - _meta: schemaVersion + appVersion markers.

It does NOT touch usageHistory / usageDaily / kv / providerNodes /
requestDetails / proxyPools (statistics / managed by 9Router itself).

Usage:
  GROQ_API_KEY=... OPENROUTER_API_KEY=... ROUTER_API_KEY=... \
  [ROUTER_DASHBOARD_PASSWORD=...] [ROUTER_DB=/path/to/data.sqlite] \
  python3 seed.py

Exit code 0 = seeded OK. Non-zero = a required env var is missing or
the DB could not be written (start.sh aborts the boot in that case).
"""
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

# --- schema (copied from the live 9Router 0.5.123 database) -----------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS providerConnections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  authType TEXT NOT NULL,
  name TEXT,
  email TEXT,
  priority INTEGER,
  isActive INTEGER DEFAULT 1,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider);
CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive);
CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority);

CREATE TABLE IF NOT EXISTS apiKeys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT,
  machineId TEXT,
  isActive INTEGER DEFAULT 1,
  createdAt TEXT NOT NULL,
  accessRestricted INTEGER DEFAULT 0,
  accessAllow TEXT
);
CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key);

CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT,
  models TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# Stable IDs, reused from the live VM database so nothing else has to change.
GROQ_CONN_ID = "3c49453d-6b18-436f-a4a9-75668ad81da2"
OPENROUTER_CONN_ID = "f6589a4f-5a96-4640-8769-add495712668"
APIKEY_ID = "705e425f-8484-4dc4-a5da-7018d4f8fbb0"
COMBO_ID = "0ba81f81-7fd1-4e1f-9e1f-05387f7cf7e7"
APP_VERSION = "0.5.123"

# Combo "bansos-hunt": ONLY the working models, groq 120b LAST
# (the combo is answered by its last model).
COMBO_MODELS = [
    "groq/openai/gpt-oss-20b",
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/google/gemma-4-26b-a4b-it:free",
    "groq/openai/gpt-oss-120b",
]


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def machine_id():
    """Match what node-machine-id returns on Linux: /etc/machine-id."""
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(path) as f:
                value = f.read().strip()
            if value:
                return value
        except OSError:
            continue
    return uuid.uuid4().hex


def conn_data(api_key):
    return json.dumps({
        "apiKey": api_key,
        "testStatus": "available",
        "providerSpecificData": {
            "connectionProxyEnabled": False,
            "connectionProxyUrl": "",
            "connectionNoProxy": "",
        },
    })


def set_dashboard_password(cur, password):
    """Hash ROUTER_DASHBOARD_PASSWORD with bcrypt and store it in settings.
    Returns True if set, False if bcrypt is unavailable (caller warns)."""
    try:
        import bcrypt
    except ImportError:
        return False
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    row = cur.execute("SELECT data FROM settings WHERE id = 1").fetchone()
    data = {}
    if row:
        try:
            data = json.loads(row[0])
        except (ValueError, TypeError):
            data = {}
    data["password"] = hashed
    cur.execute(
        "INSERT INTO settings (id, data) VALUES (1, ?) "
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        (json.dumps(data),),
    )
    return True


def main():
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    router_key = os.environ.get("ROUTER_API_KEY", "").strip()
    dashboard_pw = os.environ.get("ROUTER_DASHBOARD_PASSWORD", "").strip()
    db_path = os.environ.get(
        "ROUTER_DB",
        os.path.join(os.path.expanduser("~"), ".9router", "db", "data.sqlite"),
    )

    missing = [
        name
        for name, value in (
            ("GROQ_API_KEY", groq_key),
            ("OPENROUTER_API_KEY", openrouter_key),
            ("ROUTER_API_KEY", router_key),
        )
        if not value
    ]
    if missing:
        print(f"seed: FATAL missing required env var(s): {', '.join(missing)}", file=sys.stderr)
        return 2
    if len(router_key) < 20:
        print("seed: FATAL ROUTER_API_KEY looks too short (min 20 chars)", file=sys.stderr)
        return 2

    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    try:
        cur = con.cursor()
        cur.executescript(SCHEMA)
        ts = now_iso()

        cur.execute(
            "INSERT INTO providerConnections "
            "(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) "
            "VALUES (?, 'groq', 'apikey', 'Groq', NULL, 1, 1, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "data = excluded.data, isActive = 1, updatedAt = excluded.updatedAt",
            (GROQ_CONN_ID, conn_data(groq_key), ts, ts),
        )
        cur.execute(
            "INSERT INTO providerConnections "
            "(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) "
            "VALUES (?, 'openrouter', 'apikey', 'OpenRouter', NULL, 1, 1, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "data = excluded.data, isActive = 1, updatedAt = excluded.updatedAt",
            (OPENROUTER_CONN_ID, conn_data(openrouter_key), ts, ts),
        )

        cur.execute(
            "INSERT INTO apiKeys "
            "(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) "
            "VALUES (?, ?, 'vm-local', ?, 1, ?, 0, '[]') "
            "ON CONFLICT(id) DO UPDATE SET "
            "key = excluded.key, machineId = excluded.machineId, isActive = 1",
            (APIKEY_ID, router_key, machine_id(), ts),
        )

        cur.execute(
            "INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) "
            "VALUES (?, 'bansos-hunt', NULL, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "models = excluded.models, updatedAt = excluded.updatedAt",
            (COMBO_ID, json.dumps(COMBO_MODELS), ts, ts),
        )

        cur.execute(
            "INSERT INTO _meta (key, value) VALUES ('schemaVersion', '1') "
            "ON CONFLICT(key) DO NOTHING"
        )
        cur.execute(
            "INSERT INTO _meta (key, value) VALUES ('appVersion', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (APP_VERSION,),
        )

        if dashboard_pw:
            if set_dashboard_password(cur, dashboard_pw):
                print("seed: dashboard password set from ROUTER_DASHBOARD_PASSWORD")
            else:
                print(
                    "seed: WARNING bcrypt not available, dashboard password NOT set. "
                    "Change it in the dashboard after first login (default is 123456).",
                    file=sys.stderr,
                )
        else:
            print(
                "seed: WARNING ROUTER_DASHBOARD_PASSWORD not set; dashboard keeps "
                "its current/default password. Set the env var and restart to fix.",
                file=sys.stderr,
            )

        con.commit()
    finally:
        con.close()

    print(f"seed: OK db={db_path}")
    print(f"seed: providers groq + openrouter (keys len {len(groq_key)}/{len(openrouter_key)})")
    print(f"seed: apiKey vm-local (len {len(router_key)}), combo bansos-hunt ({len(COMBO_MODELS)} models)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
