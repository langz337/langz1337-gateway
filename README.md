# 9Router + Telegram bot di Render (free tier, tanpa kartu)

Paket ini memindahkan gateway 9Router + bot Telegram Galang dari VM Muse
(yang diganti berkala sehingga semua service mati) ke **satu** service Render
free yang stabil. Setelah pindah, `langz1337.my.id` tetap jalan lewat
Cloudflare Tunnel yang sama — **tidak ada perubahan DNS**.

## Keputusan desain (kenapa begini)

| Keputusan | Alasan |
|---|---|
| **SATU service** (bukan dua) | Free tier Render = 750 jam/bulan per workspace. Satu service 24/7 pakai ~720 jam (muat). Dua service 24/7 pakai ~1440 jam → semua service free di-suspend tengah bulan. |
| **Satu container**: 9Router + cloudflared + bot + OpenCode | Semua ngobrol lewat localhost (cepat, tidak lewat internet publik). Bot memanggil 9Router di `127.0.0.1:20128`, tunnel meneruskan `langz1337.my.id` ke port yang sama. |
| **Seed config dari env var** (`seed.py`) | Filesystem Render free itu ephemeral: DB SQLite 9Router hilang tiap restart/deploy. `seed.py` membangun ulang provider + API key + combo dari env var di setiap boot. Usage history boleh hilang (cuma statistik). |
| **Keep-alive UptimeRobot** (gratis) | Render free tidur setelah 15 menit tanpa traffic. UptimeRobot ping `/health` tiap 5 menit supaya service tetap bangun. |
| **Ollama / model lokal TIDAK ikut** | Tetap di VM (atau di-drop). Gateway Render hanya pakai model cloud gratis (Groq + OpenRouter `:free`). |
| **Combo dipangkas** | `bansos-hunt` di Render hanya berisi model yang JALAN: `groq 20b`, `openrouter nemotron :free`, `openrouter gemma :free`, `groq 120b` (terakhir = yang menjawab). Zen (butuh OAuth), Muse (DNS mati), GLM (tanpa key) sengaja TIDAK dimasukkan. |
| **Region Singapore** | Paling dekat dengan Indonesia (latensi paling kecil). |

## Batasan free tier (jujur saja)

- **RAM 512 MB, CPU 0.1 (shared).** 9Router + bot + OpenCode agent jalan, tapi
  agent run bakal **lebih lambat** dari VM dan sesekali bisa kehabisan memori
  (OOM) kalau agent-nya lagi kerja berat. Kalau sudah tidak kuat, jalan naik
  kelas adalah Render Starter $7/bulan (0.5 CPU, 512 MB, tanpa tidur).
- **750 jam/bulan.** Satu service 24/7 muat tipis (744 jam di bulan 31 hari).
  Kalau service ke-suspend dekat akhir bulan, itu batas jamnya; hidup lagi
  tanggal 1 bulan berikutnya.
- **Bandwidth keluar 5 GB/bulan.** Pemakaian gateway ini kecil (teks saja),
  jadi aman kecuali ada yang download besar lewat gateway.
- **Build 500 menit/bulan.** Satu build Docker ini sekitar 3–6 menit.
- **Tidak ada disk persisten.** Itu sebabnya config di-seed dari env var.
  Jangan simpan file penting di dalam container; semua yang penting ada
  di env var atau di repo.
- **Bot tetap batas 5 menit per agent run** (sama seperti di VM).

## Yang dibutuhkan sebelum deploy

1. **Akun Render** (gratis, tanpa kartu): daftar di `render.com` pakai
   GitHub (`langz337`) atau email. Tidak butuh kartu.
2. **Repo GitHub baru** (publik atau privat, terserah): isi repo ini =
   seluruh isi folder `render-deploy/` (Dockerfile, render.yaml, start.sh,
   seed.py, health.js, bot/, .dockerignore). JANGAN taruh file ini di repo
   yang sama dengan hal lain; repo ini khusus gateway.
3. **Nilai env var** (diisi di dashboard Render, BUKAN di file):
   | Env var | Dari mana | Wajib |
   |---|---|---|
   | `GROQ_API_KEY` | Key Groq Galang (yang dipakai 9Router di VM; tersimpan di `~/.config/opencode/ai-keys.env` mode 600 di VM) | Ya |
   | `OPENROUTER_API_KEY` | Key OpenRouter Galang (file yang sama di VM) | Ya |
   | `ROUTER_API_KEY` | **Dibuat otomatis oleh Render** (`generateValue` di render.yaml). Ini key `/v1` baru untuk gateway Render. Lihat nilainya di dashboard Render → Environment setelah deploy, kalau perlu dipakai di tempat lain. | Ya (otomatis) |
   | `ROUTER_DASHBOARD_PASSWORD` | Password BARU untuk login dashboard 9Router (pilih sendiri, yang kuat). JANGAN pakai `123456` (itu password bawaan = CVE publik). | Ya |
   | `TELEGRAM_BOT_TOKEN` | Token bot `@langz337_bot` (tersimpan di `~/workspace/telegram-bot/config.json` mode 600 di VM) | Ya (kalau bot mau jalan) |
   | `TUNNEL_TOKEN` | Token tunnel Cloudflare `langz1337-gateway` (tersimpan di `~/workspace/cloudflare-tunnel/token` mode 600 di VM) | Ya (kalau `langz1337.my.id` mau jalan) |
   | `BOT_ALLOW_CHAT_ID` | Sudah diisi di render.yaml: `7690336317` (chat Galang). | Tidak |

   **JANGAN pernah commit nilai-nilai di atas ke GitHub.** Semuanya diisi
   di dashboard Render saja.

