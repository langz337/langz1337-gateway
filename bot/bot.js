// Telegram bot -> OpenCode agent (via 9Router gateway, Render version)
// Long polling, Node 24 native fetch + child_process.
// Config from ENVIRONMENT (Render dashboard), config.json is only a fallback:
//   TELEGRAM_BOT_TOKEN   - bot token from @BotFather (required)
//   BOT_ALLOW_CHAT_ID    - single allowed chat id (e.g. 7690336317), or
//   BOT_ALLOW_CHAT_IDS   - comma-separated allowed chat ids
//   (empty = allow everyone; the sender id is logged)
// OpenCode reads its own config from $HOME/.config/opencode/opencode.json
// (9router provider -> http://127.0.0.1:20128/v1, key from {env:ROUTER_API_KEY}).
// Every user message = one agent run (opencode run, model 9router/bansos-hunt).
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function loadConfig() {
  const cfg = { telegramToken: '', allowChatIds: [] };
  const jsonPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const file = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      cfg.telegramToken = file.telegramToken || '';
      cfg.allowChatIds = file.allowChatIds || [];
    } catch (e) {
      console.error('config.json unreadable:', e.message);
    }
  }
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const ids = process.env.BOT_ALLOW_CHAT_IDS || process.env.BOT_ALLOW_CHAT_ID || '';
  if (ids.trim()) {
    cfg.allowChatIds = ids.split(',').map((s) => Number(s.trim())).filter((n) => n);
  }
  return cfg;
}

const cfg = loadConfig();
if (!cfg.telegramToken) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN not set (and no config.json with a token).');
  process.exit(1);
}
const TG = 'https://api.telegram.org/bot' + cfg.telegramToken;
const WORKDIR = path.join(__dirname, 'agent-work');
fs.mkdirSync(WORKDIR, { recursive: true });
const MODEL = '9router/bansos-hunt';
const SYSTEM = 'Kamu adalah asisten AI untuk bug bounty hunting dan keamanan siber. Jawab singkat, jelas, pakai Bahasa Indonesia sehari-hari. Kalau diminta mengecek, menguji, atau hunting sesuatu, pakai tools yang ada (baca file, jalankan perintah, cek URL) untuk verifikasi langsung, jangan karang hasil. Kalau sesuatu gagal, bilang gagalnya di mana dan kenapa.';
const history = new Map(); // chatId -> [{role, content}]
const allow = new Set(cfg.allowChatIds || []); // kosong = izinkan semua (ID pengirim dicatat di log)
let busy = false;

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function tg(method, body) {
  const r = await fetch(TG + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram ' + method + ': ' + (j.description || r.status));
  return j.result;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function parseAgentJson(stdout) {
  const texts = [];
  for (const line of stripAnsi(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') texts.push(ev.part.text);
    } catch (e) { /* bukan JSON, lewati */ }
  }
  return texts.join('').trim();
}

function killAgentTree() {
  return new Promise((resolve) => {
    // bunuh semua opencode run di workdir bot; pola dipecah supaya shell cleanup tidak match dirinya sendiri
    exec('A=\'opencode run\'; B=\'agent-work\'; pkill -f "$A.*$B"', () => resolve());
  });
}

function runAgent(prompt) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(prompt, 'utf8').toString('base64');
    const inner = 'P=$(echo ' + b64 + ' | base64 -d); exec opencode run --model ' + MODEL + ' --auto --format json --dir ' + WORKDIR + ' "$P"';
    const cmd = 'script -qec \'' + inner + '\' /dev/null';
    exec(cmd, {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: WORKDIR,
      env: Object.assign({}, process.env),
    }, (err, stdout, stderr) => {
      if (err) {
        // timeout/gagal: bersihkan opencode yang nyangkut supaya tidak jadi zombie dan tidak makan kuota
        killAgentTree().then(() => {
          if (err.killed) return reject(new Error('agent kehabisan waktu (5 menit)'));
          if (!stdout) return reject(new Error('opencode gagal jalan: ' + String(err.message).slice(0, 200)));
          const text = parseAgentJson(stdout || '');
          if (text) return resolve(text);
          reject(new Error('agent tidak kasih jawaban'));
        });
        return;
      }
      const text = parseAgentJson(stdout || '');
      if (text) return resolve(text);
      const raw = stripAnsi(stdout || '').trim();
      if (raw) return resolve(raw.slice(-3000));
      reject(new Error('agent tidak kasih jawaban'));
    });
  });
}

function splitText(text, n) {
  n = n || 4000;
  if (text.length <= n) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > n) {
    let cut = rest.lastIndexOf('\n', n);
    if (cut < 500) cut = n;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

async function handleUpdate(u) {
  const m = u.message;
  if (!m || typeof m.text !== 'string') return;
  const chatId = m.chat.id;
  log('from', chatId, (m.from && m.from.username) || '', ':', m.text.slice(0, 100));
  if (allow.size > 0 && !allow.has(chatId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Maaf, bot ini privat.' }).catch(() => {});
    return;
  }
  if (m.text.trim() === '/start') {
    await tg('sendMessage', { chat_id: chatId, text: 'Halo boss, aku bot agent 9Router. Kirim perintah apa aja, nanti aku jalanin pakai OpenCode. Contoh: "cek apakah langz1337.my.id masih hidup" atau "cari info soal XSS di...". Ketik /reset buat hapus riwayat chat.' });
    return;
  }
  if (m.text.trim() === '/reset') {
    history.delete(chatId);
    await tg('sendMessage', { chat_id: chatId, text: 'Riwayat chat dihapus.' });
    return;
  }
  if (busy) {
    await tg('sendMessage', { chat_id: chatId, text: 'Masih jalan, tunggu bentar ya boss.' }).catch(() => {});
    return;
  }
  busy = true;
  const h = history.get(chatId) || [];
  const ctx = h.slice(-4).map((x) => (x.role === 'user' ? 'User: ' : 'Asisten: ') + x.content).join('\n');
  const prompt = SYSTEM + '\n\n' + (ctx ? 'Riwayat chat:\n' + ctx + '\n\n' : '') + 'Pesan user: ' + m.text;
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const typingTimer = setInterval(() => { tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); }, 4000);
  const progressTimer = setTimeout(() => {
    tg('sendMessage', { chat_id: chatId, text: 'Lagi jalan, bentar ya boss.' }).catch(() => {});
  }, 30000);
  try {
    const reply = await runAgent(prompt);
    h.push({ role: 'user', content: m.text });
    h.push({ role: 'assistant', content: reply });
    history.set(chatId, h.slice(-20));
    for (const part of splitText(reply)) {
      await tg('sendMessage', { chat_id: chatId, text: part });
    }
  } catch (e) {
    log('ERR', e.message);
    await tg('sendMessage', { chat_id: chatId, text: 'Maaf boss, agent gagal: ' + String(e.message).slice(0, 300) }).catch(() => {});
  } finally {
    clearInterval(typingTimer);
    clearTimeout(progressTimer);
    busy = false;
  }
}

async function poll() {
  let offset = 0;
  log('bot agent jalan, model:', MODEL, 'workdir:', WORKDIR);
  for (;;) {
    try {
      const r = await fetch(TG + '/getUpdates?offset=' + offset + '&timeout=30');
      const j = await r.json();
      if (!j.ok) throw new Error('getUpdates: ' + (j.description || r.status));
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (e) {
      log('poll err:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

poll();
