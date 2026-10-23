// AVM Minecraft server hosting: Paper, Purpur, Spigot, Vanilla, Forge and Fabric servers,
// each in its own Docker container (eclipse-temurin Java) with CPU/RAM/disk limits, a public port,
// live console, plugin/mod install, player manager and software/version switching.
// The panel resolves download URLs (it has the version lists); the node only downloads from known hosts.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const mountFiles = require('./files');

const MC_RE = /^mc-[a-f0-9]{8}$/;
const SOFTWARE = ['paper', 'purpur', 'spigot', 'vanilla', 'forge', 'fabric'];
const PLUGIN_SOFT = ['paper', 'purpur', 'spigot'];
const MOD_SOFT = ['forge', 'fabric'];
const JAVAS = [8, 11, 17, 21, 25];
const VER_RE = /^[0-9][0-9a-zA-Z.\-_+]{0,40}$/;
const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$/;
const DL_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(papermc\.io|purpurmc\.org|mojang\.com|fabricmc\.net|minecraftforge\.net|spigotmc\.org|modrinth\.com)\//;
const UA = 'AVM-Panel/1.0 (https://github.com/adityazdomainzz-code/avm-lxc)';

// Java version for a Minecraft version (can be overridden per server)
function autoJava(software, version) {
  const v = String(version || '');
  if (!v.startsWith('1.')) return 25; // year based versions (26.1+) need Java 25
  const [, minor = 0, patch = 0] = v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  if (minor <= 16) return software === 'forge' || software === 'spigot' || minor <= 12 ? 8 : 11;
  if (minor < 20 || (minor === 20 && patch <= 4)) return 17;
  return 21;
}

// runs inside the container (sh). Everything variable comes in as env vars.
const SCRIPT = `cd /data
echo "[AVM] $(java -version 2>&1 | head -n1) · $AVM_SOFT $AVM_VER · max RAM \${AVM_XMX}M"
echo "eula=true" > eula.txt
if [ -f server.properties ]; then sed -i 's/^server-port=.*/server-port=25565/' server.properties; else printf 'server-port=25565\\nmotd=A Minecraft Server on AVM\\n' > server.properties; fi
JF="-Xms128M -Xmx\${AVM_XMX}M -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+DisableExplicitGC -Dfile.encoding=UTF-8"
case "$AVM_SOFT" in
  forge)
    if [ ! -f .avm-forge-ok ]; then
      [ -f forge-installer.jar ] || { echo "[AVM] forge-installer.jar missing - use Software changer to reinstall"; exit 1; }
      echo "[AVM] installing Forge (first start takes a few minutes) ..."
      java -jar forge-installer.jar --installServer || { echo "[AVM] Forge install failed"; exit 1; }
      rm -f forge-installer.jar forge-installer.jar.log installer.log; touch .avm-forge-ok
    fi
    ARGS=$(ls libraries/net/minecraftforge/forge/*/unix_args.txt 2>/dev/null | head -n1)
    if [ -n "$ARGS" ]; then echo "[AVM] starting Forge"; exec java $JF @"$ARGS" nogui; fi
    J=$(ls forge-*.jar 2>/dev/null | grep -v installer | head -n1)
    [ -n "$J" ] || { echo "[AVM] Forge server jar not found"; exit 1; }
    echo "[AVM] starting $J"; exec java $JF -jar "$J" nogui ;;
  spigot)
    if [ ! -f server.jar ]; then
      echo "[AVM] building Spigot $AVM_VER with BuildTools - this takes 5-15 minutes the first time ..."
      command -v git >/dev/null 2>&1 || { echo "[AVM] installing git ..."; (apt-get update -qq && apt-get install -y -qq git >/dev/null) || { echo "[AVM] could not install git"; exit 1; }; }
      mkdir -p .buildtools && cd .buildtools && java -jar BuildTools.jar --rev "$AVM_VER" --output-dir /data || { echo "[AVM] BuildTools failed"; exit 1; }
      cd /data && J=$(ls spigot-*.jar 2>/dev/null | head -n1) && [ -n "$J" ] && mv "$J" server.jar || { echo "[AVM] Spigot jar not found after build"; exit 1; }
      rm -rf .buildtools/work .buildtools/Bukkit .buildtools/CraftBukkit .buildtools/Spigot .buildtools/BuildData
    fi
    echo "[AVM] starting Spigot"; exec java $JF -jar server.jar nogui ;;
  fabric)
    [ -f fabric-server.jar ] || { echo "[AVM] fabric-server.jar not found - use Software changer to reinstall"; exit 1; }
    echo "[AVM] starting Fabric"; exec java $JF -jar fabric-server.jar nogui ;;
  *)
    [ -f server.jar ] || { echo "[AVM] server.jar not found - use Software changer to reinstall"; exit 1; }
    echo "[AVM] starting server.jar"; exec java $JF -jar server.jar nogui ;;
esac`;