## Langkah deploy (urut)

### 1. Push paket ini ke GitHub
```bash
# di VM (atau di mana saja), buat repo GitHub baru (mis. langz337/langz1337-gateway),
# lalu:
cd ~/workspace/render-deploy
git init
git add .
git commit -m "9Router + Telegram bot di Render (free)"
git branch -M main
git remote add origin https://github.com/langz337/langz1337-gateway.git
git push -u origin main
```

### 2. Buat service di Render
- Login ke `dashboard.render.com` → **New +** → **Blueprint** (atau **Web Service**
  kalau mau manual; Blueprint lebih gampang karena `render.yaml` sudah ada).
- Pilih repo `langz337/langz1337-gateway`, branch `main`.
- Render membaca `render.yaml` dan membuat service `langz1337-gateway`
  (Docker, plan **free**, region **Singapore**).
- Saat diminta env var, isi semua yang `sync: false` di atas.
  `ROUTER_API_KEY` akan terisi otomatis (generateValue).
- Klik **Apply** / **Create**. Tunggu build selesai (3–6 menit).

### 3. Verifikasi service hidup
- Di dashboard Render, buka service → tab **Logs**. Harus ada baris:
  `seed: OK`, `9Router ready`, `cloudflared started`, `health proxy started`,
  `Telegram bot started`.
- Buka `https://<nama-service>.onrender.com/health` → harus `{"ok":true}`.
- Buka `https://<nama-service>.onrender.com/v1/models` → harus daftar model
  (groq + openrouter). Kalau ini 200, 9Router jalan.
- Cek dashboard 9Router di `https://<nama-service>.onrender.com/` → login
  pakai password `ROUTER_DASHBOARD_PASSWORD`. Di halaman Providers harus
  ada **Groq** dan **OpenRouter** (hijau/aktif). Di halaman Usage harus
  muncul request setelah ada yang memakai gateway.

### 4. Tes gateway dari luar (penting)
```bash
# ganti <key> dengan nilai ROUTER_API_KEY dari dashboard Render,
# dan <service> dengan nama service Render:
curl -s -X POST https://<service>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"groq/openai/gpt-oss-120b","messages":[{"role":"user","content":"jawab satu kata: PONG"}],"max_tokens":20}'
```
Harus kembali HTTP 200 + jawaban. Kalau 401, key-nya salah. Kalau 404
`model_not_found`, seed combo/provider belum masuk (cek log seed).

### 5. Pasang UptimeRobot (keep-alive, gratis)
- Daftar di `uptimerobot.com` (email saja, tanpa kartu).
- **Add New Monitor** → Type **HTTP(s)** → Friendly Name `langz1337-gateway`
  → URL `https://<nama-service>.onrender.com/health`
  → Monitoring Interval **5 minutes** → Create.
- Ini yang mencegah service tidur (Render tidur setelah 15 menit sepi).
  Tanpa ini, bot Telegram akan diam sampai ada yang membuka URL-nya.

### 6. Verifikasi `langz1337.my.id`
- Tunggu ~1 menit setelah cloudflared jalan, lalu buka
  `https://langz1337.my.id/` dari HP. Harus muncul login dashboard 9Router
  (bukan Error 1033).
- Kalau masih 1033: cek log cloudflared di Render
  (`/tmp/cloudflared.log` di Logs). Penyebab umum: `TUNNEL_TOKEN` salah,
  atau cloudflared belum sempat konek (tunggu 1–2 menit).
- Catatan: selama cloudflared di VM **dan** di Render sama-sama jalan,
  Cloudflare membagi traffic ke keduanya. Itu sebabnya langkah 7 penting.

### 7. Matikan service di VM (setelah Render terverifikasi)
Setelah langkah 3–6 hijau, matikan gateway di VM supaya semua traffic
hanya ke Render (dan VM tidak buang RAM):
```bash
# cari PID lalu kill (jangan pakai pkill -f dengan pola literal!):
ps -eo pid,args | grep -E '[9]router|[c]loudflared|[n]ode bot.js'
kill <PID 9router> <PID cloudflared> <PID bot>
# Ollama boleh tetap jalan di VM (tidak ada hubungannya dengan gateway).
```
Kalau Render bermasalah, hidupkan lagi VM dengan:
`bash ~/workspace/restart-services.sh`
(itu script restart VM yang sudah ada).

