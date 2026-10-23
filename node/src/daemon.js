// AVM Node Daemon - LXC containers + KVM virtual machines (Incus) + Docker containers
'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const incus = require('./incus');
const docker = require('./docker');
const webHosting = require('./web');
const botHosting = require('./bots');
const net = require('./net');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(CONFIG_FILE)) { console.error('[avm-node] config.json missing - run install.sh'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PORT = cfg.port || 8090;
const BRIDGE = cfg.bridge || 'incusbr0';
const DOCKER_NET = cfg.dockerNetwork || 'avm-docker';
const DOCKER_SUBNET = cfg.dockerSubnet || '10.89.0.0/24';
const TYPES = ['container', 'vm', 'docker'];
const DATA_DIR = cfg.dataDir || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistent state ----------
let S = { vms: {}, ports: [], ips: [], sites: {}, web: {}, bots: {} };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
function save() { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); }
const runtime = {}; // name -> { installing, error, step }
const cpuSamples = {};

const NAME_RE = /^avm-[a-f0-9]{8}$/;
const err = (status, msg) => Object.assign(new Error(msg), { status });

// ---------- express ----------
const app = express();
let WEB = null; // website hosting module (set up below)
// phpMyAdmin is proxied as a raw stream, so it must come before the JSON body parser
app.use('/api/pma', (req, res) => {
  if (!tokenOk((req.headers.authorization || '').replace(/^Bearer /, ''))) return res.status(401).json({ error: 'Invalid node token' });
  if (!WEB) return res.status(503).json({ error: 'starting' });
  WEB.pmaProxy(req, res);
});
app.use(express.json({ limit: '10mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));

function tokenOk(t) {
  if (!t || typeof t !== 'string') return false;
  const a = Buffer.from(t), b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.use('/api', (req, res, next) => {
  if (!tokenOk((req.headers.authorization || '').replace(/^Bearer /, ''))) return res.status(401).json({ error: 'Invalid node token' });
  next();
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message }));
function vmName(req) {
  const n = req.params.name;
  if (!NAME_RE.test(n) || !S.vms[n]) throw err(404, 'VM not found on this node');
  return n;
}
function cleanPath(p) {
  p = String(p || '/');
  if (p.includes('\0')) throw err(400, 'Bad path');
  return path.posix.normalize('/' + p);
}

// ---------- helpers ----------
function parseCidr(cidr) { // "10.55.2.1/24" or "10.89.0.0/24"
  const [ip, bits] = String(cidr).split('/');
  return { ip, bits: +bits || 24, prefix: ip.split('.').slice(0, 3).join('.') };
}
async function bridgeSubnet() {
  const c = parseCidr((await incus.run(['network', 'get', BRIDGE, 'ipv4.address'])).trim());
  return { gw: c.ip, prefix: c.prefix };
}
async function dockerSubnet() {
  const n = await ensureDockerNet();
  const ipam = (n.IPAM && n.IPAM.Config && n.IPAM.Config[0]) || {};
  const c = parseCidr(ipam.Subnet || DOCKER_SUBNET);
  return { gw: ipam.Gateway || `${c.prefix}.1`, prefix: c.prefix };
}
async function allocIp(type) {
  const { prefix, gw } = type === 'docker' ? await dockerSubnet() : await bridgeSubnet();
  const used = new Set([...Object.values(S.vms).map((v) => v.privateIp), ...(WEB ? WEB.usedIps() : [])]);
  used.add(gw);
  for (let i = 10; i < 250; i++) { const ip = `${prefix}.${i}`; if (!used.has(ip)) return ip; }
  throw err(507, 'No free private IPs left on the ' + (type === 'docker' ? 'Docker network' : 'bridge'));
}
// the user-defined Docker network every AVM Docker container lives on (static IPs need one)
let dockerNetCache = null;
async function ensureDockerNet() {
  if (dockerNetCache) return dockerNetCache;
  try { dockerNetCache = await docker.api('GET', `/networks/${DOCKER_NET}`); return dockerNetCache; } catch {}
  const c = parseCidr(DOCKER_SUBNET);
  await docker.run(['network', 'create', '--driver', 'bridge', '--subnet', `${c.prefix}.0/${c.bits}`, '--gateway', `${c.prefix}.1`,
    '--label', 'avm=1', '-o', 'com.docker.network.bridge.name=avm-docker0', DOCKER_NET]);
  dockerNetCache = await docker.api('GET', `/networks/${DOCKER_NET}`);
  console.log('[avm-node] created Docker network', DOCKER_NET, `${c.prefix}.0/${c.bits}`);
  return dockerNetCache;
}

// ---------- backends: one interface for LXC, KVM and Docker ----------
const LXD = {
  exec: (n, script, args, opts) => incus.exec(n, script, args, opts),
  execInput: (n, script, args, input) => incus.run(['exec', n, '--', 'sh', '-c', script, 'sh', ...args], { input }),
  push: (n, local, target) => incus.run(['file', 'push', local, `${n}${target}`], { timeout: 600000 }),
  pull: (n, p, local) => incus.run(['file', 'pull', `${n}${p}`, local], { timeout: 600000 }),
  async state(n) {
    const st = await incus.query(`/1.0/instances/${n}/state`);
    const eth = st.network && (st.network.eth0 || Object.values(st.network).find((x) => x.type !== 'loopback'));
    return {
      state: String(st.status || 'unknown').toLowerCase(), processes: st.processes || 0,
      memory: (st.memory && st.memory.usage) || 0, cpuNs: st.cpu ? st.cpu.usage : 0,
      disk: (st.disk && st.disk.root && st.disk.root.usage) || 0,
      netRx: (eth && eth.counters && eth.counters.bytes_received) || 0, netTx: (eth && eth.counters && eth.counters.bytes_sent) || 0,
    };
  },
  async power(n, a) {
    const tryForce = async (cmd) => { try { await incus.run([cmd, n, '--timeout', '30'], { timeout: 60000 }); } catch { await incus.run([cmd, n, '--force'], { timeout: 60000 }); } };
    if (a === 'start') await incus.run(['start', n], { timeout: 120000 }).catch((e) => { if (!/already running/i.test(e.message)) throw e; });
    else if (a === 'stop') await tryForce('stop').catch((e) => { if (!/already stopped|not running/i.test(e.message)) throw e; });
    else if (a === 'restart') await tryForce('restart');
    else if (a === 'kill') await incus.run(['stop', n, '--force']).catch(() => {});
  },
  remove: (n) => incus.run(['delete', n, '--force'], { timeout: 120000 }).catch((e) => { if (!/not found/i.test(e.message)) throw e; }),
  consoleCmd: (n, shell) => [incus.BIN, ['exec', n, '-t', '--', 'sh', '-c', shell]],
  async build(name, v, rt) {
    const args = ['init', v.image, name, '-c', `limits.cpu=${v.cpu}`, '-c', `limits.memory=${v.memory}MiB`];
    if (v.type === 'vm') args.push('--vm');
    else args.push('-c', 'security.nesting=true');
    const init = async (a) => {
      try { await incus.run(a, { timeout: 30 * 60000 }); }
      catch (e) {
        // inside an unprivileged LXC VPS there are not enough spare UIDs for unprivileged nested
        // containers ("no functional idmap setup") -> make this container privileged instead
        if (v.type === 'vm' || !/idmap/i.test(e.message) || a.includes('security.privileged=true')) throw e;
        console.warn('[avm-node] no usable idmap on this host, creating', name, 'as a privileged container');
        await incus.run(['delete', name, '--force']).catch(() => {});
        a.splice(a.indexOf(name) + 1, 0, '-c', 'security.privileged=true');
        args.splice(args.indexOf(name) + 1, 0, '-c', 'security.privileged=true');
        v.privileged = true; save();
        await incus.run(a, { timeout: 30 * 60000 });
      }
    };
    try { await init([...args, '-d', `root,size=${v.disk}GiB`]); }
    catch (e) {
      // "dir" storage pools without project quotas cannot limit container disk size -> create without the limit
      if (v.type === 'vm' || !/quota|size/i.test(e.message)) throw e;
      console.warn('[avm-node] disk size limit not supported by this storage pool, creating', name, 'without it');
      await incus.run(['delete', name, '--force']).catch(() => {});
      rt.step = 'Downloading image ' + v.image + ' (no disk quota on this pool)';
      await init([...args]);
    }
    rt.step = 'Configuring network';
    try { await incus.run(['config', 'device', 'override', name, 'eth0', `ipv4.address=${v.privateIp}`]); }
    catch { await incus.run(['config', 'device', 'set', name, 'eth0', `ipv4.address=${v.privateIp}`]); }
    rt.step = 'Starting';
    await incus.run(['start', name]);
  },
};

const DOCKER_STATE = { running: 'running', paused: 'frozen', restarting: 'restarting', created: 'stopped', exited: 'stopped', dead: 'stopped', removing: 'stopping' };
const dockerSize = {}; // name -> { at, size } (size=true inspect is slow, cache it)
// PID 1 for "shell" containers: images like ubuntu/debian exit at once without a long running command
const KEEPALIVE = 'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done';
const DOCKER = {
  exec: (n, script, args, opts) => docker.exec(n, script, args, opts),
  execInput: (n, script, args, input) => docker.exec(n, script, args, { input }),
  push: (n, local, target) => docker.run(['cp', local, `${n}:${target}`], { timeout: 600000 }),
  pull: (n, p, local) => docker.run(['cp', `${n}:${p}`, local], { timeout: 600000 }),
  async state(n) {
    const info = await docker.inspect(n);
    const out = { state: DOCKER_STATE[info.State && info.State.Status] || 'unknown', processes: 0, memory: 0, cpuNs: 0, disk: 0, netRx: 0, netTx: 0 };
    if (out.state === 'running') {
      try {
        const s = await docker.api('GET', `/containers/${n}/stats?stream=false&one-shot=true`, 8000);
        out.cpuNs = (s.cpu_stats && s.cpu_stats.cpu_usage && s.cpu_stats.cpu_usage.total_usage) || 0;
        const m = s.memory_stats || {}, ms = m.stats || {};
        out.memory = Math.max(0, (m.usage || 0) - (ms.inactive_file || ms.total_inactive_file || 0));
        out.processes = (s.pids_stats && s.pids_stats.current) || 0;
        for (const x of Object.values(s.networks || {})) { out.netRx += x.rx_bytes || 0; out.netTx += x.tx_bytes || 0; }
      } catch {}
    }
    const c = dockerSize[n];
    if (!c || Date.now() - c.at > 60000) {
      dockerSize[n] = { at: Date.now(), size: c ? c.size : 0 };
      docker.api('GET', `/containers/${n}/json?size=true`, 60000).then((j) => { dockerSize[n].size = j.SizeRw || 0; }).catch(() => {});
    }
    out.disk = dockerSize[n].size;
    return out;
  },
  async power(n, a) {
    if (a === 'start') await docker.run(['start', n], { timeout: 120000 });
    else if (a === 'stop') await docker.run(['stop', '-t', '30', n], { timeout: 60000 });
    else if (a === 'restart') await docker.run(['restart', '-t', '30', n], { timeout: 90000 });
    else if (a === 'kill') await docker.run(['kill', n]).catch(() => {});
  },
  remove: (n) => docker.run(['rm', '-f', '-v', n], { timeout: 120000 }).catch((e) => { if (!/no such container/i.test(e.message)) throw e; }),
  consoleCmd: (n, shell) => [docker.BIN, ['exec', '-it', '-e', 'TERM=xterm-256color', n, 'sh', '-c', shell]],
  async build(name, v, rt) {
    await ensureDockerNet();
    const have = await docker.api('GET', `/images/${encodeURIComponent(v.image)}/json`).then(() => true).catch(() => false);
    if (!have) await docker.run(['pull', v.image], { timeout: 30 * 60000 });
    rt.step = 'Creating container';
    const args = ['create', '--name', name, '--hostname', name, '--network', DOCKER_NET, '--ip', v.privateIp,
      `--cpus=${v.cpu}`, `--memory=${v.memory}m`, `--memory-swap=${v.memory}m`, '--pids-limit=4096',
      '--restart', 'unless-stopped', '--label', 'avm=1', '--label', `avm.name=${name}`];
    for (const e of v.env || []) args.push('-e', e);
    const tail = v.keepAlive ? ['--init', '--entrypoint', 'sh', v.image, '-c', KEEPALIVE] : [v.image];
    try { await docker.run([...args, `--storage-opt=size=${v.disk}G`, ...tail], { timeout: 300000 }); v.diskExact = true; }
    catch (e) {
      // the disk quota only works on overlay2 + xfs with pquota (or btrfs / zfs) -> create without it
      if (!/storage-opt|quota|size|not supported|backing filesystem/i.test(e.message)) throw e;
      console.warn('[avm-node] docker disk size limit not supported here, creating', name, 'without it');
      await docker.run(['rm', '-f', name]).catch(() => {});
      await docker.run([...args, ...tail], { timeout: 300000 });
      v.diskExact = false;
    }
    save();
    rt.step = 'Starting';
    await docker.run(['start', name], { timeout: 120000 });
  },
};
const be = (name) => (S.vms[name] && S.vms[name].type === 'docker' ? DOCKER : LXD);
async function isRunning(name) {
  try { return (await be(name).state(name)).state === 'running'; } catch { return false; }
}

// ---------- system ----------
app.get('/api/system', wrap(async (req, res) => {
  let version = null, incusOk = true, subnet = null;
  try { version = (await incus.run(['version'])).trim().split('\n').pop().replace(/.*:\s*/, ''); } catch { incusOk = false; }
  if (incusOk) try { subnet = (await incus.run(['network', 'get', BRIDGE, 'ipv4.address'])).trim(); } catch {}
  const d = await docker.available();
  let dockerSub = null;
  if (d.ok) try { const n = await ensureDockerNet(); dockerSub = n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && n.IPAM.Config[0].Subnet; } catch {}
  res.json({
    hostname: os.hostname(), cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem(), load: os.loadavg(), uptime: os.uptime(),
    incus: incusOk, incusVersion: version, kvm: incusOk && fs.existsSync('/dev/kvm'), ufw: await net.ufwActive(), bridge: BRIDGE, subnet,
    docker: d.ok, dockerVersion: d.version, dockerNetwork: DOCKER_NET, dockerSubnet: dockerSub,
    types: TYPES.filter((t) => (t === 'docker' ? d.ok : incusOk && (t === 'container' || fs.existsSync('/dev/kvm')))),
    vms: Object.keys(S.vms).length, ports: S.ports.length, ips: S.ips.length,
  });
}));

// ---------- available OS images (live from the images: remote, cached 1h) ----------
let imgCache = { at: 0, list: null, pending: null };
async function fetchImages() {
  const raw = await incus.json(['image', 'list', 'images:', '--format', 'json']);
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch] || 'x86_64';
  const map = {};
  for (const im of raw) {
    if (im.architecture !== arch) continue;
    const p = im.properties || {};
    if (p.variant && p.variant !== 'default' && p.variant !== 'cloud') continue;
    const names = (im.aliases || []).map((a) => a.name).filter((n) => n.split('/').length === 2);
    if (!names.length) continue;
    // prefer the numeric alias (ubuntu/24.04 over ubuntu/noble)
    names.sort((a, b) => (/\/\d/.test(b) - /\/\d/.test(a)) || a.length - b.length);
    const alias = names[0];
    const [os, version] = alias.split('/');
    const e = map[alias] || (map[alias] = { id: 'images:' + alias, os, name: p.os || os, version, release: p.release || '', container: false, vm: false });
    if (im.type === 'virtual-machine') e.vm = true; else e.container = true;
  }
  // newest numeric version first, rolling names (edge, current, sid…) last
  const num = (v) => /^\d/.test(v);
  return Object.values(map).sort((a, b) => a.os.localeCompare(b.os) || (num(b.version) - num(a.version)) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}
app.get('/api/images', wrap(async (req, res) => {
  if (!imgCache.list || Date.now() - imgCache.at > 3600e3) {
    imgCache.pending = imgCache.pending || fetchImages().finally(() => { imgCache.pending = null; });
    try { imgCache.list = await imgCache.pending; imgCache.at = Date.now(); }
    catch (e) { if (!imgCache.list) throw err(502, 'Could not reach the image server: ' + e.message); }
  }
  res.json(imgCache.list);
}));
// Docker images already downloaded on this node
app.get('/api/docker/images', wrap(async (req, res) => {
  if (!(await docker.available()).ok) throw err(400, 'Docker is not available on this node');
  const list = await docker.api('GET', '/images/json');
  res.json(list.flatMap((i) => (i.RepoTags || []).filter((t) => t !== '<none>:<none>').map((t) => ({ image: t, size: i.Size, created: i.Created * 1000 }))));
}));

// ---------- create ----------
const DOCKER_IMAGE_RE = /^[a-z0-9][a-z0-9._\/-]*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
app.post('/api/vms', wrap(async (req, res) => {
  const { name, type, image, cpu, memory, disk } = req.body;
  if (!NAME_RE.test(name || '')) throw err(400, 'bad name');
  if (S.vms[name]) throw err(409, 'VM already exists');
  if (!TYPES.includes(type)) throw err(400, 'type must be container (LXC), vm (KVM) or docker');
  const v = { type, image, cpu: Math.max(1, +cpu || 1), memory: Math.max(128, +memory || 1024), disk: Math.max(1, +disk || 10), createdAt: Date.now() };
  if (type === 'docker') {
    if (!(await docker.available()).ok) throw err(400, 'Docker is not installed / not running on this node');
    if (!DOCKER_IMAGE_RE.test(image || '') || image.length > 200) throw err(400, 'bad Docker image name (example: ubuntu:24.04, nginx:latest, ghcr.io/user/app:1.0)');
    const env = Array.isArray(req.body.env) ? req.body.env : [];
    if (env.length > 50 || env.some((e) => typeof e !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=[^\0\n]{0,4000}$/.test(e))) throw err(400, 'bad environment variables (KEY=value, one per line)');
    v.env = env; v.keepAlive = !!req.body.keepAlive;
  } else {
    try { await incus.run(['version'], { timeout: 8000 }); } catch { throw err(400, 'Incus is not installed / not running on this node - only Docker containers can be created here'); }
    if (type === 'vm' && !fs.existsSync('/dev/kvm') && !process.env.AVM_FAKE_KVM) throw err(400, 'This node has no /dev/kvm - only LXC containers can be created');
    if (!/^[\w.:/@-]{3,100}$/.test(image || '')) throw err(400, 'bad image');
  }
  v.privateIp = await allocIp(type);
  S.vms[name] = v;
  save();
  buildVm(name); // background - image download can take minutes
  res.json({ ok: true, privateIp: v.privateIp });
}));

async function buildVm(name) {
  const v = S.vms[name];
  const rt = runtime[name] = { installing: true, error: null, step: (v.type === 'docker' ? 'Pulling image ' : 'Downloading image ') + v.image };
  try {
    await be(name).build(name, v, rt);
    runtime[name] = { installing: false, error: null };
    // re-apply any rules that were added while installing
    for (const p of S.ports.filter((x) => x.name === name)) await net.addPort(p).catch(() => {});
  } catch (e) {
    console.error('[avm-node] create failed', name, e.message);
    runtime[name] = { installing: false, error: e.message };
  }
}

// ---------- status / usage ----------
app.get('/api/vms/:name/status', wrap(async (req, res) => {
  const name = vmName(req);
  const v = S.vms[name], rt = runtime[name] || {};
  const out = { state: 'unknown', installing: !!rt.installing, step: rt.step || null, error: rt.error || null, type: v.type, privateIp: v.privateIp,
    cpu: 0, cpus: v.cpu, memory: 0, memLimit: v.memory * 1048576, disk: 0, diskLimit: v.disk * 1073741824, netRx: 0, netTx: 0, processes: 0 };
  if (rt.installing) { out.state = 'installing'; return res.json(out); }
  let st;
  try { st = await be(name).state(name); }
  catch (e) { out.state = 'missing'; out.error = out.error || e.message; return res.json(out); }
  Object.assign(out, { state: st.state, processes: st.processes, memory: st.memory, netRx: st.netRx, netTx: st.netTx, disk: st.disk });
  const now = Date.now(), prev = cpuSamples[name];
  if (prev && st.cpuNs >= prev.usage && out.state === 'running') {
    out.cpu = +(((st.cpuNs - prev.usage) / ((now - prev.at) * 1e6)) / v.cpu * 100).toFixed(1);
  }
  cpuSamples[name] = { usage: st.cpuNs, at: now };
  if (!out.disk && out.state === 'running' && v.type !== 'docker') {
    try { const [used, total] = (await incus.exec(name, "df -B1 / | tail -1 | awk '{print $3, $2}'", [], { timeout: 8000 })).trim().split(/\s+/).map(Number); out.disk = used || 0; if (total && !v.diskExact) out.diskLimit = Math.min(out.diskLimit, total) || out.diskLimit; } catch {}
  }
  res.json(out);
}));

// ---------- power ----------
app.post('/api/vms/:name/power', wrap(async (req, res) => {
  const name = vmName(req);
  if (runtime[name] && runtime[name].installing) throw err(409, 'VM is still being created, please wait');
  const a = req.body.action;
  if (!['start', 'stop', 'restart', 'kill'].includes(a)) throw err(400, 'bad action');
  await be(name).power(name, a);
  res.json({ ok: true });
}));

// ---------- delete ----------
app.delete('/api/vms/:name', wrap(async (req, res) => {
  const name = vmName(req);
  for (const p of S.ports.filter((x) => x.name === name)) await net.removePort(p).catch(() => {});
  for (const x of S.ips.filter((i) => i.name === name)) await net.removePublicIp(x, cfg.iface).catch(() => {});
  S.ports = S.ports.filter((x) => x.name !== name);
  S.ips = S.ips.filter((x) => x.name !== name);
  await be(name).remove(name);
  delete S.vms[name]; delete runtime[name]; delete dockerSize[name]; save();
  res.json({ ok: true });
}));

// ---------- root password ----------
app.post('/api/vms/:name/password', wrap(async (req, res) => {
  const name = vmName(req);
  const pw = String(req.body.password || '');
  if (pw.length < 6 || /[\n:]/.test(pw)) throw err(400, 'Password must be 6+ characters (no ":" or new lines)');
  if (!(await isRunning(name))) throw err(409, 'Start the machine first');
  await be(name).exec(name, 'command -v chpasswd >/dev/null 2>&1 || { echo "chpasswd is not installed in this image" >&2; exit 1; }; echo "root:$1" | chpasswd', [pw], { timeout: 20000 });
  res.json({ ok: true });
}));

// ---------- sshx ----------
const SSHX_CMD = 'curl -sSf https://sshx.io/get | sh -s run';
app.post('/api/vms/:name/sshx', wrap(async (req, res) => {
  const name = vmName(req), B = be(name);
  if (!(await isRunning(name))) throw err(409, 'Start the VM first');
  const readLink = async () => {
    const out = await B.exec(name, 'cat /tmp/avm-sshx.log 2>/dev/null; echo; (pgrep -x sshx >/dev/null 2>&1 || ps 2>/dev/null | grep -q "[s]shx") && echo AVM_RUNNING || true', [], { timeout: 10000 }).catch(() => '');
    const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const m = /https:\/\/sshx\.io\/s\/[^\s"']+/.exec(clean);
    return { url: m ? m[0] : null, running: clean.includes('AVM_RUNNING'), log: clean };
  };
  if (!req.body.fresh) { const cur = await readLink(); if (cur.url && cur.running) return res.json({ url: cur.url, reused: true }); }
  const script = `
pkill -x sshx 2>/dev/null; rm -f /tmp/avm-sshx.log
if ! command -v curl >/dev/null 2>&1; then
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates) >/dev/null 2>&1 \
  || apk add --no-cache curl >/dev/null 2>&1 || dnf install -y -q curl >/dev/null 2>&1 || yum install -y -q curl >/dev/null 2>&1 || pacman -Sy --noconfirm curl >/dev/null 2>&1
fi
if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c '${SSHX_CMD}' >/tmp/avm-sshx.log 2>&1 </dev/null &
else nohup sh -c '${SSHX_CMD}' >/tmp/avm-sshx.log 2>&1 </dev/null & fi
echo started`;
  await B.exec(name, script, [], { timeout: 180000 });
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const cur = await readLink();
    if (cur.url) return res.json({ url: cur.url });
    if (i > 5 && !cur.running && /error|not found|failed/i.test(cur.log)) throw err(502, 'sshx failed: ' + cur.log.trim().slice(-300));
  }
  throw err(504, 'sshx did not return a link in time - check the VM has internet');
}));

// ---------- file manager (inside the VM) ----------
app.get('/api/vms/:name/files', wrap(async (req, res) => {
  const name = vmName(req), dir = cleanPath(req.query.path);
  const script = `d="$1"; [ -d "$d" ] || { echo "AVM_NOTDIR"; exit 0; }
for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; stat -c '%F|%s|%Y|%n' "$f" 2>/dev/null; done`;
  const out = await be(name).exec(name, script, [dir], { timeout: 20000 });
  if (out.includes('AVM_NOTDIR')) throw err(400, 'Not a folder');
  const list = out.split('\n').filter(Boolean).map((l) => {
    const [type, size, mtime, ...rest] = l.split('|');
    const full = rest.join('|');
    return { name: full.split('/').pop(), dir: type === 'directory', link: /link/.test(type), size: +size || 0, mtime: (+mtime || 0) * 1000 };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  res.json(list);
}));
app.get('/api/vms/:name/files/content', wrap(async (req, res) => {
  const name = vmName(req), f = cleanPath(req.query.path), B = be(name);
  const size = +(await B.exec(name, 'stat -c %s "$1"', [f])).trim();
  if (size > 5 * 1048576) throw err(413, 'File too large to edit (5MB max) - download it instead');
  res.json({ content: await B.exec(name, 'cat "$1"', [f]) });
}));
app.post('/api/vms/:name/files/write', wrap(async (req, res) => {
  const name = vmName(req), f = cleanPath(req.body.path);
  await be(name).execInput(name, 'mkdir -p "$(dirname "$1")" && cat > "$1"', [f], String(req.body.content ?? ''));
  res.json({ ok: true });
}));
app.post('/api/vms/:name/files/mkdir', wrap(async (req, res) => {
  const name = vmName(req);
  await be(name).exec(name, 'mkdir -p "$1"', [cleanPath(req.body.path)]);
  res.json({ ok: true });
}));
app.post('/api/vms/:name/files/rename', wrap(async (req, res) => {
  const name = vmName(req);
  await be(name).exec(name, 'mv "$1" "$2"', [cleanPath(req.body.from), cleanPath(req.body.to)]);
  res.json({ ok: true });
}));
app.post('/api/vms/:name/files/delete', wrap(async (req, res) => {
  const name = vmName(req);
  const paths = (req.body.paths || []).map(cleanPath).filter((p) => p !== '/');
  if (paths.length) await be(name).exec(name, 'rm -rf -- "$@"', paths);
  res.json({ ok: true });
}));
const upload = multer({ dest: path.join(os.tmpdir(), 'avm-up'), limits: { fileSize: 2048 * 1048576 } });
app.post('/api/vms/:name/files/upload', upload.array('files'), wrap(async (req, res) => {
  const name = vmName(req), dir = cleanPath(req.query.path), B = be(name);
  try {
    await B.exec(name, 'mkdir -p "$1"', [dir]);
    for (const f of req.files || []) await B.push(name, f.path, path.posix.join(dir, path.basename(f.originalname)));
  } finally { for (const f of req.files || []) fsp.rm(f.path, { force: true }).catch(() => {}); }
  res.json({ ok: true, count: (req.files || []).length });
}));
app.get('/api/vms/:name/files/download', wrap(async (req, res) => {
  const name = vmName(req), f = cleanPath(req.query.path);
  const tmp = path.join(os.tmpdir(), 'avm-dl-' + crypto.randomBytes(6).toString('hex'));
  await be(name).pull(name, f, tmp);
  if ((await fsp.stat(tmp)).isDirectory()) { await fsp.rm(tmp, { recursive: true, force: true }); throw err(400, 'That is a folder - download single files'); }
  res.download(tmp, path.posix.basename(f), () => fsp.rm(tmp, { force: true }).catch(() => {}));
}));

// ---------- ports ----------
app.post('/api/vms/:name/ports', wrap(async (req, res) => {
  const name = vmName(req);
  const hostPort = +req.body.hostPort, vmPort = +req.body.vmPort, proto = req.body.proto === 'udp' ? 'udp' : 'tcp';
  if (!(hostPort > 0 && hostPort < 65536 && vmPort > 0 && vmPort < 65536)) throw err(400, 'Bad port');
  if (S.ports.some((p) => p.hostPort === hostPort && p.proto === proto)) throw err(409, 'Host port already used');
  const p = { name, hostPort, vmPort, proto, ip: S.vms[name].privateIp };
  await net.addPort(p);
  S.ports.push(p); save();
  res.json({ ok: true });
}));
app.delete('/api/vms/:name/ports', wrap(async (req, res) => {
  const name = vmName(req);
  const hostPort = +req.body.hostPort, proto = req.body.proto === 'udp' ? 'udp' : 'tcp';
  const p = S.ports.find((x) => x.name === name && x.hostPort === hostPort && x.proto === proto);
  if (p) { await net.removePort(p); S.ports = S.ports.filter((x) => x !== p); save(); }
  res.json({ ok: true });
}));

// ---------- dedicated public IP (1:1 NAT) ----------
app.post('/api/vms/:name/ip', wrap(async (req, res) => {
  const name = vmName(req);
  const pub = String(req.body.ip || '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(pub)) throw err(400, 'Bad IPv4');
  if (S.ips.some((x) => x.pub === pub)) throw err(409, 'IP already assigned');
  for (const x of S.ips.filter((i) => i.name === name)) { await net.removePublicIp(x, cfg.iface); }
  S.ips = S.ips.filter((i) => i.name !== name);
  const x = { name, pub, priv: S.vms[name].privateIp };
  await net.addPublicIp(x, cfg.iface);
  S.ips.push(x); save();
  res.json({ ok: true });
}));
app.delete('/api/vms/:name/ip', wrap(async (req, res) => {
  const name = vmName(req);
  for (const x of S.ips.filter((i) => i.name === name)) await net.removePublicIp(x, cfg.iface);
  S.ips = S.ips.filter((i) => i.name !== name); save();
  res.json({ ok: true });
}));

// ---------- website hosting (static + PHP, auto SSL, MariaDB, phpMyAdmin) ----------
WEB = webHosting({ app, docker, cfg, S, save, err, wrap, cleanPath, ensureDockerNet, allocIp, multer, DOCKER_NET });
// ---------- Discord bot hosting (Node.js / TypeScript / Python) ----------
const BOTS = botHosting({ app, docker, cfg, S, save, err, wrap, cleanPath, multer, DOCKER_NET });

// ---------- web console (pty -> incus exec / docker exec) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
let pty = null;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch (e) { console.error('[avm-node] node-pty not available:', e.message); }

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const bm = /^\/api\/bots\/(bot-[a-f0-9]{8})\/console$/.exec(u.pathname);
  if (bm) {
    if (!tokenOk(u.searchParams.get('token')) || !BOTS.has(bm[1])) { socket.destroy(); return; }
    return wss.handleUpgrade(req, socket, head, (ws) => BOTS.onConsole(ws, bm[1]));
  }
  const m = /^\/api\/vms\/(avm-[a-f0-9]{8})\/console$/.exec(u.pathname);
  if (!m || !tokenOk(u.searchParams.get('token')) || !S.vms[m[1]]) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onConsole(ws, m[1], +u.searchParams.get('cols') || 100, +u.searchParams.get('rows') || 30));
});

async function onConsole(ws, name, cols, rows) {
  const say = (t) => { if (ws.readyState === 1) ws.send(t); };
  if (!(await isRunning(name))) { say('\r\n\x1b[36m[AVM]\x1b[0m VM is not running. Press Start.\r\n'); return ws.close(); }
  if (!pty) { say('\r\n[AVM] Console unavailable on this node (node-pty missing).\r\n'); return ws.close(); }
  const shell = 'export TERM=xterm-256color; cd ~ 2>/dev/null || cd /; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi';
  const [bin, args] = be(name).consoleCmd(name, shell);
  const term = pty.spawn(bin, args, { name: 'xterm-256color', cols, rows, env: { ...process.env, TERM: 'xterm-256color' } });
  term.onData((d) => say(d));
  term.onExit(() => { say('\r\n\x1b[36m[AVM]\x1b[0m session ended\r\n'); try { ws.close(); } catch {} });
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.type === 'input' && typeof d.data === 'string') term.write(d.data);
    else if (d.type === 'resize' && d.cols > 0 && d.rows > 0) { try { term.resize(Math.min(500, d.cols), Math.min(200, d.rows)); } catch {} }
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
}

// ---------- boot: re-apply network rules (iptables is not persistent) ----------
async function dockerCompat() {
  // Docker sets the FORWARD policy to DROP - keep the Incus bridge working next to it
  await net.dockerCompat(BRIDGE).catch(() => {});
}
(async () => {
  const d = await docker.available();
  if (d.ok) { await ensureDockerNet().catch((e) => console.error('[avm-node] docker network:', e.message)); await dockerCompat(); WEB.boot().catch((e) => console.error('[avm-node] web boot:', e.message)); BOTS.boot().catch((e) => console.error('[avm-node] bots boot:', e.message)); }
  for (const p of S.ports) await net.addPort(p).catch((e) => console.error('[avm-node] port restore failed', p.hostPort, e.message));
  for (const x of S.ips) await net.addPublicIp(x, cfg.iface).catch((e) => console.error('[avm-node] ip restore failed', x.pub, e.message));
  // Docker may (re)start after us and rebuild its chains: re-check our rules every minute
  setInterval(async () => {
    if (!(await docker.available()).ok) return;
    dockerNetCache = null;
    await dockerCompat();
    for (const p of S.ports) await net.addPort(p, { quiet: true }).catch(() => {});
  }, 60000).unref();
  server.listen(PORT, cfg.host || '127.0.0.1', () => console.log(`[avm-node] listening on ${cfg.host || '127.0.0.1'}:${PORT} (kvm: ${fs.existsSync('/dev/kvm')}, docker: ${d.ok})`));
})();