// files that belong to the server software (removed when switching software / version; worlds, plugins and configs stay)
const SOFT_GLOB = /^(forge-.*\.jar|fabric-server.*\.jar|spigot-.*\.jar|minecraft_server.*\.jar)$/;
const SOFT_FILES = ['server.jar', 'forge-installer.jar', '.avm-forge-ok', 'run.sh', 'run.bat', 'user_jvm_args.txt', 'libraries', 'versions', '.buildtools', 'cache', '.fabric', '.paper-remapped'];

module.exports = function minecraft(ctx) {
  const { app, docker, cfg, S, save, err, wrap, cleanPath, multer, DOCKER_NET } = ctx;
  const ROOT = cfg.mcRoot || '/var/lib/avm-mc';
  S.mc = S.mc || {};
  const rt = {}; // name -> { busy, step, error }
  const cache = { du: {}, cpu: {} };
  const ct = (name) => 'avm-' + name;
  const dir = (name) => path.join(ROOT, name);
  const pick = (req) => { const n = req.params.name; if (!MC_RE.test(n) || !S.mc[n]) throw err(404, 'Server not found on this node'); return n; };
  const sh = (bin, args, opts = {}) => new Promise((resolve) => { execFile(bin, args, { timeout: opts.timeout || 60000, maxBuffer: 16 * 1048576 }, (e, out, se) => resolve({ ok: !e, out: String(out || ''), err: String(se || '') })); });
  const ctState = async (n) => { try { return (await docker.inspect(n)).State.Status; } catch { return null; } };
  const javaOf = (m) => (JAVAS.includes(+m.java) ? +m.java : autoJava(m.software, m.version));
  const image = (m) => `eclipse-temurin:${javaOf(m)}-jdk`;
  const xmx = (m) => Math.max(256, Math.min(m.memory - 256, Math.floor(m.memory * 0.85)));
  const contentDir = (m) => (MOD_SOFT.includes(m.software) ? 'mods' : PLUGIN_SOFT.includes(m.software) ? 'plugins' : null);

  async function diskUsage(name) {
    const c = cache.du[name];
    if (c && Date.now() - c.at < 60000) return c.bytes;
    const r = await sh('du', ['-sb', dir(name)], { timeout: 60000 });
    const bytes = parseInt(r.out, 10) || 0;
    cache.du[name] = { at: Date.now(), bytes };
    return bytes;
  }
  async function quota(name, extra = 0) {
    delete cache.du[name];
    if ((await diskUsage(name)) + extra > S.mc[name].disk * 1073741824) throw err(507, `Disk limit reached (${S.mc[name].disk} GB) - delete files or ask an admin for more space`);
  }

  // ---------- downloads (only from known Minecraft hosts) ----------
  async function download(url, file, name) {
    if (!DL_HOSTS.test(url)) throw err(400, 'Download not allowed from ' + url.slice(0, 60));
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15 * 60000) });
    if (!r.ok) throw err(502, `Download failed (${r.status}) ${url.slice(0, 100)}`);
    const size = +r.headers.get('content-length') || 0;
    if (name) await quota(name, size);
    const tmp = file + '.part';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(tmp);
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => { Readable.fromWeb(r.body).on('error', reject).pipe(out).on('finish', resolve).on('error', reject); });
    await fsp.rename(tmp, file);
    if (name) delete cache.du[name];
  }

  // install the software files (dl = [{ url, file }] resolved by the panel)
  async function install(name, dl) {
    const m = S.mc[name], d = dir(name);
    const r = rt[name] = { busy: true, step: 'Preparing', error: null };
    try {
      for (const f of SOFT_FILES) await fsp.rm(path.join(d, f), { recursive: true, force: true });
      for (const f of await fsp.readdir(d).catch(() => [])) if (SOFT_GLOB.test(f)) await fsp.rm(path.join(d, f), { force: true });
      for (const x of dl) {
        const file = path.join(d, x.file);
        if (!file.startsWith(d + '/')) throw err(400, 'bad file');
        r.step = `Downloading ${m.software} ${m.version}`;
        await download(x.url, file, name);
      }
      r.step = 'Downloading Java ' + javaOf(m);
      await pullIfMissing(image(m), r);
      m.installed = { software: m.software, version: m.version, at: Date.now() };
      save();
      rt[name] = { busy: false, error: null };
    } catch (e) {
      console.error('[avm-mc] install failed', name, e.message);
      rt[name] = { busy: false, error: e.message };
    }
  }

  // ---------- container lifecycle ----------
  async function pullIfMissing(img, r) {
    const have = await docker.api('GET', `/images/${encodeURIComponent(img)}/json`).then(() => true).catch(() => false);
    if (!have) { if (r) r.step = 'Downloading ' + img; await docker.run(['pull', img], { timeout: 30 * 60000 }); }
  }
  async function ufwAllow(port) {
    const s = await sh('ufw', ['status']);
    if (s.ok && /Status: active/i.test(s.out)) for (const p of ['tcp', 'udp']) await sh('ufw', ['allow', `${port}/${p}`, 'comment', 'AVM minecraft']);
  }
  async function startServer(name) {
    const m = S.mc[name];
    if (!m.installed) throw err(409, 'The server software is not installed yet - wait or use Software changer');
    const r = rt[name] = { busy: true, step: 'Preparing', error: null };
    try {
      await pullIfMissing(image(m), r);
      r.step = 'Starting';
      await docker.run(['rm', '-f', ct(name)]).catch(() => {});
      const args = ['run', '-d', '-it', '--name', ct(name), '--hostname', name, '--network', DOCKER_NET,
        `--cpus=${m.cpu}`, `--memory=${m.memory}m`, `--memory-swap=${m.memory}m`, '--pids-limit=2048',
        '--restart', m.autoRestart ? 'unless-stopped' : 'no', '--label', 'avm=1', '--label', `avm.mc=${name}`,
        '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2',
        '-p', `${m.port}:25565/tcp`, '-p', `${m.port}:25565/udp`,
        '-v', `${dir(name)}:/data`, '-w', '/data',
        '-e', `AVM_SOFT=${m.software}`, '-e', `AVM_VER=${m.version}`, '-e', `AVM_XMX=${xmx(m)}`, '-e', 'TERM=xterm-256color', '-e', 'HOME=/data',
        image(m), 'sh', '-c', SCRIPT];
      await docker.run(args, { timeout: 120000 });
      await ufwAllow(m.port);
      m.stopped = false; save();
      rt[name] = { busy: false, error: null };
    } catch (e) {
      console.error('[avm-mc] start failed', name, e.message);
      rt[name] = { busy: false, error: e.message };
      throw e;
    }
  }
  // graceful stop: "stop" in the console (saves the worlds), then docker stop
  async function stopServer(name, wait = 45000) {
    if ((await ctState(ct(name))) !== 'running') { await docker.run(['stop', '-t', '5', ct(name)]).catch(() => {}); return; }
    await docker.run(['update', '--restart', 'no', ct(name)]).catch(() => {});
    await sendCommand(name, 'stop').catch(() => {});
    const until = Date.now() + wait;
    while (Date.now() < until) { await new Promise((r) => setTimeout(r, 1000)); if ((await ctState(ct(name))) !== 'running') return; }
    await docker.run(['stop', '-t', '15', ct(name)], { timeout: 60000 }).catch(() => {});
  }

  function attachStdin(name) {
    return new Promise((resolve, reject) => {
      const q = http.request({ socketPath: docker.SOCK, method: 'POST', path: `/containers/${ct(name)}/attach?stream=1&stdin=1`, headers: { Connection: 'Upgrade', Upgrade: 'tcp' } });
      q.on('upgrade', (r, sock) => resolve(sock));
      q.on('response', (r) => { r.resume(); reject(new Error('attach failed: ' + r.statusCode)); });
      q.on('error', reject);
      q.end();
    });
  }
  async function sendCommand(name, cmd) {
    if ((await ctState(ct(name))) !== 'running') throw err(409, 'The server is not running');
    const c = String(cmd).replace(/^\//, '').replace(/[\r\n]/g, ' ').slice(0, 1000);
    const sock = await attachStdin(name);
    await new Promise((resolve) => sock.write(c + '\r', resolve));
    setTimeout(() => { try { sock.destroy(); } catch {} }, 300);
  }
  async function logsSince(name, sinceSec) {
    const r = await sh(docker.BIN, ['logs', '--since', String(sinceSec), ct(name)], { timeout: 15000 });
    return (r.out + r.err).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  }

  // ---------- API ----------
  app.post('/api/mc', wrap(async (req, res) => {
    if (!(await docker.available()).ok) throw err(400, 'Minecraft hosting needs Docker on this node');
    const x = req.body;
    if (!MC_RE.test(x.name || '')) throw err(400, 'bad server name');
    if (S.mc[x.name]) throw err(409, 'Server already exists');
    if (!SOFTWARE.includes(x.software)) throw err(400, 'Unknown software');
    if (!VER_RE.test(x.version || '')) throw err(400, 'bad version');
    const port = +x.port;
    if (!(port >= 1024 && port <= 65535)) throw err(400, 'bad port');
    if (Object.values(S.mc).some((m) => m.port === port) || S.ports.some((p) => p.hostPort === port)) throw err(409, `Port ${port} is already used on this node`);
    const m = { software: x.software, version: x.version, java: 0, port, autoRestart: true,
      cpu: Math.max(0.5, Math.min(64, +x.cpu || 2)), memory: Math.max(512, +x.memory || 2048), disk: Math.max(1, +x.disk || 10),
      stopped: true, suspended: false, installed: null, createdAt: Date.now() };
    S.mc[x.name] = m; save();
    await fsp.mkdir(dir(x.name), { recursive: true });
    await fsp.writeFile(path.join(dir(x.name), 'eula.txt'), 'eula=true\n');
    const motd = String(x.motd || 'A Minecraft Server on AVM').replace(/[\r\n\\]/g, ' ').slice(0, 59);
    await fsp.writeFile(path.join(dir(x.name), 'server.properties'), `server-port=25565\nmotd=${motd}\nmax-players=${Math.max(1, Math.min(1000, +x.maxPlayers || 20))}\n`);
    install(x.name, Array.isArray(x.downloads) ? x.downloads : []);
    res.json({ ok: true });
  }));

  app.get('/api/mc/:name/status', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], r = rt[name] || {};
    const out = { software: m.software, version: m.version, java: javaOf(m), javaSetting: m.java || 0, autoJava: autoJava(m.software, m.version), port: m.port, autoRestart: m.autoRestart, image: image(m), xmx: xmx(m),
      installed: m.installed, busy: !!r.busy, step: r.step || null, error: r.error || null, suspended: !!m.suspended, contentDir: contentDir(m),
      cpu: 0, cpus: m.cpu, memory: 0, memLimit: m.memory * 1048576, disk: await diskUsage(name), diskLimit: m.disk * 1073741824, netRx: 0, netTx: 0, uptime: 0, exitCode: null, restarts: 0 };
    let info = null; try { info = await docker.inspect(ct(name)); } catch {}
    if (r.busy) out.state = 'installing';
    else if (m.suspended) out.state = 'suspended';
    else if (!info) out.state = r.error ? 'error' : 'stopped';
    else {
      const s = info.State;
      out.state = s.Running ? (s.Restarting ? 'restarting' : 'running') : s.Restarting ? 'restarting' : 'stopped';
      out.exitCode = s.Running ? null : s.ExitCode;
      out.restarts = info.RestartCount || 0;
      if (s.Running) {
        out.uptime = Date.now() - new Date(s.StartedAt).getTime();
        try {
          const j = await docker.api('GET', `/containers/${ct(name)}/stats?stream=false&one-shot=true`, 8000);
          const ns = j.cpu_stats.cpu_usage.total_usage, now = Date.now(), p = cache.cpu[name];
          if (p && ns >= p.ns) out.cpu = +(((ns - p.ns) / ((now - p.at) * 1e6)) / m.cpu * 100).toFixed(1);
          cache.cpu[name] = { ns, at: now };
          const mm = j.memory_stats || {}, ms = mm.stats || {};
          out.memory = Math.max(0, (mm.usage || 0) - (ms.inactive_file || ms.total_inactive_file || 0));
          for (const n of Object.values(j.networks || {})) { out.netRx += n.rx_bytes || 0; out.netTx += n.tx_bytes || 0; }
        } catch {}
      }
    }
    res.json(out);
  }));

  app.post('/api/mc/:name/power', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], a = req.body.action;
    if (!['start', 'stop', 'restart', 'kill'].includes(a)) throw err(400, 'bad action');
    if (rt[name] && rt[name].busy) throw err(409, 'Please wait - the server is being prepared');
    if (m.suspended && a !== 'stop' && a !== 'kill') throw err(403, 'This server is suspended');
    if (a === 'stop') { await stopServer(name); m.stopped = true; save(); }
    else if (a === 'kill') { await docker.run(['kill', ct(name)]).catch(() => {}); m.stopped = true; save(); }
    else { // start / restart recreate the container so new settings apply
      if (a === 'restart') await stopServer(name);
      await startServer(name);
    }
    res.json({ ok: true });
  }));

  app.post('/api/mc/:name/command', wrap(async (req, res) => {
    const name = pick(req);
    if (S.mc[name].suspended) throw err(403, 'This server is suspended');
    const c = String(req.body.command || '').trim();
    if (!c) throw err(400, 'Empty command');
    await sendCommand(name, c);
    res.json({ ok: true });
  }));

  // software / version / java change. dl = downloads resolved by the panel
  app.post('/api/mc/:name/software', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], x = req.body;
    if (rt[name] && rt[name].busy) throw err(409, 'Please wait - the server is being prepared');
    if (!SOFTWARE.includes(x.software)) throw err(400, 'Unknown software');
    if (!VER_RE.test(x.version || '')) throw err(400, 'bad version');
    await stopServer(name); m.stopped = true;
    await docker.run(['rm', '-f', ct(name)]).catch(() => {});
    if (x.wipe) { // fresh server: delete everything
      for (const f of await fsp.readdir(dir(name))) await fsp.rm(path.join(dir(name), f), { recursive: true, force: true });
      await fsp.writeFile(path.join(dir(name), 'eula.txt'), 'eula=true\n');
    } else if (x.software !== m.software) {
      // plugins do not work on mod loaders and the other way round - park them instead of deleting
      const from = contentDir(m), to = MOD_SOFT.includes(x.software) ? 'mods' : PLUGIN_SOFT.includes(x.software) ? 'plugins' : null;
      if (from && from !== to && fs.existsSync(path.join(dir(name), from))) await fsp.rename(path.join(dir(name), from), path.join(dir(name), `${from}-disabled-${Date.now().toString(36)}`)).catch(() => {});
    }
    m.software = x.software; m.version = x.version;
    if (x.java !== undefined) m.java = JAVAS.includes(+x.java) ? +x.java : 0;
    m.installed = null; save();
    install(name, Array.isArray(x.downloads) ? x.downloads : []);
    res.json({ ok: true });
  }));

  app.put('/api/mc/:name/settings', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], x = req.body;
    if (x.java !== undefined) m.java = JAVAS.includes(+x.java) ? +x.java : 0;
    if (x.autoRestart !== undefined) m.autoRestart = !!x.autoRestart;
    save();
    res.json({ ok: true, java: javaOf(m), restartNeeded: (await ctState(ct(name))) === 'running' });
  }));

  // ---------- plugins / mods ----------
  app.get('/api/mc/:name/plugins', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], cd = contentDir(m);
    if (!cd) return res.json({ dir: null, list: [] });
    const d = path.join(dir(name), cd);
    const list = [];
    for (const f of await fsp.readdir(d).catch(() => [])) {
      if (!/\.jar(\.disabled)?$/i.test(f)) continue;
      const st = await fsp.lstat(path.join(d, f)).catch(() => null);
      if (st && st.isFile()) list.push({ file: f, name: f.replace(/\.jar(\.disabled)?$/i, ''), enabled: /\.jar$/i.test(f), size: st.size, mtime: st.mtimeMs });
    }
    res.json({ dir: cd, list: list.sort((a, b) => a.name.localeCompare(b.name)) });
  }));
  const jarName = (f) => { const b = path.basename(String(f || '')); if (!/^[\w.+\- ()[\]]{1,150}\.jar(\.disabled)?$/i.test(b)) throw err(400, 'bad file name'); return b; };
  app.post('/api/mc/:name/plugins/install', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], cd = contentDir(m);
    if (!cd) throw err(400, 'Vanilla servers have no plugins or mods - switch to Paper, Purpur, Spigot, Forge or Fabric');
    const url = String(req.body.url || '');
    if (!/^https:\/\/cdn\.modrinth\.com\//.test(url)) throw err(400, 'Only Modrinth downloads can be installed');
    const f = jarName(req.body.filename);
    const d = path.join(dir(name), cd);
    const st = await fsp.lstat(d).catch(() => null);
    if (st && st.isSymbolicLink()) throw err(400, 'bad folder');
    await download(url, path.join(d, f), name);
    res.json({ ok: true, file: f });
  }));
  app.post('/api/mc/:name/plugins/toggle', wrap(async (req, res) => {
    const name = pick(req), cd = contentDir(S.mc[name]);
    if (!cd) throw err(400, 'No plugins folder');
    const f = jarName(req.body.file), d = path.join(dir(name), cd);
    const to = /\.disabled$/i.test(f) ? f.replace(/\.disabled$/i, '') : f + '.disabled';
    await fsp.rename(path.join(d, f), path.join(d, to));
    res.json({ ok: true, file: to });
  }));
  app.post('/api/mc/:name/plugins/delete', wrap(async (req, res) => {
    const name = pick(req), cd = contentDir(S.mc[name]);
    if (!cd) throw err(400, 'No plugins folder');
    const f = jarName(req.body.file), p = path.join(dir(name), cd, f);
    const st = await fsp.lstat(p).catch(() => null);
    if (!st || !st.isFile()) throw err(404, 'Not found');
    await fsp.rm(p, { force: true }); delete cache.du[name];
    res.json({ ok: true });
  }));

  // ---------- players ----------
  const readJson = async (name, f) => { try { const j = JSON.parse(await fsp.readFile(path.join(dir(name), f), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const writeJson = (name, f, j) => fsp.writeFile(path.join(dir(name), f), JSON.stringify(j, null, 2));
  async function props(name) {
    const out = {};
    try { for (const l of (await fsp.readFile(path.join(dir(name), 'server.properties'), 'utf8')).split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#')) out[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } } catch {}
    return out;
  }
  async function setProp(name, key, value) {
    const f = path.join(dir(name), 'server.properties');
    let lines = []; try { lines = (await fsp.readFile(f, 'utf8')).split('\n'); } catch {}
    let found = false;
    lines = lines.map((l) => (l.startsWith(key + '=') ? ((found = true), `${key}=${value}`) : l));
    if (!found) lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
    await fsp.writeFile(f, lines.join('\n'));
  }
  const dashed = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  function offlineUuid(n) { const h = crypto.createHash('md5').update('OfflinePlayer:' + n).digest(); h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80; return dashed(h.toString('hex')); }
  async function uuidOf(name, player) {
    const cachej = await readJson(name, 'usercache.json');
    const hit = cachej.find((u) => String(u.name).toLowerCase() === player.toLowerCase());
    if (hit) return { uuid: hit.uuid, name: hit.name };
    if ((await props(name))['online-mode'] === 'false') return { uuid: offlineUuid(player), name: player };
    const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(player)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!r || r.status !== 200) throw err(404, `Minecraft account "${player}" not found`);
    const j = await r.json();
    return { uuid: dashed(j.id), name: j.name };
  }
  app.get('/api/mc/:name/players', wrap(async (req, res) => {
    const name = pick(req);
    const [ops, whitelist, banned, bannedIps, recent, p] = await Promise.all([readJson(name, 'ops.json'), readJson(name, 'whitelist.json'), readJson(name, 'banned-players.json'), readJson(name, 'banned-ips.json'), readJson(name, 'usercache.json'), props(name)]);
    let online = null, max = +p['max-players'] || 20;
    if ((await ctState(ct(name))) === 'running' && !(rt[name] && rt[name].busy)) {
      const since = Math.floor(Date.now() / 1000) - 1;
      try {
        await sendCommand(name, 'list');
        for (let i = 0; i < 6 && online === null; i++) {
          await new Promise((r) => setTimeout(r, 400));
          const mm = /There are (\d+) of a max(?: of)? (\d+) players online:? ?(.*)$/m.exec(await logsSince(name, since));
          if (mm) { max = +mm[2]; online = mm[3].split(/,\s*/).map((s) => s.trim().replace(/^\[.*?\]\s*/, '')).filter(Boolean); }
        }
      } catch {}
    }
    res.json({ online, max, whitelistOn: p['white-list'] === 'true', onlineMode: p['online-mode'] !== 'false',
      ops: ops.map((o) => ({ name: o.name, uuid: o.uuid, level: o.level })), whitelist: whitelist.map((o) => ({ name: o.name, uuid: o.uuid })),
      banned: banned.map((o) => ({ name: o.name, uuid: o.uuid, reason: o.reason, created: o.created })), bannedIps: bannedIps.map((o) => ({ ip: o.ip, reason: o.reason })),
      recent: recent.slice(0, 50).map((o) => ({ name: o.name, uuid: o.uuid })) });
  }));
  app.post('/api/mc/:name/players', wrap(async (req, res) => {
    const name = pick(req), x = req.body, a = x.action;
    if (S.mc[name].suspended) throw err(403, 'This server is suspended');
    const running = (await ctState(ct(name))) === 'running';
    const reason = String(x.reason || '').replace(/[\r\n]/g, ' ').slice(0, 100);
    if (a === 'whitelist-on' || a === 'whitelist-off') {
      if (running) await sendCommand(name, a === 'whitelist-on' ? 'whitelist on' : 'whitelist off');
      else await setProp(name, 'white-list', a === 'whitelist-on' ? 'true' : 'false');
      return res.json({ ok: true });
    }
    if (a === 'ban-ip' || a === 'pardon-ip') {
      const ip = String(x.ip || '').trim();
      if (!IP_RE.test(ip)) throw err(400, 'Bad IP address');
      if (running) await sendCommand(name, a === 'ban-ip' ? `ban-ip ${ip}${reason ? ' ' + reason : ''}` : `pardon-ip ${ip}`);
      else {
        let l = (await readJson(name, 'banned-ips.json')).filter((b) => b.ip !== ip);
        if (a === 'ban-ip') l.push({ ip, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: 'AVM Panel', expires: 'forever', reason: reason || 'Banned by an operator.' });
        await writeJson(name, 'banned-ips.json', l);
      }
      return res.json({ ok: true });
    }
    const player = String(x.player || '').trim();
    if (!PLAYER_RE.test(player)) throw err(400, 'Player names are 1-16 letters, numbers or _');
    const cmds = { op: `op ${player}`, deop: `deop ${player}`, 'whitelist-add': `whitelist add ${player}`, 'whitelist-remove': `whitelist remove ${player}`,
      ban: `ban ${player}${reason ? ' ' + reason : ''}`, pardon: `pardon ${player}`, kick: `kick ${player}${reason ? ' ' + reason : ''}` };
    if (!cmds[a]) throw err(400, 'bad action');
    if (running) { await sendCommand(name, cmds[a]); return res.json({ ok: true, via: 'console' }); }
    if (a === 'kick') throw err(409, 'The server is not running');
    // offline: edit the JSON files directly
    const file = { op: 'ops.json', deop: 'ops.json', 'whitelist-add': 'whitelist.json', 'whitelist-remove': 'whitelist.json', ban: 'banned-players.json', pardon: 'banned-players.json' }[a];
    let l = (await readJson(name, file)).filter((o) => String(o.name).toLowerCase() !== player.toLowerCase());
    if (['op', 'whitelist-add', 'ban'].includes(a)) {
      const u = await uuidOf(name, player);
      if (a === 'op') l.push({ uuid: u.uuid, name: u.name, level: 4, bypassesPlayerLimit: false });
      else if (a === 'whitelist-add') l.push({ uuid: u.uuid, name: u.name });
      else l.push({ uuid: u.uuid, name: u.name, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: 'AVM Panel', expires: 'forever', reason: reason || 'Banned by an operator.' });
    }
    await writeJson(name, file, l);
    res.json({ ok: true, via: 'file' });
  }));

  // ---------- admin ----------
  app.patch('/api/mc/:name', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name], x = req.body;
    if (x.cpu) m.cpu = Math.max(0.5, Math.min(64, +x.cpu));
    if (x.memory) m.memory = Math.max(512, +x.memory);
    if (x.disk) m.disk = Math.max(1, +x.disk);
    save();
    if (x.cpu || x.memory) await docker.run(['update', `--cpus=${m.cpu}`, `--memory=${m.memory}m`, `--memory-swap=${m.memory}m`, ct(name)]).catch(() => {});
    res.json({ ok: true });
  }));
  app.post('/api/mc/:name/suspend', wrap(async (req, res) => {
    const name = pick(req), m = S.mc[name];
    m.suspended = !!req.body.suspended;
    if (m.suspended) { await stopServer(name); m.stopped = true; }
    save();
    res.json({ ok: true });
  }));
  app.delete('/api/mc/:name', wrap(async (req, res) => {
    const name = pick(req);
    await docker.run(['rm', '-f', ct(name)]).catch(() => {});
    delete S.mc[name]; delete rt[name]; delete cache.du[name]; save();
    const d = dir(name);
    if (d.startsWith(ROOT + '/') && MC_RE.test(path.basename(d))) await fsp.rm(d, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  mountFiles(app, '/api/mc/:name', { pick, base: dir, wrap, err, cleanPath, multer, quota, touched: (n) => { delete cache.du[n]; } });

  // ---------- live console: output = docker logs -f, input = docker attach (stdin) ----------
  async function onConsole(ws, name) {
    const say = (t) => { if (ws.readyState === 1) ws.send(t); };
    const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
    const st = await ctState(ct(name));
    if (!st) { say('\x1b[36m[AVM]\x1b[0m The server has not been started yet. Press Start.\r\n'); return ws.close(); }
    let logs = null, stdin = null, closed = false;
    const cleanup = () => { closed = true; try { logs && logs.kill(); } catch {} try { stdin && stdin.destroy(); } catch {} };
    logs = spawn(docker.BIN, ['logs', '--tail', '500', ...(st === 'running' || st === 'restarting' ? ['-f'] : []), ct(name)]);
    logs.stdout.on('data', (d) => say(crlf(d.toString())));
    logs.stderr.on('data', (d) => say(crlf(d.toString())));
    logs.on('close', () => { if (!closed) { say('\r\n\x1b[36m[AVM]\x1b[0m server is offline\r\n'); try { ws.close(); } catch {} } });
    if (st === 'running') stdin = await attachStdin(name).catch(() => null);
    ws.on('message', (raw) => {
      let d; try { d = JSON.parse(raw); } catch { return; }
      if (d.type === 'input' && typeof d.data === 'string' && stdin) stdin.write(d.data);
    });
    ws.on('close', cleanup);
  }

  async function boot() { // start servers that were running before the node restarted (docker restart policy does most of it)
    for (const [name, m] of Object.entries(S.mc)) {
      if (m.stopped || m.suspended || !m.installed) continue;
      if (!(await ctState(ct(name)))) startServer(name).catch(() => {});
    }
  }

  return { onConsole, boot, has: (n) => !!S.mc[n], MC_RE, usedPorts: () => Object.values(S.mc).map((m) => m.port) };
};

module.exports.autoJava = autoJava;
