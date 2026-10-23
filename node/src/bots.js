// AVM Discord bot hosting: Node.js (JavaScript), Node.js (TypeScript via tsx) and Python bots,
// each in its own Docker container with CPU/RAM/disk limits, auto dependency install and a live console.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const mountFiles = require('./files');

const BOT_RE = /^bot-[a-f0-9]{8}$/;
const MAIN_RE = /^(?!.*\.\.)[\w][\w./-]{0,119}$/;
const LANGS = {
  node: { label: 'Node.js', versions: ['22', '20', '24'], image: (v) => `node:${v}-bookworm-slim`, main: 'index.js' },
  ts: { label: 'Node.js (TypeScript)', versions: ['22', '20', '24'], image: (v) => `node:${v}-bookworm-slim`, main: 'index.ts' },
  python: { label: 'Python', versions: ['3.12', '3.13', '3.11'], image: (v) => `python:${v}-slim`, main: 'main.py' },
};
// startup scripts (main file / custom command / install switch come in as env vars, so nothing is quoted into shell code)
const SCRIPT = {
  node: `echo "[AVM] Node.js $(node -v)"
if [ "$AVM_INSTALL" = 1 ] && [ -f package.json ]; then echo "[AVM] npm install ..."; npm install --no-audit --no-fund --loglevel=error || echo "[AVM] npm install failed"; fi
if [ -n "$AVM_START" ]; then echo "[AVM] $AVM_START"; exec sh -c "$AVM_START"; fi
[ -f "$AVM_MAIN" ] || { echo "[AVM] $AVM_MAIN not found - upload your bot in the File manager or change the main file in Settings"; exit 1; }
echo "[AVM] starting node $AVM_MAIN"; exec node "$AVM_MAIN"`,
  ts: `echo "[AVM] Node.js $(node -v) + TypeScript (tsx)"
if [ "$AVM_INSTALL" = 1 ] && [ -f package.json ]; then echo "[AVM] npm install ..."; npm install --no-audit --no-fund --loglevel=error || echo "[AVM] npm install failed"; fi
if [ -n "$AVM_START" ]; then echo "[AVM] $AVM_START"; exec sh -c "$AVM_START"; fi
[ -f "$AVM_MAIN" ] || { echo "[AVM] $AVM_MAIN not found - upload your bot in the File manager or change the main file in Settings"; exit 1; }
echo "[AVM] starting tsx $AVM_MAIN"; exec npx --yes tsx "$AVM_MAIN"`,
  python: `echo "[AVM] $(python -V)"
[ -x .venv/bin/python ] || { echo "[AVM] creating virtualenv .venv"; python -m venv .venv; }
. .venv/bin/activate
if [ "$AVM_INSTALL" = 1 ] && [ -f requirements.txt ]; then echo "[AVM] pip install -r requirements.txt ..."; pip install --disable-pip-version-check -q -r requirements.txt || echo "[AVM] pip install failed"; fi
if [ -n "$AVM_START" ]; then echo "[AVM] $AVM_START"; exec sh -c "$AVM_START"; fi
[ -f "$AVM_MAIN" ] || { echo "[AVM] $AVM_MAIN not found - upload your bot in the File manager or change the main file in Settings"; exit 1; }
echo "[AVM] starting python $AVM_MAIN"; exec python -u "$AVM_MAIN"`,
};
const STARTER = {
  node: {
    'index.js': `// Discord bot (discord.js v14). Put your token in Settings -> Environment: DISCORD_TOKEN=...
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => console.log(\`Logged in as \${client.user.tag}\`));
client.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  if (msg.content === '!ping') msg.reply('Pong! 🏓');
});

if (!process.env.DISCORD_TOKEN) { console.log('DISCORD_TOKEN is not set - add it in Settings -> Environment variables'); process.exit(1); }
client.login(process.env.DISCORD_TOKEN);
`,
    'package.json': JSON.stringify({ name: 'discord-bot', version: '1.0.0', main: 'index.js', dependencies: { 'discord.js': '^14.16.3' } }, null, 2) + '\n',
  },
  ts: {
    'index.ts': `// Discord bot (discord.js v14, TypeScript run by tsx). Token: Settings -> Environment: DISCORD_TOKEN=...
import { Client, GatewayIntentBits, Message } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => console.log(\`Logged in as \${client.user?.tag}\`));
client.on('messageCreate', (msg: Message) => {
  if (msg.author.bot) return;
  if (msg.content === '!ping') msg.reply('Pong! 🏓');
});

if (!process.env.DISCORD_TOKEN) { console.log('DISCORD_TOKEN is not set - add it in Settings -> Environment variables'); process.exit(1); }
client.login(process.env.DISCORD_TOKEN);
`,
    'package.json': JSON.stringify({ name: 'discord-bot', version: '1.0.0', type: 'module', main: 'index.ts', dependencies: { 'discord.js': '^14.16.3' }, devDependencies: { tsx: '^4.19.2', typescript: '^5.6.3' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, esModuleInterop: true, skipLibCheck: true } }, null, 2) + '\n',
  },
  python: {
    'main.py': `# Discord bot (discord.py 2.x). Put your token in Settings -> Environment: DISCORD_TOKEN=...
import os
import discord

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)


@client.event
async def on_ready():
    print(f"Logged in as {client.user}")


@client.event
async def on_message(message):
    if message.author.bot:
        return
    if message.content == "!ping":
        await message.reply("Pong! 🏓")


token = os.environ.get("DISCORD_TOKEN")
if not token:
    print("DISCORD_TOKEN is not set - add it in Settings -> Environment variables")
    raise SystemExit(1)
client.run(token)
`,
    'requirements.txt': 'discord.py>=2.4\n',
  },
};