### 8. Tes bot Telegram
- Chat `@langz337_bot`, kirim `/start` → harus dibalas.
- Kirim pesan biasa (mis. `tes`) → bot menjalankan agent dan membalas.
  Agent run pertama bisa lambat (cold start + CPU 0.1).

## Troubleshooting

| Gejala | Penyebab / perbaikan |
|---|---|
| Build gagal di `npm install -g 9router` | Cek log build Render. Biasanya network/npm sesaat; klik **Manual Deploy** → **Deploy latest commit** untuk coba lagi. |
| Log: `seed: FATAL missing required env var` | Ada env var wajib yang belum diisi di dashboard Render → Environment. Isi, lalu redeploy. |
| Log: `9Router did not answer ... clean-boot fallback` | Seed DB bermasalah. Cek log; kalau fallback juga gagal, lihat `/tmp/9router.log` di Logs Render. |
| `/v1/models` 200 tapi chat 404 `model_not_found` | Combo/provider belum ke-seed. Cek log ada `seed: OK` atau tidak; pastikan `GROQ_API_KEY`/`OPENROUTER_API_KEY` benar. |
| `/v1/chat/completions` 401 | `ROUTER_API_KEY` yang dipakai di request beda dengan yang di dashboard Render → Environment. Salin ulang dari dashboard. |
| `langz1337.my.id` Error 1033 | cloudflared di Render belum konek. Cek `TUNNEL_TOKEN` benar; tunggu 2 menit; cek log cloudflared. Kalau VM masih menjalankan cloudflared juga, matikan yang di VM (langkah 7). |
| Bot tidak membalas | Cek `TELEGRAM_BOT_TOKEN` benar; cek log bot (`/tmp/bot.log` di Logs Render). Bot hanya membalas chat yang ada di allowlist (`BOT_ALLOW_CHAT_ID`). |
| Service tidur / bot lambat balas pertama | UptimeRobot belum dipasang atau monitor-nya mati. Pasang/cek monitor (langkah 5). Cold start Render free ~30–60 detik itu normal. |
| Service di-suspend dekat akhir bulan | Batas 750 jam/bulan habis. Hidup lagi tanggal 1. Solusi: kurangi jam (biarkan tidur di malam hari dengan mematikan monitor UptimeRobot), atau naik ke Starter $7/bulan. |
| Dashboard 9Router minta password dan `123456` tidak jalan | `ROUTER_DASHBOARD_PASSWORD` sudah di-set oleh seed. Pakai password itu. Kalau lupa, lihat di dashboard Render → Environment. |

## File di paket ini

| File | Fungsi |
|---|---|
| `Dockerfile` | Image: Node 24 + cloudflared + 9router 0.5.123 + opencode-ai 1.19.6 + python3-bcrypt + `script`/`pkill`. |
| `render.yaml` | Blueprint Render: 1 Docker web service, plan free, region Singapore, health check `/health`. |
| `start.sh` | Entrypoint: seed → 9Router → cloudflared → health proxy → bot → monitor loop (restart service yang mati). |
| `seed.py` | Membangun ulang config 9Router (groq + openrouter, key `vm-local`, combo `bansos-hunt`) dari env var. Idempotent. |
| `health.js` | Server HTTP di `$PORT`: `/health` (200) + reverse-proxy ke 9Router :20128 (dashboard/API via onrender.com). |
| `bot/bot.js` | Bot Telegram (mode agent via OpenCode). Config dari env var (`TELEGRAM_BOT_TOKEN`, `BOT_ALLOW_CHAT_ID`); `config.json` hanya fallback. |
| `bot/opencode.json` | Config OpenCode untuk bot: provider `9router` → `http://127.0.0.1:20128/v1`, key `{env:ROUTER_API_KEY}`, model default `9router/bansos-hunt`. |
| `bot/agent-work/.gitkeep` | Workdir agent run. |
| `.dockerignore` | Yang tidak ikut ke image Docker. |

## Yang masih perlu dicek saat deploy pertama (belum bisa diverifikasi dari VM)

- [ ] 9Router 0.5.123 mau jalan dan memuat DB hasil seed di container Render
      (sudah dites di level DB; runtime di Render belum).
- [ ] `cloudflared` bisa resolve `region1/2.v2.argotunnel.com` lewat DNS
      biasa di Render (di VM butuh bind-mount /etc/hosts; di Render DNS-nya
      normal, jadi seharusnya langsung jalan — kalau gagal, log cloudflared
      akan menunjukkan `DNS prerequisite failed`).
- [ ] OpenCode 1.19.6 mau jalan + butuh TTY (`script`) di container Render.
- [ ] Agent run di CPU 0.1 / RAM 512 MB tidak OOM dan selesai < 5 menit.
- [ ] UptimeRobot benar-benar mencegah tidur (cek setelah 1 jam: service
      tetap bangun dan bot membalas cepat).
