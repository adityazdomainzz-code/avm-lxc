// Minecraft servers in the panel: owner + admin API, version lists, Modrinth plugins/mods and schedules (cron).
'use strict';
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const mcdl = require('./mcdl');

const SOFT = Object.keys(mcdl.SOFTWARE);
const JAVAS = [0, 8, 11, 17, 21, 25];
const ACTIONS = ['command', 'restart', 'start', 'stop', 'say'];

// ---------- tiny cron (minute hour day month weekday) ----------
function cronField(f, min, max) {
  const set = new Set();
  for (const part of String(f).split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error('bad cron field: ' + f);
    let a = min, b = max;
    if (m[2] !== undefined) { a = +m[2]; b = m[3] !== undefined ? +m[3] : (m[4] ? max : a); }
    const step = m[4] ? +m[4] : 1;
    if (a < min || b > max || a > b || step < 1) throw new Error('cron value out of range: ' + f);
    for (let i = a; i <= b; i += step) set.add(i);
  }
  return set;
}
function parseCron(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) throw new Error('Cron needs 5 parts: minute hour day month weekday');
  const [mi, h, d, mo, w] = [cronField(p[0], 0, 59), cronField(p[1], 0, 23), cronField(p[2], 1, 31), cronField(p[3], 1, 12), cronField(p[4].replace(/\b7\b/g, '0'), 0, 6)];
  return { mi, h, d, mo, w, anyD: p[2] === '*', anyW: p[4] === '*' };
}
function cronMatch(c, t) {
  if (!c.mi.has(t.getMinutes()) || !c.h.has(t.getHours()) || !c.mo.has(t.getMonth() + 1)) return false;
  const dm = c.d.has(t.getDate()), wm = c.w.has(t.getDay());
  return c.anyD && c.anyW ? true : c.anyD ? wm : c.anyW ? dm : dm || wm;
}
function nextRun(expr, from = new Date()) {
  let c; try { c = parseCron(expr); } catch { return null; }
  const t = new Date(from); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) { if (cronMatch(c, t)) return t.getTime(); t.setMinutes(t.getMinutes() + 1); }
  return null;
}