module.exports = function bots(ctx) {
  const { app, docker, cfg, S, save, err, wrap, cleanPath, multer, DOCKER_NET } = ctx;
  const ROOT = cfg.botRoot || '/var/lib/avm-bots';
  S.bots = S.bots || {};
  const rt = {}; // name -> { busy, step, error }
  const cache = { du: {}, cpu: {} };
  const ct = (name) => 'avm-' + name;
  const dir = (name) => path.join(ROOT, name);
  const pick = (req) => { const n = req.params.name; if (!BOT_RE.test(n) || !S.bots[n]) throw err(404, 'Bot not found on this node'); return n; };
  const sh = (bin, args, opts = {}) => new Promise((resolve) => { execFile(bin, args, { timeout: opts.timeout || 60000, maxBuffer: 16 * 1048576 }, (e, out, se) => resolve({ ok: !e, out: String(out || ''), err: String(se || '') })); });
  const ctState = async (n) => { try { return (await docker.inspect(n)).State.Status; } catch { return null; } };
  const image = (b) => LANGS[b.lang].image(b.version);

  async function diskUsage(name) {
    const c = cache.du[name];
    if (c && Date.now() - c.at < 60000) return c.bytes;
    const r = await sh('du', ['-sb', dir(name)], { timeout: 30000 });
    const bytes = parseInt(r.out, 10) || 0;
    cache.du[name] = { at: Date.now(), bytes };
    return bytes;
  }
  async function quota(name, extra = 0) {
    delete cache.du[name];
    if ((await diskUsage(name)) + extra > S.bots[name].disk * 1073741824) throw err(507, `Disk limit reached (${S.bots[name].disk} GB) - delete files or ask an admin for more space`);
  }

  function cleanEnv(list) {
    const env = (Array.isArray(list) ? list : String(list || '').split('\n')).map((l) => String(l).trim()).filter((l) => l && !l.startsWith('#'));
    if (env.length > 50) throw err(400, 'Max 50 environment variables');
    for (const e of env) if (!/^[A-Za-z_][A-Za-z0-9_]*=[^\0\n]{0,4000}$/.test(e)) throw err(400, 'Bad environment line: ' + e.slice(0, 40) + ' (use KEY=value)');
    return env;
  }
  function applySettings(b, x) {
    if (x.lang !== undefined) { if (!LANGS[x.lang]) throw err(400, 'Language must be node, ts or python'); b.lang = x.lang; }
    if (x.version !== undefined || x.lang !== undefined) b.version = LANGS[b.lang].versions.includes(x.version) ? x.version : LANGS[b.lang].versions[0];
    if (x.main !== undefined) { const m = String(x.main).trim(); if (!MAIN_RE.test(m)) throw err(400, 'Main file: a path inside the bot folder, e.g. index.js or src/bot.py'); b.main = m; }
    if (x.startCmd !== undefined) { const s = String(x.startCmd).trim(); if (s.length > 400 || /[\0\n]/.test(s)) throw err(400, 'Start command: one line, max 400 characters'); b.startCmd = s; }
    if (x.env !== undefined) b.env = cleanEnv(x.env);
    if (x.install !== undefined) b.install = !!x.install;
    if (x.autoRestart !== undefined) b.autoRestart = !!x.autoRestart;
  }

  // ---------- container lifecycle ----------
  async function pullIfMissing(img, r) {
    const have = await docker.api('GET', `/images/${encodeURIComponent(img)}/json`).then(() => true).catch(() => false);
    if (!have) { if (r) r.step = 'Downloading ' + img; await docker.run(['pull', img], { timeout: 30 * 60000 }); }
  }
  async function startBot(name) {
    const b = S.bots[name];
    const r = rt[name] = { busy: true, step: 'Preparing', error: null };
    try {
      await pullIfMissing(image(b), r);
      r.step = 'Starting';
      await docker.run(['rm', '-f', ct(name)]).catch(() => {});
      const args = ['run', '-d', '-it', '--name', ct(name), '--hostname', name, '--network', DOCKER_NET,
        `--cpus=${b.cpu}`, `--memory=${b.memory}m`, `--memory-swap=${b.memory}m`, '--pids-limit=512',
        '--restart', b.autoRestart ? 'unless-stopped' : 'no', '--label', 'avm=1', '--label', `avm.bot=${name}`,
        '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
        '-v', `${dir(name)}:/home/container`, '-w', '/home/container',
        '-e', `AVM_MAIN=${b.main}`, '-e', `AVM_START=${b.startCmd || ''}`, '-e', `AVM_INSTALL=${b.install ? 1 : 0}`, '-e', 'TERM=xterm-256color', '-e', 'HOME=/home/container',
        '-e', 'npm_config_cache=/home/container/.npm', '-e', 'PIP_CACHE_DIR=/home/container/.cache/pip'];
      for (const e of b.env || []) args.push('-e', e);
      args.push(image(b), 'sh', '-c', SCRIPT[b.lang]);
      await docker.run(args, { timeout: 120000 });
      b.stopped = false; save();
      rt[name] = { busy: false, error: null };
    } catch (e) {
      console.error('[avm-bots] start failed', name, e.message);
      rt[name] = { busy: false, error: e.message };
    }
  }

  // ---------- API ----------
  app.post('/api/bots', wrap(async (req, res) => {
    if (!(await docker.available()).ok) throw err(400, 'Bot hosting needs Docker on this node');
    const x = req.body;
    if (!BOT_RE.test(x.name || '')) throw err(400, 'bad bot name');
    if (S.bots[x.name]) throw err(409, 'Bot already exists');
    if (!LANGS[x.lang]) throw err(400, 'Language must be node, ts or python');
    const b = { lang: x.lang, version: '', main: LANGS[x.lang].main, startCmd: '', env: [], install: true, autoRestart: true,
      cpu: Math.max(0.25, Math.min(32, +x.cpu || 1)), memory: Math.max(64, +x.memory || 512), disk: Math.max(1, +x.disk || 2), stopped: true, suspended: false, createdAt: Date.now() };
    applySettings(b, { lang: x.lang, version: x.version, main: x.main || LANGS[x.lang].main, env: x.env || [] });
    S.bots[x.name] = b; save();
    await fsp.mkdir(dir(x.name), { recursive: true });
    if (x.starter !== false) for (const [f, c] of Object.entries(STARTER[b.lang])) if (!fs.existsSync(path.join(dir(x.name), f))) await fsp.writeFile(path.join(dir(x.name), f), c);
    // pull the runtime image now so the first start is quick
    rt[x.name] = { busy: true, step: 'Downloading ' + image(b), error: null };
    pullIfMissing(image(b)).then(() => { rt[x.name] = { busy: false, error: null }; }).catch((e) => { rt[x.name] = { busy: false, error: e.message }; });
    res.json({ ok: true });
  }));

  app.get('/api/bots/:name/status', wrap(async (req, res) => {
    const name = pick(req), b = S.bots[name], r = rt[name] || {};
    const out = { lang: b.lang, version: b.version, main: b.main, startCmd: b.startCmd, env: b.env, install: b.install, autoRestart: b.autoRestart, image: image(b),
      busy: !!r.busy, step: r.step || null, error: r.error || null, suspended: !!b.suspended,
      cpu: 0, cpus: b.cpu, memory: 0, memLimit: b.memory * 1048576, disk: await diskUsage(name), diskLimit: b.disk * 1073741824, netRx: 0, netTx: 0, processes: 0, uptime: 0, exitCode: null, restarts: 0 };
    let info = null; try { info = await docker.inspect(ct(name)); } catch {}
    if (r.busy) out.state = 'installing';
    else if (b.suspended) out.state = 'suspended';
    else if (!info) out.state = r.error ? 'error' : 'stopped';
    else {
      const s = info.State;
      out.state = s.Running ? (s.Restarting ? 'restarting' : 'running') : s.Restarting ? 'restarting' : 'stopped';
      out.exitCode = s.Running ? null : s.ExitCode;
      out.restarts = info.RestartCount || 0;
      if (s.Running) out.uptime = Date.now() - new Date(s.StartedAt).getTime();
      if (s.Running) {
        try {
          const j = await docker.api('GET', `/containers/${ct(name)}/stats?stream=false&one-shot=true`, 8000);
          const ns = j.cpu_stats.cpu_usage.total_usage, now = Date.now(), p = cache.cpu[name];
          if (p && ns >= p.ns) out.cpu = +(((ns - p.ns) / ((now - p.at) * 1e6)) / b.cpu * 100).toFixed(1);
          cache.cpu[name] = { ns, at: now };
          const m = j.memory_stats || {}, ms = m.stats || {};
          out.memory = Math.max(0, (m.usage || 0) - (ms.inactive_file || ms.total_inactive_file || 0));
          out.processes = (j.pids_stats && j.pids_stats.current) || 0;
          for (const n of Object.values(j.networks || {})) { out.netRx += n.rx_bytes || 0; out.netTx += n.tx_bytes || 0; }
        } catch {}
      }
    }
    res.json(out);
  }));

  app.post('/api/bots/:name/power', wrap(async (req, res) => {
    const name = pick(req), b = S.bots[name], a = req.body.action;
    if (!['start', 'stop', 'restart', 'kill'].includes(a)) throw err(400, 'bad action');
    if (rt[name] && rt[name].busy) throw err(409, 'Please wait - the bot is being prepared');
    if (b.suspended && a !== 'stop' && a !== 'kill') throw err(403, 'This bot is suspended');
    if (a === 'stop') { await docker.run(['stop', '-t', '10', ct(name)], { timeout: 60000 }).catch(() => {}); b.stopped = true; save(); }
    else if (a === 'kill') { await docker.run(['kill', ct(name)]).catch(() => {}); b.stopped = true; save(); }
    else { // start / restart always recreate the container, so new settings apply
      if (a === 'restart') await docker.run(['stop', '-t', '10', ct(name)], { timeout: 60000 }).catch(() => {});
      await startBot(name);
      if (rt[name].error) throw err(500, rt[name].error);
    }
    res.json({ ok: true });
  }));

  app.put('/api/bots/:name/settings', wrap(async (req, res) => {
    const name = pick(req), b = S.bots[name];
    applySettings(b, req.body);
    save();
    res.json({ ok: true, restartNeeded: (await ctState(ct(name))) === 'running' });
  }));
  app.post('/api/bots/:name/reinstall', wrap(async (req, res) => { // wipe node_modules / .venv so the next start installs fresh
    const name = pick(req);
    for (const d of ['node_modules', '.venv', '.npm', '.cache']) await fsp.rm(path.join(dir(name), d), { recursive: true, force: true });
    delete cache.du[name];
    res.json({ ok: true });
  }));
  app.patch('/api/bots/:name', wrap(async (req, res) => {
    const name = pick(req), b = S.bots[name], x = req.body;
    if (x.cpu) b.cpu = Math.max(0.25, Math.min(32, +x.cpu));
    if (x.memory) b.memory = Math.max(64, +x.memory);
    if (x.disk) b.disk = Math.max(1, +x.disk);
    save();
    if (x.cpu || x.memory) await docker.run(['update', `--cpus=${b.cpu}`, `--memory=${b.memory}m`, `--memory-swap=${b.memory}m`, ct(name)]).catch(() => {});
    res.json({ ok: true });
  }));
  app.post('/api/bots/:name/suspend', wrap(async (req, res) => {
    const name = pick(req), b = S.bots[name];
    b.suspended = !!req.body.suspended;
    if (b.suspended) { await docker.run(['stop', '-t', '10', ct(name)], { timeout: 60000 }).catch(() => {}); b.stopped = true; }
    save();
    res.json({ ok: true });
  }));
  app.delete('/api/bots/:name', wrap(async (req, res) => {
    const name = pick(req);
    await docker.run(['rm', '-f', ct(name)]).catch(() => {});
    delete S.bots[name]; delete rt[name]; delete cache.du[name]; save();
    const d = dir(name);
    if (d.startsWith(ROOT + '/') && BOT_RE.test(path.basename(d))) await fsp.rm(d, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  mountFiles(app, '/api/bots/:name', { pick, base: dir, wrap, err, cleanPath, multer, quota, touched: (n) => { delete cache.du[n]; } });

  // ---------- live console: output = docker logs -f, input = docker attach (stdin only) ----------
  function attachStdin(name) {
    return new Promise((resolve, reject) => {
      const q = http.request({ socketPath: docker.SOCK, method: 'POST', path: `/containers/${ct(name)}/attach?stream=1&stdin=1`, headers: { Connection: 'Upgrade', Upgrade: 'tcp' } });
      q.on('upgrade', (r, sock) => resolve(sock));
      q.on('response', (r) => { r.resume(); reject(new Error('attach failed: ' + r.statusCode)); });
      q.on('error', reject);
      q.end();
    });
  }
  async function onConsole(ws, name) {
    const say = (t) => { if (ws.readyState === 1) ws.send(t); };
    const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
    const st = await ctState(ct(name));
    if (!st) { say('\x1b[36m[AVM]\x1b[0m The bot has not been started yet. Press Start.\r\n'); return ws.close(); }
    let logs = null, stdin = null, closed = false;
    const cleanup = () => { closed = true; try { logs && logs.kill(); } catch {} try { stdin && stdin.destroy(); } catch {} };
    logs = spawn(docker.BIN, ['logs', '--tail', '300', ...(st === 'running' || st === 'restarting' ? ['-f'] : []), ct(name)]);
    logs.stdout.on('data', (d) => say(crlf(d.toString())));
    logs.stderr.on('data', (d) => say(crlf(d.toString())));
    logs.on('close', () => { if (!closed) { say('\r\n\x1b[36m[AVM]\x1b[0m bot is not running\r\n'); try { ws.close(); } catch {} } });
    if (st === 'running') stdin = await attachStdin(name).catch(() => null);
    ws.on('message', (raw) => {
      let d; try { d = JSON.parse(raw); } catch { return; }
      if (d.type === 'input' && typeof d.data === 'string' && stdin) stdin.write(d.data);
    });
    ws.on('close', cleanup);
  }

  async function boot() { // bring back bots that were running before a node restart (docker restart policy does most of it)
    for (const [name, b] of Object.entries(S.bots)) {
      if (b.stopped || b.suspended) continue;
      const st = await ctState(ct(name));
      if (!st) startBot(name);
    }
  }

  return { onConsole, boot, has: (n) => !!S.bots[n], BOT_RE, LANGS: Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [k, { label: v.label, versions: v.versions, main: v.main }])) };
};