module.exports = function mcPanel(o) {
  const { app, D, db, auth, admin, wrap, fail, nodeById, nodeReq, requireActive, memUpload } = o;
  D.mc = D.mc || [];

  function mcView(x) {
    const n = nodeById(x.nodeId), owner = D.users.find((u) => u.id === x.ownerId);
    return { ...x, nodeName: n ? n.name : 'deleted node', nodeIp: n ? n.ip : '-', address: n ? `${n.ip}:${x.port}` : '-', ownerName: owner ? owner.username : '-',
      schedules: (x.schedules || []).map((s) => ({ ...s, next: s.enabled ? nextRun(s.cron) : null })) };
  }
  function getMc(req) {
    const x = D.mc.find((m) => m.id === req.params.id);
    if (!x || (!req.user.admin && x.ownerId !== req.user.id)) throw fail(404, 'Server not found');
    return x;
  }
  const mcPath = (x, sub = '') => `/api/mc/${x.mcName}${sub}`;
  const mcNode = (x) => nodeById(x.nodeId);
  const softOk = (s) => { if (!SOFT.includes(s)) throw fail(400, 'Choose Paper, Purpur, Spigot, Vanilla, Forge or Fabric'); return s; };

  // ---------- software / versions (any logged-in user) ----------
  app.get('/api/mc-software', auth, (req, res) => res.json(mcdl.SOFTWARE));
  app.get('/api/mc-versions', auth, wrap(async (req, res) => {
    try { res.json(await mcdl.versions(softOk(req.query.software))); }
    catch (e) { throw fail(e.status || 502, 'Could not load versions: ' + e.message); }
  }));

  // ---------- owner ----------
  app.get('/api/mc', auth, (req, res) => res.json(D.mc.filter((x) => x.ownerId === req.user.id).map(mcView)));
  app.get('/api/mc/:id', auth, wrap(async (req, res) => res.json(mcView(getMc(req)))));
  app.get('/api/mc/:id/status', auth, wrap(async (req, res) => { const x = getMc(req); res.json(await nodeReq(mcNode(x), 'GET', mcPath(x, '/status'))); }));
  app.post('/api/mc/:id/power', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    res.json(await nodeReq(mcNode(x), 'POST', mcPath(x, '/power'), { action: req.body.action }, { timeout: 30 * 60000 }));
  }));
  app.post('/api/mc/:id/command', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    res.json(await nodeReq(mcNode(x), 'POST', mcPath(x, '/command'), { command: String(req.body.command || '') }));
  }));

  // software changer + version changer (same thing on the node: download the new software, keep worlds)
  app.post('/api/mc/:id/software', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const software = softOk(req.body.software || x.software), version = String(req.body.version || '');
    const list = await mcdl.versions(software).catch(() => null);
    if (list && !list.includes(version)) throw fail(400, `${mcdl.SOFTWARE[software].label} has no version ${version}`);
    let downloads;
    try { downloads = await mcdl.resolve(software, version); } catch (e) { throw fail(e.status || 502, e.message); }
    const java = req.body.java !== undefined ? (JAVAS.includes(+req.body.java) ? +req.body.java : 0) : undefined;
    await nodeReq(mcNode(x), 'POST', mcPath(x, '/software'), { software, version, java, downloads, wipe: !!req.body.wipe }, { timeout: 120000 });
    x.software = software; x.version = version; db.save();
    res.json(mcView(x));
  }));
  app.put('/api/mc/:id/settings', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const body = {};
    if (req.body.java !== undefined) body.java = JAVAS.includes(+req.body.java) ? +req.body.java : 0;
    if (req.body.autoRestart !== undefined) body.autoRestart = !!req.body.autoRestart;
    res.json(await nodeReq(mcNode(x), 'PUT', mcPath(x, '/settings'), body));
  }));

  // players
  app.get('/api/mc/:id/players', auth, wrap(async (req, res) => { const x = getMc(req); requireActive(req, x); res.json(await nodeReq(mcNode(x), 'GET', mcPath(x, '/players'))); }));
  app.post('/api/mc/:id/players', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const b = req.body;
    res.json(await nodeReq(mcNode(x), 'POST', mcPath(x, '/players'), { action: String(b.action || ''), player: String(b.player || ''), ip: String(b.ip || ''), reason: String(b.reason || '') }));
  }));

  // plugins / mods
  app.get('/api/mc/:id/plugins', auth, wrap(async (req, res) => { const x = getMc(req); requireActive(req, x); res.json(await nodeReq(mcNode(x), 'GET', mcPath(x, '/plugins'))); }));
  app.get('/api/mc/:id/plugins/search', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    try { res.json(await mcdl.search(x.software, x.version, req.query.q || '', req.query.offset)); }
    catch (e) { throw fail(e.status || 502, 'Modrinth: ' + e.message); }
  }));
  app.post('/api/mc/:id/plugins/install', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const done = [], seen = new Set();
    const one = async (pid, depth) => { // install the plugin/mod and its required dependencies
      if (seen.has(pid) || seen.size > 15) return; seen.add(pid);
      let f; try { f = await mcdl.pickFile(x.software, x.version, pid); } catch (e) { if (depth) return; throw fail(e.status || 502, e.message); }
      await nodeReq(mcNode(x), 'POST', mcPath(x, '/plugins/install'), { url: f.url, filename: f.filename }, { timeout: 15 * 60000 });
      done.push(f.filename);
      if (depth < 2) for (const d of f.deps) await one(d, depth + 1);
    };
    await one(String(req.body.project || ''), 0);
    res.json({ ok: true, installed: done });
  }));
  for (const a of ['toggle', 'delete']) {
    app.post(`/api/mc/:id/plugins/${a}`, auth, wrap(async (req, res) => { const x = getMc(req); requireActive(req, x); res.json(await nodeReq(mcNode(x), 'POST', mcPath(x, `/plugins/${a}`), { file: String(req.body.file || '') })); }));
  }

  // schedules
  function cleanSchedule(b, old = {}) {
    const s = { ...old };
    if (b.name !== undefined) s.name = String(b.name).trim().slice(0, 40) || 'Task';
    if (b.cron !== undefined) { const c = String(b.cron).trim().replace(/\s+/g, ' '); try { parseCron(c); } catch (e) { throw fail(400, e.message); } s.cron = c; }
    if (b.action !== undefined) { if (!ACTIONS.includes(b.action)) throw fail(400, 'Action: command, say, restart, start or stop'); s.action = b.action; }
    if (b.payload !== undefined) s.payload = String(b.payload).replace(/[\r\n]/g, ' ').slice(0, 500);
    if (b.enabled !== undefined) s.enabled = !!b.enabled;
    if ((s.action === 'command' || s.action === 'say') && !s.payload) throw fail(400, s.action === 'say' ? 'Type the message to announce' : 'Type the command to run');
    return s;
  }
  app.post('/api/mc/:id/schedules', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    x.schedules = x.schedules || [];
    if (x.schedules.length >= 20) throw fail(400, 'Max 20 schedules per server');
    const s = cleanSchedule({ name: 'Task', enabled: true, payload: '', ...req.body });
    if (!s.cron || !s.action) throw fail(400, 'Choose when and what');
    s.id = crypto.randomUUID(); s.lastRun = null; s.lastResult = '';
    x.schedules.push(s); db.save();
    res.json(mcView(x));
  }));
  app.put('/api/mc/:id/schedules/:sid', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const i = (x.schedules || []).findIndex((s) => s.id === req.params.sid);
    if (i < 0) throw fail(404, 'Schedule not found');
    x.schedules[i] = cleanSchedule(req.body, x.schedules[i]); db.save();
    res.json(mcView(x));
  }));
  app.delete('/api/mc/:id/schedules/:sid', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    x.schedules = (x.schedules || []).filter((s) => s.id !== req.params.sid); db.save();
    res.json(mcView(x));
  }));
  app.post('/api/mc/:id/schedules/:sid/run', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const s = (x.schedules || []).find((y) => y.id === req.params.sid);
    if (!s) throw fail(404, 'Schedule not found');
    await runSchedule(x, s);
    res.json(mcView(x));
  }));
  async function runSchedule(x, s) {
    const n = mcNode(x);
    try {
      if (s.action === 'command') await nodeReq(n, 'POST', mcPath(x, '/command'), { command: s.payload });
      else if (s.action === 'say') await nodeReq(n, 'POST', mcPath(x, '/command'), { command: 'say ' + s.payload });
      else await nodeReq(n, 'POST', mcPath(x, '/power'), { action: s.action }, { timeout: 30 * 60000 });
      s.lastResult = 'ok';
    } catch (e) { s.lastResult = e.message.slice(0, 120); }
    s.lastRun = Date.now(); db.save();
  }
  // every minute: run the schedules that match (panel server time)
  let lastMinute = -1;
  setInterval(() => {
    const now = new Date(), key = Math.floor(now.getTime() / 60000);
    if (key === lastMinute) return;
    lastMinute = key;
    for (const x of D.mc) {
      if (x.suspended) continue;
      for (const s of x.schedules || []) {
        if (!s.enabled) continue;
        let c; try { c = parseCron(s.cron); } catch { continue; }
        if (cronMatch(c, now)) runSchedule(x, s).catch(() => {});
      }
    }
  }, 10000).unref();

  // files (same file manager as bots, start folder /)
  app.get('/api/mc/:id/files', auth, wrap(async (req, res) => { const x = getMc(req); requireActive(req, x); res.json(await nodeReq(mcNode(x), 'GET', mcPath(x, `/files?path=${encodeURIComponent(req.query.path || '/')}`))); }));
  app.get('/api/mc/:id/files/content', auth, wrap(async (req, res) => { const x = getMc(req); requireActive(req, x); res.json(await nodeReq(mcNode(x), 'GET', mcPath(x, `/files/content?path=${encodeURIComponent(req.query.path)}`))); }));
  app.get('/api/mc/:id/files/download', auth, wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const r = await nodeReq(mcNode(x), 'GET', mcPath(x, `/files/download?path=${encodeURIComponent(req.query.path)}`), undefined, { raw: true, timeout: 600000 });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return res.status(r.status).json({ error: j.error || 'Download failed' }); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.query.path || 'file').replace(/"/g, '')}"`);
    Readable.fromWeb(r.body).pipe(res);
  }));
  for (const a of ['write', 'mkdir', 'rename', 'delete', 'extract']) {
    app.post(`/api/mc/:id/files/${a}`, auth, wrap(async (req, res) => { const x = getMc(req); requireActive(req, x); res.json(await nodeReq(mcNode(x), 'POST', mcPath(x, `/files/${a}`), req.body, { timeout: 300000 })); }));
  }
  app.post('/api/mc/:id/files/upload', auth, memUpload.array('files'), wrap(async (req, res) => {
    const x = getMc(req); requireActive(req, x);
    const fd = new FormData();
    const rels = [].concat(req.body && req.body.paths !== undefined ? req.body.paths : []);
    const files = req.files || [];
    files.forEach((f, i) => {
      if (rels.length === files.length) fd.append('paths', String(rels[i] || '').slice(0, 1000));
      fd.append('files', new Blob([f.buffer]), f.originalname);
    });
    res.json(await nodeReq(mcNode(x), 'POST', mcPath(x, `/files/upload?path=${encodeURIComponent(req.query.path || '/')}`), fd, { timeout: 900000 }));
  }));

  // ---------- admin ----------
  function freePort(n, want) {
    const used = new Set([...D.ports.filter((p) => p.nodeId === n.id).map((p) => p.hostPort), ...D.mc.filter((m) => m.nodeId === n.id).map((m) => m.port)]);
    if (want) {
      if (want < 1024 || want > 65535) throw fail(400, 'Port must be 1024-65535');
      if (used.has(want)) throw fail(400, `Port ${want} is already used on this node`);
      return want;
    }
    for (let p = 25565; p <= 25665; p++) if (!used.has(p)) return p; // the usual Minecraft ports first
    for (let p = n.portStart; p <= n.portEnd; p++) if (!used.has(p)) return p;
    throw fail(507, 'No free port on this node');
  }
  app.get('/api/admin/mc', auth, admin, (req, res) => res.json(D.mc.map(mcView)));
  app.post('/api/admin/mc', auth, admin, wrap(async (req, res) => {
    const b = req.body;
    const name = String(b.name || '').trim();
    if (!name || name.length > 40) throw fail(400, 'Server name is required (max 40)');
    const owner = D.users.find((u) => u.id === b.ownerId);
    if (!owner) throw fail(400, 'Select an owner');
    const n = nodeById(b.nodeId);
    if (!n) throw fail(400, 'Select a node');
    const software = softOk(b.software), version = String(b.version || '');
    const lim = { cpu: Math.min(64, Math.max(0.5, +b.cpu || 2)), memory: Math.max(512, +b.memory || 2048), disk: Math.max(1, +b.disk || 10) };
    const port = freePort(n, +b.port || 0);
    let downloads;
    try { downloads = await mcdl.resolve(software, version); } catch (e) { throw fail(e.status || 502, e.message); }
    const id = crypto.randomUUID();
    const mcName = 'mc-' + id.replace(/-/g, '').slice(0, 8);
    await nodeReq(n, 'POST', '/api/mc', { name: mcName, software, version, port, downloads, motd: String(b.motd || name), maxPlayers: +b.maxPlayers || 20, ...lim }, { timeout: 60000 });
    const x = { id, name, mcName, ownerId: owner.id, nodeId: n.id, software, version, port, ...lim, schedules: [], suspended: false, createdAt: Date.now() };
    D.mc.push(x); db.save();
    res.json(mcView(x));
  }));
  app.patch('/api/admin/mc/:id', auth, admin, wrap(async (req, res) => {
    const x = D.mc.find((m) => m.id === req.params.id);
    if (!x) throw fail(404, 'Server not found');
    const b = req.body;
    if (b.name) x.name = String(b.name).slice(0, 40);
    if (b.ownerId && D.users.some((u) => u.id === b.ownerId)) x.ownerId = b.ownerId;
    const lim = {};
    for (const k of ['cpu', 'memory', 'disk']) if (b[k] !== undefined && b[k] !== '') lim[k] = Math.max(0, +b[k] || 0);
    if (Object.keys(lim).length) { await nodeReq(mcNode(x), 'PATCH', mcPath(x), lim); Object.assign(x, lim); }
    db.save();
    res.json(mcView(x));
  }));
  app.post('/api/admin/mc/:id/suspend', auth, admin, wrap(async (req, res) => {
    const x = D.mc.find((m) => m.id === req.params.id);
    if (!x) throw fail(404, 'Server not found');
    await nodeReq(mcNode(x), 'POST', mcPath(x, '/suspend'), { suspended: !!req.body.suspended }, { timeout: 120000 });
    x.suspended = !!req.body.suspended; db.save();
    res.json(mcView(x));
  }));
  app.delete('/api/admin/mc/:id', auth, admin, wrap(async (req, res) => {
    const x = D.mc.find((m) => m.id === req.params.id);
    if (!x) throw fail(404, 'Server not found');
    try { await nodeReq(mcNode(x), 'DELETE', mcPath(x), undefined, { timeout: 120000 }); }
    catch (e) { if (!req.query.force) throw fail(e.status || 502, e.message + ' (use force delete to remove it from the panel anyway)'); }
    D.mc = D.mc.filter((m) => m.id !== x.id); db.save();
    res.json({ ok: true });
  }));

  return { has: (id) => D.mc.find((x) => x.id === id) };
};
module.exports.parseCron = parseCron;
module.exports.nextRun = nextRun;
module.exports.cronMatch = cronMatch;
