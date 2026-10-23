// AVM Panel - LXC, KVM & Docker machine panel
'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { WebSocketServer, WebSocket } = require('ws');
const { Readable } = require('stream');
const httpMod = { 'http:': http, 'https:': require('https') };
const db = require('./db');
const cf = require('./cf');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const cfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
const PORT = cfg.port || process.env.AVM_PORT || 8000;
const D = db.load();

// ---------- first boot ----------
if (!D.users.length && cfg.admin && cfg.admin.username && cfg.admin.password) {
  D.users.push({ id: crypto.randomUUID(), username: cfg.admin.username, email: cfg.admin.email || '', password: bcrypt.hashSync(cfg.admin.password, 10), admin: true, createdAt: Date.now() });
  console.log('[avm] admin created:', cfg.admin.username);
}
if (cfg.localNode && cfg.localNode.token && !D.nodes.some((n) => n.local)) {
  D.nodes.push({ id: crypto.randomUUID(), name: 'Local Node', local: true, url: cfg.localNode.url, token: cfg.localNode.token, ip: cfg.localNode.publicIp || '127.0.0.1', portStart: 20000, portEnd: 30000, ipPool: [], createdAt: Date.now() });
  console.log('[avm] local node registered');
}
if (cfg.admin && cfg.admin.password) { delete cfg.admin.password; try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {} }
db.save();

// ---------- helpers ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---------- phpMyAdmin passthrough: browser -> panel /pma/<nodeId>/ -> node daemon -> phpMyAdmin container ----------
// (raw stream proxy, so it is registered before the JSON body parser)
app.use('/pma/:nodeId', (req, res) => {
  const user = userFromReq(req);
  const n = nodeById(req.params.nodeId);
  if (!user) return res.redirect('/');
  if (!n || !(user.admin || D.sites.some((x) => x.ownerId === user.id && x.nodeId === n.id && x.kind === 'php' && !x.suspended))) return res.status(403).send('No access to phpMyAdmin on this node');
  if (!req.originalUrl.startsWith(`/pma/${n.id}/`)) return res.redirect(`/pma/${n.id}/`);
  const target = new URL(n.url.replace(/\/$/, '') + '/api/pma' + req.url);
  const headers = { ...req.headers, authorization: 'Bearer ' + n.token, 'x-avm-pma-uri': `${publicUrl(req)}/pma/${n.id}/` };
  delete headers.host; delete headers.connection;
  if (headers.cookie) headers.cookie = headers.cookie.split(/;\s*/).filter((c) => !/^avm_(session|oauth)=/.test(c)).join('; ');
  const up = httpMod[target.protocol].request(target, { method: req.method, headers, timeout: 600000 }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.status(502).send('Node is unreachable'); else res.end(); });
  req.pipe(up);
});
app.use(express.json({ limit: '12mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  if (!e.status) console.error('[avm]', req.method, req.path, e.message);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const pubUser = (u) => u && ({ id: u.id, username: u.username, email: u.email, admin: !!u.admin, avatar: u.avatar || '', github: !!u.githubId, discord: !!u.discordId, createdAt: u.createdAt });
const S = () => D.settings;

function parseCookies(h) {
  const o = {};
  (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function userFromReq(req) {
  const t = parseCookies(req.headers.cookie).avm_session;
  const s = t && D.sessions[t];
  if (!s || s.expires < Date.now()) return null;
  return D.users.find((u) => u.id === s.userId) || null;
}
const secureFlag = (req) => (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
function startSession(req, res, u) {
  const token = crypto.randomBytes(32).toString('hex');
  for (const [k, v] of Object.entries(D.sessions)) if (v.expires < Date.now()) delete D.sessions[k];
  D.sessions[token] = { userId: u.id, expires: Date.now() + 7 * 864e5 };
  db.save();
  res.append('Set-Cookie', `avm_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 86400}${secureFlag(req)}`);
}
const auth = (req, res, next) => { req.user = userFromReq(req); if (!req.user) return res.status(401).json({ error: 'Not logged in' }); next(); };
const admin = (req, res, next) => (req.user && req.user.admin ? next() : res.status(403).json({ error: 'Admin only' }));

const nodeById = (id) => D.nodes.find((n) => n.id === id);
async function nodeReq(node, method, p, body, opts = {}) {
  if (!node) throw fail(500, 'Node not found');
  const headers = { Authorization: 'Bearer ' + node.token };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try { r = await fetch(node.url.replace(/\/$/, '') + p, { method, headers, body: payload, signal: AbortSignal.timeout(opts.timeout || 30000) }); }
  catch { throw fail(502, `Node "${node.name}" is unreachable`); }
  if (opts.raw) return r;
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw fail(r.status, j.error || `Node error ${r.status}`);
  return j;
}
function getVm(req) {
  const v = D.vms.find((x) => x.id === req.params.id);
  if (!v || (!req.user.admin && v.ownerId !== req.user.id)) throw fail(404, 'VM not found');
  return v;
}
function requireActive(req, v) { if (v.suspended && !req.user.admin) throw fail(403, `This ${v.siteName ? 'website' : v.botName ? 'bot' : 'machine'} is suspended. Contact an admin.`); }
function vmView(v) {
  const n = nodeById(v.nodeId), owner = D.users.find((u) => u.id === v.ownerId);
  return { ...v, nodeName: n ? n.name : 'deleted node', nodeIp: n ? n.ip : '-', ownerName: owner ? owner.username : '-', ports: D.ports.filter((p) => p.vmId === v.id).length };
}
const nodePath = (v, sub = '') => `/api/vms/${v.hostname}${sub}`;
function publicUrl(req) { return (S().publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); }

// ---------- public settings / branding ----------
function publicSettings() {
  const s = S();
  return { panelName: s.panelName, logo: s.logo, background: s.background, backgroundType: s.backgroundType, registration: !!s.registration, github: !!(s.github.enabled && s.github.clientId), discord: !!(s.discord.enabled && s.discord.clientId),
    saas: s.cfSaas && s.cfSaas.ready ? { target: s.cfSaas.fallback, nodeId: s.cfSaas.nodeId } : null };
}
app.get('/api/settings/public', (req, res) => res.json(publicSettings()));
app.use('/uploads', express.static(db.UPLOADS, { maxAge: '7d', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));

// ---------- auth ----------
app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const q = String(username || '').toLowerCase();
  const u = D.users.find((x) => x.username.toLowerCase() === q || (x.email && x.email.toLowerCase() === q));
  if (!u || !u.password || !bcrypt.compareSync(String(password || ''), u.password)) throw fail(401, 'Wrong username or password');
  startSession(req, res, u);
  res.json({ user: pubUser(u) });
}));
app.post('/api/auth/logout', (req, res) => {
  const t = parseCookies(req.headers.cookie).avm_session;
  if (t) { delete D.sessions[t]; db.save(); }
  res.append('Set-Cookie', 'avm_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
const regHits = new Map();
function rateLimit(req, key, max) {
  const ip = req.ip || '';
  const now = Date.now();
  const hits = (regHits.get(key + ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= max) throw fail(429, 'Too many attempts from your network. Try again later.');
  hits.push(now); regHits.set(key + ip, hits);
}
app.post('/api/auth/register', wrap(async (req, res) => {
  if (!S().registration) throw fail(403, 'Registration is closed');
  const { username, email, password } = req.body || {};
  if (!/^[\w.-]{3,24}$/.test(username || '')) throw fail(400, 'Username: 3-24 letters, numbers, _ . -');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || email.length > 120) throw fail(400, 'Enter a valid email');
  if (!password || String(password).length < 6) throw fail(400, 'Password must be at least 6 characters');
  if (D.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw fail(400, 'Username taken');
  if (D.users.some((u) => (u.email || '').toLowerCase() === email.toLowerCase())) throw fail(400, 'Email already registered');
  rateLimit(req, 'reg', 5);
  const u = { id: crypto.randomUUID(), username, email, password: bcrypt.hashSync(String(password), 10), admin: false, createdAt: Date.now() };
  D.users.push(u);
  startSession(req, res, u);
  res.json({ user: pubUser(u) });
}));

// ---------- OAuth: GitHub + Discord ----------
const PROVIDERS = {
  github: {
    authorize: (cid, redirect, state) => `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: cid, redirect_uri: redirect, scope: 'read:user user:email', state })}`,
    async profile(code, c, redirect) {
      const t = await (await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirect }) })).json();
      if (!t.access_token) throw new Error(t.error_description || 'GitHub login failed');
      const h = { Authorization: 'Bearer ' + t.access_token, 'User-Agent': 'AVM-Panel', Accept: 'application/vnd.github+json' };
      const u = await (await fetch('https://api.github.com/user', { headers: h })).json();
      let email = null;
      try { const em = await (await fetch('https://api.github.com/user/emails', { headers: h })).json(); const p = em.find((e) => e.primary && e.verified) || em.find((e) => e.verified); email = p ? p.email : null; } catch {}
      return { id: String(u.id), name: u.login, email, avatar: u.avatar_url };
    },
  },
  discord: {
    authorize: (cid, redirect, state) => `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: cid, redirect_uri: redirect, response_type: 'code', scope: 'identify email', state, prompt: 'none' })}`,
    async profile(code, c, redirect) {
      const t = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirect }) })).json();
      if (!t.access_token) throw new Error(t.error_description || 'Discord login failed');
      const u = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
      return { id: String(u.id), name: u.username, email: u.verified ? u.email : null, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : '' };
    },
  },
};
const oauthStates = new Map(); // state -> { provider, linkUserId, at }
app.get('/auth/:provider', (req, res) => {
  const p = PROVIDERS[req.params.provider], c = S()[req.params.provider];
  if (!p || !c || !c.enabled || !c.clientId) return res.redirect('/?oauth_error=' + encodeURIComponent('This login method is disabled'));
  const state = crypto.randomBytes(16).toString('hex');
  const me = userFromReq(req);
  oauthStates.set(state, { provider: req.params.provider, linkUserId: req.query.link && me ? me.id : null, at: Date.now() });
  for (const [k, v] of oauthStates) if (Date.now() - v.at > 600e3) oauthStates.delete(k);
  res.append('Set-Cookie', `avm_oauth=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureFlag(req)}`);
  res.redirect(p.authorize(c.clientId, `${publicUrl(req)}/auth/${req.params.provider}/callback`, state));
});
app.get('/auth/:provider/callback', async (req, res) => {
  const prov = req.params.provider, p = PROVIDERS[prov], c = S()[prov];
  const back = (msg) => res.redirect('/?oauth_error=' + encodeURIComponent(msg));
  try {
    const st = oauthStates.get(String(req.query.state || ''));
    if (!p || !st || st.provider !== prov || parseCookies(req.headers.cookie).avm_oauth !== req.query.state) return back('Login expired, please try again');
    oauthStates.delete(req.query.state);
    if (req.query.error) return back('Login cancelled');
    const prof = await p.profile(String(req.query.code || ''), c, `${publicUrl(req)}/auth/${prov}/callback`);
    const key = prov + 'Id';
    let u;
    if (st.linkUserId) {
      if (D.users.some((x) => x[key] === prof.id && x.id !== st.linkUserId)) return back(`This ${prov} account is already linked to another user`);
      u = D.users.find((x) => x.id === st.linkUserId);
      if (!u) return back('User not found');
      u[key] = prof.id; if (!u.avatar) u.avatar = prof.avatar;
      db.save();
      startSession(req, res, u);
      return res.redirect('/#/account');
    }
    u = D.users.find((x) => x[key] === prof.id);
    if (!u && prof.email) { u = D.users.find((x) => x.email && x.email.toLowerCase() === prof.email.toLowerCase()); if (u) u[key] = prof.id; }
    if (!u) {
      if (!S().registration) return back('Registration is closed - ask an admin for an account');
      let name = (prof.name || prov + 'user').replace(/[^\w.-]/g, '').slice(0, 20) || prov + 'user';
      if (name.length < 3) name += '_' + prov;
      let candidate = name, i = 1;
      while (D.users.some((x) => x.username.toLowerCase() === candidate.toLowerCase())) candidate = `${name}${i++}`;
      u = { id: crypto.randomUUID(), username: candidate, email: prof.email || '', password: '', admin: false, avatar: prof.avatar, [key]: prof.id, createdAt: Date.now() };
      D.users.push(u);
    }
    if (!u.avatar && prof.avatar) u.avatar = prof.avatar;
    db.save();
    startSession(req, res, u);
    res.redirect('/#/vms');
  } catch (e) { console.error('[avm] oauth', prov, e.message); back(e.message); }
});

// ---------- account ----------
app.get('/api/me', auth, (req, res) => res.json({ user: pubUser(req.user), settings: publicSettings() }));
app.patch('/api/me', auth, wrap(async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (email !== undefined) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email');
    if (email && D.users.some((u) => u.id !== req.user.id && (u.email || '').toLowerCase() === email.toLowerCase())) throw fail(400, 'Email already used');
    req.user.email = String(email).slice(0, 120);
  }
  if (newPassword) {
    if (req.user.password && !bcrypt.compareSync(String(currentPassword || ''), req.user.password)) throw fail(400, 'Current password is wrong');
    if (String(newPassword).length < 6) throw fail(400, 'Password must be at least 6 characters');
    req.user.password = bcrypt.hashSync(String(newPassword), 10);
  }
  db.save();
  res.json({ user: pubUser(req.user) });
}));
app.post('/api/me/unlink/:provider', auth, wrap(async (req, res) => {
  const key = req.params.provider + 'Id';
  if (!['github', 'discord'].includes(req.params.provider)) throw fail(400, 'bad provider');
  if (!req.user.password && !(req.params.provider === 'github' ? req.user.discordId : req.user.githubId)) throw fail(400, 'Set a password first, otherwise you could not log in anymore');
  delete req.user[key]; db.save();
  res.json({ user: pubUser(req.user) });
}));

// ---------- VMs (owner / admin) ----------
app.get('/api/vms', auth, (req, res) => res.json(D.vms.filter((v) => v.ownerId === req.user.id).map(vmView)));
app.get('/api/vms/:id', auth, wrap(async (req, res) => res.json(vmView(getVm(req)))));
app.get('/api/vms/:id/status', auth, wrap(async (req, res) => {
  const v = getVm(req);
  res.json(await nodeReq(nodeById(v.nodeId), 'GET', nodePath(v, '/status')));
}));
app.post('/api/vms/:id/power', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  res.json(await nodeReq(nodeById(v.nodeId), 'POST', nodePath(v, '/power'), { action: req.body.action }, { timeout: 150000 }));
}));
app.post('/api/vms/:id/sshx', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  res.json(await nodeReq(nodeById(v.nodeId), 'POST', nodePath(v, '/sshx'), { fresh: !!req.body.fresh }, { timeout: 240000 }));
}));
app.post('/api/vms/:id/password', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  res.json(await nodeReq(nodeById(v.nodeId), 'POST', nodePath(v, '/password'), { password: req.body.password }));
}));

// files
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1048576 } });
app.get('/api/vms/:id/files', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  res.json(await nodeReq(nodeById(v.nodeId), 'GET', nodePath(v, `/files?path=${encodeURIComponent(req.query.path || '/')}`)));
}));
app.get('/api/vms/:id/files/content', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  res.json(await nodeReq(nodeById(v.nodeId), 'GET', nodePath(v, `/files/content?path=${encodeURIComponent(req.query.path)}`)));
}));
app.get('/api/vms/:id/files/download', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  const r = await nodeReq(nodeById(v.nodeId), 'GET', nodePath(v, `/files/download?path=${encodeURIComponent(req.query.path)}`), undefined, { raw: true, timeout: 600000 });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return res.status(r.status).json({ error: j.error || 'Download failed' }); }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.query.path || 'file').replace(/"/g, '')}"`);
  Readable.fromWeb(r.body).pipe(res);
}));
for (const a of ['write', 'mkdir', 'rename', 'delete']) {
  app.post(`/api/vms/:id/files/${a}`, auth, wrap(async (req, res) => {
    const v = getVm(req); requireActive(req, v);
    res.json(await nodeReq(nodeById(v.nodeId), 'POST', nodePath(v, `/files/${a}`), req.body));
  }));
}
app.post('/api/vms/:id/files/upload', auth, memUpload.array('files'), wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  const fd = new FormData();
  for (const f of req.files || []) fd.append('files', new Blob([f.buffer]), f.originalname);
  res.json(await nodeReq(nodeById(v.nodeId), 'POST', nodePath(v, `/files/upload?path=${encodeURIComponent(req.query.path || '/root')}`), fd, { timeout: 900000 }));
}));

// ports
function portView(p) {
  const v = D.vms.find((x) => x.id === p.vmId), n = nodeById(p.nodeId);
  const owner = v && D.users.find((u) => u.id === v.ownerId);
  return { ...p, address: n ? `${n.ip}:${p.hostPort}` : '-', vmName: v ? v.name : '-', vmId: p.vmId, owner: owner ? owner.username : '-', nodeName: n ? n.name : '-' };
}
app.get('/api/vms/:id/ports', auth, wrap(async (req, res) => {
  const v = getVm(req);
  res.json({ max: S().maxPortsPerVm, list: D.ports.filter((p) => p.vmId === v.id).map(portView) });
}));
app.post('/api/vms/:id/ports', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  const n = nodeById(v.nodeId);
  const vmPort = +req.body.vmPort, proto = req.body.proto === 'udp' ? 'udp' : 'tcp';
  if (!(vmPort >= 1 && vmPort <= 65535)) throw fail(400, 'VM port must be 1-65535');
  if (!req.user.admin && D.ports.filter((p) => p.vmId === v.id).length >= S().maxPortsPerVm) throw fail(400, `Maximum ${S().maxPortsPerVm} ports per VM`);
  if (D.ports.some((p) => p.vmId === v.id && p.vmPort === vmPort && p.proto === proto)) throw fail(400, 'This port is already exposed');
  const used = new Set(D.ports.filter((p) => p.nodeId === n.id && p.proto === proto).map((p) => p.hostPort));
  let hostPort = +req.body.hostPort || 0;
  if (hostPort) {
    if (hostPort < n.portStart || hostPort > n.portEnd) throw fail(400, `Host port must be between ${n.portStart} and ${n.portEnd}`);
    if (used.has(hostPort)) throw fail(400, 'That host port is taken');
  } else {
    if (vmPort >= n.portStart && vmPort <= n.portEnd && !used.has(vmPort)) hostPort = vmPort; // same number when possible
    else for (let p = n.portStart; p <= n.portEnd; p++) if (!used.has(p)) { hostPort = p; break; }
    if (!hostPort) throw fail(507, 'No free host ports on this node');
  }
  await nodeReq(n, 'POST', nodePath(v, '/ports'), { hostPort, vmPort, proto });
  const p = { id: crypto.randomUUID(), vmId: v.id, nodeId: n.id, hostPort, vmPort, proto, label: String(req.body.label || '').slice(0, 40), createdBy: req.user.id, createdAt: Date.now() };
  D.ports.push(p); db.save();
  res.json(portView(p));
}));
async function deletePort(p) {
  const v = D.vms.find((x) => x.id === p.vmId);
  if (v) await nodeReq(nodeById(p.nodeId), 'DELETE', nodePath(v, '/ports'), { hostPort: p.hostPort, proto: p.proto }).catch(() => {});
  D.ports = D.ports.filter((x) => x.id !== p.id);
}
app.delete('/api/vms/:id/ports/:pid', auth, wrap(async (req, res) => {
  const v = getVm(req); requireActive(req, v);
  const p = D.ports.find((x) => x.id === req.params.pid && x.vmId === v.id);
  if (!p) throw fail(404, 'Port not found');
  await deletePort(p); db.save();
  res.json({ ok: true });
}));

// ---------- WEBSITES (owner / admin) ----------
const HOST_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
function hostOf(domain, sub) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const s = String(sub || '@').trim().toLowerCase();
  if (!HOST_RE.test(d)) throw fail(400, 'Enter a valid domain, e.g. example.com');
  if (s !== '@' && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s)) throw fail(400, 'Subdomain: letters, numbers and - only (or @ for the main domain)');
  const host = s === '@' ? d : `${s}.${d}`;
  if (!HOST_RE.test(host)) throw fail(400, 'Domain is too long');
  return { host, domain: d, sub: s };
}
function siteView(x) {
  const n = nodeById(x.nodeId), owner = D.users.find((u) => u.id === x.ownerId);
  return { ...x, nodeName: n ? n.name : 'deleted node', nodeIp: n ? n.ip : '-', ownerName: owner ? owner.username : '-' };
}
function getSite(req) {
  const x = D.sites.find((s) => s.id === req.params.id);
  if (!x || (!req.user.admin && x.ownerId !== req.user.id)) throw fail(404, 'Website not found');
  return x;
}
const sitePath = (x, sub = '') => `/api/sites/${x.siteName}${sub}`;
const siteNode = (x) => nodeById(x.nodeId);
// Cloudflare for SaaS ("just a CNAME") helpers
const saasCfg = () => (S().cfSaas && S().cfSaas.ready ? S().cfSaas : null);
const saasHosts = (host, www) => (www ? [host, 'www.' + host] : [host]);
function needSaas(nodeId) {
  const c = saasCfg();
  if (!c) throw fail(400, '"Just a CNAME" is not set up yet - Admin → Settings → Customer domains (Cloudflare for SaaS)');
  if (c.nodeId !== nodeId) throw fail(400, `"Just a CNAME" works on the node running the Cloudflare tunnel (${(nodeById(c.nodeId) || {}).name || 'not set'})`);
  return c;
}
async function saasSync(x, oldHosts, newHosts) { // remove hostnames no longer used, add new ones
  const c = saasCfg(); if (!c) return;
  x.cfIds = x.cfIds || {};
  for (const h of oldHosts.filter((h) => !newHosts.includes(h))) { await cf.removeHost(c, h, x.cfIds[h]).catch(() => {}); delete x.cfIds[h]; }
  for (const h of newHosts.filter((h) => !x.cfIds[h])) x.cfIds[h] = await cf.addHost(c, h);
}

app.get('/api/sites', auth, (req, res) => res.json(D.sites.filter((x) => x.ownerId === req.user.id).map(siteView)));
app.get('/api/sites/:id', auth, wrap(async (req, res) => res.json(siteView(getSite(req)))));
app.get('/api/sites/:id/status', auth, wrap(async (req, res) => { const x = getSite(req); res.json(await nodeReq(siteNode(x), 'GET', sitePath(x, '/status'))); }));
app.post('/api/sites/:id/power', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json(await nodeReq(siteNode(x), 'POST', sitePath(x, '/power'), { action: req.body.action }, { timeout: 120000 }));
}));
app.get('/api/sites/:id/logs', auth, wrap(async (req, res) => {
  const x = getSite(req);
  res.json(await nodeReq(siteNode(x), 'GET', sitePath(x, `/logs?kind=${req.query.kind === 'error' ? 'error' : 'access'}`)));
}));
app.get('/api/sites/:id/domain-check', auth, wrap(async (req, res) => {
  const x = getSite(req), n = siteNode(x);
  const out = { ...(await nodeReq(n, 'GET', sitePath(x, `/domain-check?ip=${encodeURIComponent(n.ip)}`), undefined, { timeout: 20000 })), domain: x.domain, sub: x.sub };
  if (x.ssl === 'saas') {
    const c = saasCfg();
    out.mode = 'saas';
    out.saas = { target: c ? c.fallback : null, hosts: [] };
    if (c) out.saas.hosts = await Promise.all(Object.entries(x.cfIds || {}).map(([h, id]) => cf.hostStatus(c, id).catch((e) => ({ hostname: h, status: 'error', errors: [e.message], txt: [] }))));
  }
  res.json(out);
}));
app.put('/api/sites/:id/domain', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  const h = hostOf(req.body.domain, req.body.sub);
  if (D.sites.some((o) => o.id !== x.id && o.host === h.host)) throw fail(400, 'This domain is already used by another website');
  const www = req.body.www === true || req.body.www === 'on';
  const ssl = req.body.ssl ? (['cloudflare', 'saas'].includes(req.body.ssl) ? req.body.ssl : 'auto') : (x.ssl || 'auto');
  if (ssl === 'saas') needSaas(x.nodeId);
  const oldHosts = x.ssl === 'saas' ? saasHosts(x.host, x.www) : [];
  const newHosts = ssl === 'saas' ? saasHosts(h.host, h.sub === '@' && www) : [];
  await saasSync(x, oldHosts, newHosts); // Cloudflare first: if it refuses, nothing changes
  await nodeReq(siteNode(x), 'PUT', sitePath(x, '/domain'), { host: h.host, www: h.sub === '@' && www, ssl });
  Object.assign(x, h, { www: h.sub === '@' && www, ssl }); db.save();
  res.json(siteView(x));
}));
// site files
app.get('/api/sites/:id/files', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json(await nodeReq(siteNode(x), 'GET', sitePath(x, `/files?path=${encodeURIComponent(req.query.path || '/')}`)));
}));
app.get('/api/sites/:id/files/content', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json(await nodeReq(siteNode(x), 'GET', sitePath(x, `/files/content?path=${encodeURIComponent(req.query.path)}`)));
}));
app.get('/api/sites/:id/files/download', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  const r = await nodeReq(siteNode(x), 'GET', sitePath(x, `/files/download?path=${encodeURIComponent(req.query.path)}`), undefined, { raw: true, timeout: 600000 });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return res.status(r.status).json({ error: j.error || 'Download failed' }); }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.query.path || 'file').replace(/"/g, '')}"`);
  Readable.fromWeb(r.body).pipe(res);
}));
for (const a of ['write', 'mkdir', 'rename', 'delete']) {
  app.post(`/api/sites/:id/files/${a}`, auth, wrap(async (req, res) => {
    const x = getSite(req); requireActive(req, x);
    res.json(await nodeReq(siteNode(x), 'POST', sitePath(x, `/files/${a}`), req.body));
  }));
}
app.post('/api/sites/:id/files/upload', auth, memUpload.array('files'), wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  const fd = new FormData();
  for (const f of req.files || []) fd.append('files', new Blob([f.buffer]), f.originalname);
  res.json(await nodeReq(siteNode(x), 'POST', sitePath(x, `/files/upload?path=${encodeURIComponent(req.query.path || '/public_html')}`), fd, { timeout: 900000 }));
}));
// databases (PHP sites)
app.get('/api/sites/:id/dbs', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json({ ...(await nodeReq(siteNode(x), 'GET', sitePath(x, '/dbs'))), pma: `/pma/${x.nodeId}/` });
}));
app.post('/api/sites/:id/dbs', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json(await nodeReq(siteNode(x), 'POST', sitePath(x, '/dbs'), { name: req.body.name }, { timeout: 240000 }));
}));
app.delete('/api/sites/:id/dbs/:db', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json(await nodeReq(siteNode(x), 'DELETE', sitePath(x, `/dbs/${encodeURIComponent(req.params.db)}`), undefined, { timeout: 120000 }));
}));
app.post('/api/sites/:id/dbs/:db/password', auth, wrap(async (req, res) => {
  const x = getSite(req); requireActive(req, x);
  res.json(await nodeReq(siteNode(x), 'POST', sitePath(x, `/dbs/${encodeURIComponent(req.params.db)}/password`), {}, { timeout: 120000 }));
}));

// admin: websites
app.get('/api/admin/sites', auth, admin, (req, res) => res.json(D.sites.map(siteView)));
app.post('/api/admin/sites', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name || name.length > 40) throw fail(400, 'Website name is required (max 40)');
  const owner = D.users.find((u) => u.id === b.ownerId);
  if (!owner) throw fail(400, 'Select an owner');
  const n = nodeById(b.nodeId);
  if (!n) throw fail(400, 'Select a node');
  const kind = b.kind === 'php' ? 'php' : 'static';
  const h = hostOf(b.domain, b.sub);
  if (D.sites.some((o) => o.host === h.host)) throw fail(400, 'This domain is already used by another website');
  const www = h.sub === '@' && (b.www === true || b.www === 'on');
  const lim = { cpu: Math.min(32, Math.max(1, +b.cpu || 1)), memory: Math.max(128, +b.memory || 512), disk: Math.max(1, +b.disk || 5), bandwidth: Math.max(0, +b.bandwidth || 0), dbLimit: kind === 'php' ? Math.max(0, Math.min(100, +b.dbLimit || 0)) : 0 };
  const php = kind === 'php' ? String(b.php || '8.3') : null;
  const ssl = ['cloudflare', 'saas'].includes(b.ssl) ? b.ssl : 'auto';
  if (ssl === 'saas') needSaas(n.id);
  const id = crypto.randomUUID();
  const siteName = 'web-' + id.replace(/-/g, '').slice(0, 8);
  await nodeReq(n, 'POST', '/api/sites', { name: siteName, kind, php, host: h.host, www, ssl, ...lim }, { timeout: 60000 });
  const x = { id, name, siteName, ownerId: owner.id, nodeId: n.id, kind, php, ...h, www, ssl, ...lim, suspended: false, createdAt: Date.now() };
  if (ssl === 'saas') {
    try { await saasSync(x, [], saasHosts(h.host, www)); }
    catch (e) { await saasSync(x, Object.keys(x.cfIds || {}), []).catch(() => {}); await nodeReq(n, 'DELETE', `/api/sites/${siteName}`).catch(() => {}); throw e; }
  }
  D.sites.push(x); db.save();
  res.json(siteView(x));
}));
app.patch('/api/admin/sites/:id', auth, admin, wrap(async (req, res) => {
  const x = D.sites.find((s) => s.id === req.params.id);
  if (!x) throw fail(404, 'Website not found');
  const b = req.body;
  if (b.name) x.name = String(b.name).slice(0, 40);
  if (b.ownerId && D.users.some((u) => u.id === b.ownerId)) x.ownerId = b.ownerId;
  const lim = {};
  for (const k of ['cpu', 'memory', 'disk', 'bandwidth', 'dbLimit']) if (b[k] !== undefined && b[k] !== '') lim[k] = Math.max(0, +b[k] || 0);
  if (Object.keys(lim).length) { await nodeReq(siteNode(x), 'PATCH', sitePath(x), lim); Object.assign(x, lim); }
  db.save();
  res.json(siteView(x));
}));
app.post('/api/admin/sites/:id/suspend', auth, admin, wrap(async (req, res) => {
  const x = D.sites.find((s) => s.id === req.params.id);
  if (!x) throw fail(404, 'Website not found');
  await nodeReq(siteNode(x), 'POST', sitePath(x, '/suspend'), { suspended: !!req.body.suspended });
  x.suspended = !!req.body.suspended; db.save();
  res.json(siteView(x));
}));
app.delete('/api/admin/sites/:id', auth, admin, wrap(async (req, res) => {
  const x = D.sites.find((s) => s.id === req.params.id);
  if (!x) throw fail(404, 'Website not found');
  try { await nodeReq(siteNode(x), 'DELETE', sitePath(x), undefined, { timeout: 180000 }); }
  catch (e) { if (!req.query.force) throw fail(e.status || 502, e.message + ' (use force delete to remove it from the panel anyway)'); }
  if (x.ssl === 'saas') await saasSync(x, Object.keys(x.cfIds || {}), []).catch(() => {});
  D.sites = D.sites.filter((s) => s.id !== x.id); db.save();
  res.json({ ok: true });
}));
app.get('/api/admin/nodes/:nid/web', auth, admin, wrap(async (req, res) => {
  const n = nodeById(req.params.nid);
  if (!n) throw fail(404, 'Node not found');
  res.json(await nodeReq(n, 'GET', '/api/web/status', undefined, { timeout: 10000 }));
}));

// admin: Cloudflare for SaaS setup
function saasView() {
  const c = S().cfSaas || {};
  return { ready: !!c.ready, hasToken: !!c.token, zone: c.zone || '', sub: c.sub || 'sites', fallback: c.fallback || '', tunnelId: c.tunnelId || '', tunnelName: c.tunnelName || '', nodeId: c.nodeId || '', sites: D.sites.filter((x) => x.ssl === 'saas').length };
}
app.get('/api/admin/cfsaas', auth, admin, wrap(async (req, res) => {
  const v = saasView();
  if (v.ready) v.status = await cf.status(S().cfSaas).catch((e) => ({ ok: false, error: e.message }));
  res.json(v);
}));
app.post('/api/admin/cfsaas/tunnels', auth, admin, wrap(async (req, res) => {
  const token = String(req.body.token || '').trim() || (S().cfSaas || {}).token;
  const zone = String(req.body.zone || '').trim().toLowerCase();
  if (!token) throw fail(400, 'Paste a Cloudflare API token');
  if (!zone) throw fail(400, 'Enter your domain on Cloudflare (e.g. hikehost.xyz)');
  const zi = await cf.zoneInfo(token, zone);
  res.json({ ...zi, tunnels: await cf.listTunnels(token, zi.accountId) });
}));
app.put('/api/admin/cfsaas', auth, admin, wrap(async (req, res) => {
  const b = req.body, cur = S().cfSaas || {};
  const token = String(b.token || '').trim() || cur.token;
  const zone = String(b.zone || '').trim().toLowerCase();
  const sub = String(b.sub || 'sites').trim().toLowerCase();
  if (!token) throw fail(400, 'Paste a Cloudflare API token');
  if (!HOST_RE.test(zone)) throw fail(400, 'Enter your domain on Cloudflare (e.g. hikehost.xyz)');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) throw fail(400, 'Subdomain for customer sites: letters, numbers and -');
  if (!/^[0-9a-f-]{36}$/.test(b.tunnelId || '')) throw fail(400, 'Choose the tunnel');
  if (!nodeById(b.nodeId)) throw fail(400, 'Choose the node that runs this tunnel');
  if (cur.ready && D.sites.some((x) => x.ssl === 'saas') && (cur.zone !== zone || cur.tunnelId !== b.tunnelId || cur.nodeId !== b.nodeId)) throw fail(400, 'Websites already use "Just a CNAME" - change their SSL setting first');
  const zi = await cf.zoneInfo(token, zone);
  const tunnels = await cf.listTunnels(token, zi.accountId);
  const t = tunnels.find((x) => x.id === b.tunnelId);
  if (!t) throw fail(400, 'Tunnel not found in this Cloudflare account');
  const c = { ready: false, token, zone: zi.zoneName, zoneId: zi.zoneId, accountId: zi.accountId, sub, fallback: `${sub}.${zi.zoneName}`, tunnelId: t.id, tunnelName: t.name, nodeId: b.nodeId };
  const st = await cf.setup(c);
  S().cfSaas = { ...c, ready: true }; db.save();
  res.json({ ...saasView(), status: st });
}));
app.delete('/api/admin/cfsaas', auth, admin, wrap(async (req, res) => {
  if (D.sites.some((x) => x.ssl === 'saas')) throw fail(400, 'Websites still use "Just a CNAME" - change their SSL setting first');
  S().cfSaas = { ready: false, token: '', zone: '', zoneId: '', accountId: '', sub: 'sites', fallback: '', tunnelId: '', tunnelName: '', nodeId: '' }; db.save();
  res.json({ ok: true });
}));

// ---------- DISCORD BOTS (owner / admin) ----------
const BOT_LANGS = ['node', 'ts', 'python'];
function botView(x) {
  const n = nodeById(x.nodeId), owner = D.users.find((u) => u.id === x.ownerId);
  return { ...x, nodeName: n ? n.name : 'deleted node', ownerName: owner ? owner.username : '-' };
}
function getBot(req) {
  const x = D.bots.find((b) => b.id === req.params.id);
  if (!x || (!req.user.admin && x.ownerId !== req.user.id)) throw fail(404, 'Bot not found');
  return x;
}
const botPath = (x, sub = '') => `/api/bots/${x.botName}${sub}`;
const botNode = (x) => nodeById(x.nodeId);
app.get('/api/bots', auth, (req, res) => res.json(D.bots.filter((x) => x.ownerId === req.user.id).map(botView)));
app.get('/api/bots/:id', auth, wrap(async (req, res) => res.json(botView(getBot(req)))));
app.get('/api/bots/:id/status', auth, wrap(async (req, res) => { const x = getBot(req); res.json(await nodeReq(botNode(x), 'GET', botPath(x, '/status'))); }));
app.post('/api/bots/:id/power', auth, wrap(async (req, res) => {
  const x = getBot(req); requireActive(req, x);
  res.json(await nodeReq(botNode(x), 'POST', botPath(x, '/power'), { action: req.body.action }, { timeout: 30 * 60000 }));
}));
app.put('/api/bots/:id/settings', auth, wrap(async (req, res) => {
  const x = getBot(req); requireActive(req, x);
  const b = req.body, body = {};
  for (const k of ['main', 'startCmd', 'env', 'install', 'autoRestart']) if (b[k] !== undefined) body[k] = b[k];
  if (b.lang !== undefined) { if (!BOT_LANGS.includes(b.lang)) throw fail(400, 'Language must be node, ts or python'); body.lang = b.lang; body.version = b.version; }
  else if (b.version !== undefined) { body.lang = x.lang; body.version = b.version; }
  const r = await nodeReq(botNode(x), 'PUT', botPath(x, '/settings'), body);
  if (body.lang) { x.lang = body.lang; x.version = b.version; db.save(); }
  res.json(r);
}));
app.post('/api/bots/:id/reinstall', auth, wrap(async (req, res) => { const x = getBot(req); requireActive(req, x); res.json(await nodeReq(botNode(x), 'POST', botPath(x, '/reinstall'), {})); }));
app.get('/api/bots/:id/files', auth, wrap(async (req, res) => { const x = getBot(req); requireActive(req, x); res.json(await nodeReq(botNode(x), 'GET', botPath(x, `/files?path=${encodeURIComponent(req.query.path || '/')}`))); }));
app.get('/api/bots/:id/files/content', auth, wrap(async (req, res) => { const x = getBot(req); requireActive(req, x); res.json(await nodeReq(botNode(x), 'GET', botPath(x, `/files/content?path=${encodeURIComponent(req.query.path)}`))); }));
app.get('/api/bots/:id/files/download', auth, wrap(async (req, res) => {
  const x = getBot(req); requireActive(req, x);
  const r = await nodeReq(botNode(x), 'GET', botPath(x, `/files/download?path=${encodeURIComponent(req.query.path)}`), undefined, { raw: true, timeout: 600000 });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return res.status(r.status).json({ error: j.error || 'Download failed' }); }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.query.path || 'file').replace(/"/g, '')}"`);
  Readable.fromWeb(r.body).pipe(res);
}));
for (const a of ['write', 'mkdir', 'rename', 'delete', 'extract']) {
  app.post(`/api/bots/:id/files/${a}`, auth, wrap(async (req, res) => {
    const x = getBot(req); requireActive(req, x);
    res.json(await nodeReq(botNode(x), 'POST', botPath(x, `/files/${a}`), req.body, { timeout: 300000 }));
  }));
}
app.post('/api/bots/:id/files/upload', auth, memUpload.array('files'), wrap(async (req, res) => {
  const x = getBot(req); requireActive(req, x);
  const fd = new FormData();
  for (const f of req.files || []) fd.append('files', new Blob([f.buffer]), f.originalname);
  res.json(await nodeReq(botNode(x), 'POST', botPath(x, `/files/upload?path=${encodeURIComponent(req.query.path || '/')}`), fd, { timeout: 900000 }));
}));
// admin: bots
app.get('/api/admin/bots', auth, admin, (req, res) => res.json(D.bots.map(botView)));
app.post('/api/admin/bots', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name || name.length > 40) throw fail(400, 'Bot name is required (max 40)');
  const owner = D.users.find((u) => u.id === b.ownerId);
  if (!owner) throw fail(400, 'Select an owner');
  const n = nodeById(b.nodeId);
  if (!n) throw fail(400, 'Select a node');
  if (!BOT_LANGS.includes(b.lang)) throw fail(400, 'Choose Node.js, TypeScript or Python');
  const lim = { cpu: Math.min(32, Math.max(0.25, +b.cpu || 1)), memory: Math.max(64, +b.memory || 512), disk: Math.max(1, +b.disk || 2) };
  const id = crypto.randomUUID();
  const botName = 'bot-' + id.replace(/-/g, '').slice(0, 8);
  const env = String(b.token || '').trim() ? [`DISCORD_TOKEN=${String(b.token).trim()}`] : [];
  await nodeReq(n, 'POST', '/api/bots', { name: botName, lang: b.lang, version: b.version, env, starter: b.starter !== false && b.starter !== 'off', ...lim }, { timeout: 60000 });
  const x = { id, name, botName, ownerId: owner.id, nodeId: n.id, lang: b.lang, version: b.version || '', ...lim, suspended: false, createdAt: Date.now() };
  D.bots.push(x); db.save();
  res.json(botView(x));
}));
app.patch('/api/admin/bots/:id', auth, admin, wrap(async (req, res) => {
  const x = D.bots.find((b) => b.id === req.params.id);
  if (!x) throw fail(404, 'Bot not found');
  const b = req.body;
  if (b.name) x.name = String(b.name).slice(0, 40);
  if (b.ownerId && D.users.some((u) => u.id === b.ownerId)) x.ownerId = b.ownerId;
  const lim = {};
  for (const k of ['cpu', 'memory', 'disk']) if (b[k] !== undefined && b[k] !== '') lim[k] = Math.max(0, +b[k] || 0);
  if (Object.keys(lim).length) { await nodeReq(botNode(x), 'PATCH', botPath(x), lim); Object.assign(x, lim); }
  db.save();
  res.json(botView(x));
}));
app.post('/api/admin/bots/:id/suspend', auth, admin, wrap(async (req, res) => {
  const x = D.bots.find((b) => b.id === req.params.id);
  if (!x) throw fail(404, 'Bot not found');
  await nodeReq(botNode(x), 'POST', botPath(x, '/suspend'), { suspended: !!req.body.suspended }, { timeout: 90000 });
  x.suspended = !!req.body.suspended; db.save();
  res.json(botView(x));
}));
app.delete('/api/admin/bots/:id', auth, admin, wrap(async (req, res) => {
  const x = D.bots.find((b) => b.id === req.params.id);
  if (!x) throw fail(404, 'Bot not found');
  try { await nodeReq(botNode(x), 'DELETE', botPath(x), undefined, { timeout: 120000 }); }
  catch (e) { if (!req.query.force) throw fail(e.status || 502, e.message + ' (use force delete to remove it from the panel anyway)'); }
  D.bots = D.bots.filter((b) => b.id !== x.id); db.save();
  res.json({ ok: true });
}));

// ---------- ADMIN ----------
app.get('/api/admin/overview', auth, admin, (req, res) => res.json({
  users: D.users.length, vms: D.vms.length, nodes: D.nodes.length, ports: D.ports.length,
  sites: D.sites.length, phpSites: D.sites.filter((x) => x.kind === 'php').length, bots: D.bots.length,
  suspended: D.vms.filter((v) => v.suspended).length, kvm: D.vms.filter((v) => v.type === 'vm').length, lxc: D.vms.filter((v) => v.type === 'container').length, docker: D.vms.filter((v) => v.type === 'docker').length,
}));

// nodes
app.get('/api/admin/nodes', auth, admin, wrap(async (req, res) => {
  res.json(await Promise.all(D.nodes.map(async (n) => {
    let system = null;
    try { system = await nodeReq(n, 'GET', '/api/system', undefined, { timeout: 6000 }); } catch {}
    const pool = (n.ipPool || []).map((ip) => ({ ip, vm: (D.vms.find((v) => v.nodeId === n.id && v.publicIp === ip) || {}).name || null }));
    return { id: n.id, name: n.name, url: n.url, ip: n.ip, portStart: n.portStart, portEnd: n.portEnd, local: !!n.local, online: !!system, system, vms: D.vms.filter((v) => v.nodeId === n.id).length, ipPool: pool };
  })));
}));
function nodeFields(n, b) {
  if (b.name) n.name = String(b.name).slice(0, 40);
  if (b.url) { if (!/^https?:\/\/.+/.test(b.url)) throw fail(400, 'Daemon URL must start with http(s)://'); n.url = b.url.replace(/\/$/, ''); }
  if (b.token) n.token = String(b.token).trim();
  if (b.ip) n.ip = String(b.ip).trim();
  if (b.portStart) n.portStart = Math.max(1024, +b.portStart);
  if (b.portEnd) n.portEnd = Math.min(65535, +b.portEnd);
  if (n.portEnd < n.portStart) throw fail(400, 'Port end must be bigger than port start');
  if (b.ipPool !== undefined) {
    const list = String(b.ipPool).split(/[\s,]+/).filter(Boolean);
    for (const ip of list) if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw fail(400, 'Bad IP in pool: ' + ip);
    const inUse = D.vms.filter((v) => v.nodeId === n.id && v.publicIp && !list.includes(v.publicIp));
    if (inUse.length) throw fail(400, `IP ${inUse[0].publicIp} is assigned to ${inUse[0].name} - remove it from the VM first`);
    n.ipPool = [...new Set(list)];
  }
}
app.post('/api/admin/nodes', auth, admin, wrap(async (req, res) => {
  const n = { id: crypto.randomUUID(), name: '', url: '', token: '', ip: '', portStart: 20000, portEnd: 30000, ipPool: [], createdAt: Date.now() };
  nodeFields(n, req.body);
  if (!n.name || !n.url || !n.token || !n.ip) throw fail(400, 'Name, daemon URL, token and public IP are required');
  await nodeReq(n, 'GET', '/api/system', undefined, { timeout: 8000 });
  D.nodes.push(n); db.save();
  res.json({ id: n.id });
}));
app.patch('/api/admin/nodes/:nid', auth, admin, wrap(async (req, res) => {
  const n = nodeById(req.params.nid);
  if (!n) throw fail(404, 'Node not found');
  nodeFields(n, req.body); db.save();
  res.json({ ok: true });
}));
app.get('/api/admin/nodes/:nid/images', auth, admin, wrap(async (req, res) => {
  const n = nodeById(req.params.nid);
  if (!n) throw fail(404, 'Node not found');
  res.json(await nodeReq(n, 'GET', '/api/images', undefined, { timeout: 150000 }));
}));
app.get('/api/admin/nodes/:nid/docker-images', auth, admin, wrap(async (req, res) => {
  const n = nodeById(req.params.nid);
  if (!n) throw fail(404, 'Node not found');
  res.json(await nodeReq(n, 'GET', '/api/docker/images', undefined, { timeout: 30000 }));
}));
app.delete('/api/admin/nodes/:nid', auth, admin, wrap(async (req, res) => {
  if (D.vms.some((v) => v.nodeId === req.params.nid)) throw fail(400, 'Delete the VMs on this node first');
  if (D.sites.some((x) => x.nodeId === req.params.nid)) throw fail(400, 'Delete the websites on this node first');
  if (D.bots.some((x) => x.nodeId === req.params.nid)) throw fail(400, 'Delete the Discord bots on this node first');
  D.nodes = D.nodes.filter((n) => n.id !== req.params.nid); db.save();
  res.json({ ok: true });
}));

// vms
app.get('/api/admin/vms', auth, admin, (req, res) => res.json(D.vms.map(vmView)));
app.post('/api/admin/vms', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name || name.length > 40) throw fail(400, 'VM name is required (max 40)');
  const owner = D.users.find((u) => u.id === b.ownerId);
  if (!owner) throw fail(400, 'Select an owner');
  const n = nodeById(b.nodeId);
  if (!n) throw fail(400, 'Select a node');
  const type = ['vm', 'docker'].includes(b.type) ? b.type : 'container';
  const image = String(b.image || '').trim();
  let extra = {};
  if (type === 'docker') {
    if (!/^[a-z0-9][a-z0-9._\/-]*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/.test(image) || image.length > 200) throw fail(400, 'Enter a Docker image, e.g. ubuntu:24.04 or nginx:latest (lowercase)');
    const env = String(b.env || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const e of env) if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) throw fail(400, 'Bad environment line: ' + e.slice(0, 40) + ' (use KEY=value)');
    if (env.length > 50) throw fail(400, 'Max 50 environment variables');
    extra = { env, keepAlive: b.keepAlive === true || b.keepAlive === 'on' || b.keepAlive === '1' };
  } else if (!/^[\w.:/@-]{3,100}$/.test(image)) throw fail(400, 'Select an OS image');
  const cpu = Math.min(64, Math.max(1, +b.cpu || 1)), memory = Math.max(128, +b.memory || 1024), disk = Math.max(1, +b.disk || 10);
  let publicIp = null;
  if (b.publicIp) {
    if (!(n.ipPool || []).includes(b.publicIp)) throw fail(400, 'That IP is not in the node IP pool');
    if (D.vms.some((v) => v.publicIp === b.publicIp)) throw fail(400, 'That IP is already used');
    publicIp = b.publicIp;
  }
  const id = crypto.randomUUID();
  const hostname = 'avm-' + id.replace(/-/g, '').slice(0, 8);
  const r = await nodeReq(n, 'POST', '/api/vms', { name: hostname, type, image, cpu, memory, disk, ...extra });
  const v = { id, name, hostname, ownerId: owner.id, nodeId: n.id, type, image, cpu, memory, disk, privateIp: r.privateIp, publicIp: null, suspended: false, createdAt: Date.now() };
  if (type === 'docker') v.keepAlive = extra.keepAlive;
  D.vms.push(v); db.save();
  if (publicIp) {
    try { await nodeReq(n, 'POST', nodePath(v, '/ip'), { ip: publicIp }); v.publicIp = publicIp; db.save(); }
    catch (e) { return res.json({ ...vmView(v), warning: 'VM created but IP assignment failed: ' + e.message }); }
  }
  res.json(vmView(v));
}));
app.patch('/api/admin/vms/:id', auth, admin, wrap(async (req, res) => {
  const v = D.vms.find((x) => x.id === req.params.id);
  if (!v) throw fail(404, 'VM not found');
  if (req.body.name) v.name = String(req.body.name).slice(0, 40);
  if (req.body.ownerId && D.users.some((u) => u.id === req.body.ownerId)) v.ownerId = req.body.ownerId;
  db.save();
  res.json(vmView(v));
}));
app.post('/api/admin/vms/:id/suspend', auth, admin, wrap(async (req, res) => {
  const v = D.vms.find((x) => x.id === req.params.id);
  if (!v) throw fail(404, 'VM not found');
  v.suspended = !!req.body.suspended;
  if (v.suspended) await nodeReq(nodeById(v.nodeId), 'POST', nodePath(v, '/power'), { action: 'stop' }, { timeout: 90000 }).catch(() => {});
  db.save();
  res.json(vmView(v));
}));
app.post('/api/admin/vms/:id/ip', auth, admin, wrap(async (req, res) => {
  const v = D.vms.find((x) => x.id === req.params.id);
  if (!v) throw fail(404, 'VM not found');
  const n = nodeById(v.nodeId);
  const ip = req.body.ip || null;
  if (ip) {
    if (!(n.ipPool || []).includes(ip)) throw fail(400, 'That IP is not in the node IP pool');
    if (D.vms.some((x) => x.publicIp === ip && x.id !== v.id)) throw fail(400, 'That IP is already used');
    await nodeReq(n, 'POST', nodePath(v, '/ip'), { ip });
  } else await nodeReq(n, 'DELETE', nodePath(v, '/ip'));
  v.publicIp = ip; db.save();
  res.json(vmView(v));
}));
async function deleteVm(v, force) {
  try { await nodeReq(nodeById(v.nodeId), 'DELETE', nodePath(v), undefined, { timeout: 180000 }); }
  catch (e) { if (!force) throw fail(e.status || 502, e.message + ' (use force delete to remove it from the panel anyway)'); }
  D.ports = D.ports.filter((p) => p.vmId !== v.id);
  D.vms = D.vms.filter((x) => x.id !== v.id);
}
app.delete('/api/admin/vms/:id', auth, admin, wrap(async (req, res) => {
  const v = D.vms.find((x) => x.id === req.params.id);
  if (!v) throw fail(404, 'VM not found');
  await deleteVm(v, !!req.query.force); db.save();
  res.json({ ok: true });
}));

// ports (all)
app.get('/api/admin/ports', auth, admin, wrap(async (req, res) => {
  const ufw = {};
  await Promise.all(D.nodes.map(async (n) => { try { ufw[n.id] = (await nodeReq(n, 'GET', '/api/system', undefined, { timeout: 5000 })).ufw; } catch { ufw[n.id] = null; } }));
  res.json(D.ports.map((p) => ({ ...portView(p), ufw: ufw[p.nodeId] })));
}));
app.delete('/api/admin/ports/:pid', auth, admin, wrap(async (req, res) => {
  const p = D.ports.find((x) => x.id === req.params.pid);
  if (!p) throw fail(404, 'Port not found');
  await deletePort(p); db.save();
  res.json({ ok: true });
}));

// users
app.get('/api/admin/users', auth, admin, (req, res) => res.json(D.users.map((u) => ({ ...pubUser(u), vms: D.vms.filter((v) => v.ownerId === u.id).length, sites: D.sites.filter((x) => x.ownerId === u.id).length }))));
app.post('/api/admin/users', auth, admin, wrap(async (req, res) => {
  const { username, email, password } = req.body;
  if (!/^[\w.-]{3,24}$/.test(username || '')) throw fail(400, 'Username: 3-24 letters, numbers, _ . -');
  if (D.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw fail(400, 'Username taken');
  if (!password || password.length < 6) throw fail(400, 'Password must be at least 6 characters');
  const u = { id: crypto.randomUUID(), username, email: email || '', password: bcrypt.hashSync(password, 10), admin: !!req.body.admin, createdAt: Date.now() };
  D.users.push(u); db.save();
  res.json(pubUser(u));
}));
app.patch('/api/admin/users/:uid', auth, admin, wrap(async (req, res) => {
  const u = D.users.find((x) => x.id === req.params.uid);
  if (!u) throw fail(404, 'User not found');
  if (req.body.email !== undefined) u.email = String(req.body.email);
  if (req.body.password) { if (req.body.password.length < 6) throw fail(400, 'Password too short'); u.password = bcrypt.hashSync(req.body.password, 10); }
  if (req.body.admin !== undefined) { if (u.id === req.user.id && !req.body.admin) throw fail(400, 'You cannot remove your own admin'); u.admin = !!req.body.admin; }
  db.save();
  res.json(pubUser(u));
}));
app.delete('/api/admin/users/:uid', auth, admin, wrap(async (req, res) => {
  if (req.params.uid === req.user.id) throw fail(400, 'You cannot delete yourself');
  if (D.vms.some((v) => v.ownerId === req.params.uid)) throw fail(400, 'This user still owns VMs');
  if (D.sites.some((x) => x.ownerId === req.params.uid)) throw fail(400, 'This user still owns websites');
  if (D.bots.some((x) => x.ownerId === req.params.uid)) throw fail(400, 'This user still owns Discord bots');
  D.users = D.users.filter((u) => u.id !== req.params.uid);
  for (const [k, v] of Object.entries(D.sessions)) if (v.userId === req.params.uid) delete D.sessions[k];
  db.save();
  res.json({ ok: true });
}));

// settings
app.get('/api/admin/settings', auth, admin, (req, res) => {
  const s = S();
  const mask = (c) => ({ enabled: !!c.enabled, clientId: c.clientId, hasSecret: !!c.clientSecret });
  res.json({ panelName: s.panelName, logo: s.logo, background: s.background, backgroundType: s.backgroundType, registration: !!s.registration, maxPortsPerVm: s.maxPortsPerVm, publicUrl: s.publicUrl, detectedUrl: publicUrl(req), github: mask(s.github), discord: mask(s.discord) });
});
app.put('/api/admin/settings', auth, admin, wrap(async (req, res) => {
  const s = S(), b = req.body;
  if (b.panelName !== undefined) { const n = String(b.panelName).trim(); if (!n || n.length > 40) throw fail(400, 'Panel name must be 1-40 characters'); s.panelName = n; }
  if (b.registration !== undefined) s.registration = !!b.registration;
  if (b.maxPortsPerVm !== undefined) s.maxPortsPerVm = Math.min(100, Math.max(0, +b.maxPortsPerVm || 0));
  if (b.publicUrl !== undefined) { const u = String(b.publicUrl).trim().replace(/\/$/, ''); if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw fail(400, 'Panel URL must start with http:// or https://'); s.publicUrl = u; }
  for (const p of ['github', 'discord']) {
    if (!b[p]) continue;
    const next = { ...s[p] };
    if (b[p].enabled !== undefined) next.enabled = !!b[p].enabled;
    if (b[p].clientId !== undefined) next.clientId = String(b[p].clientId).trim();
    if (b[p].clientSecret) next.clientSecret = String(b[p].clientSecret).trim();
    if (next.enabled && (!next.clientId || !next.clientSecret)) throw fail(400, `${p} needs a Client ID and Client Secret before it can be enabled`);
    s[p] = next;
  }
  db.save();
  res.json({ ok: true, settings: publicSettings() });
}));
const IMG = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const VID = { 'video/mp4': '.mp4', 'video/webm': '.webm' };
const brandUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1048576 } });
app.post('/api/admin/settings/:kind', auth, admin, brandUpload.single('file'), wrap(async (req, res) => {
  const kind = req.params.kind, f = req.file, s = S();
  if (!['logo', 'background'].includes(kind)) throw fail(404, 'Not found');
  if (!f) throw fail(400, 'No file uploaded');
  let ext = IMG[f.mimetype], type = 'image';
  if (kind === 'logo') { if (!ext) throw fail(400, 'Logo must be a PNG, JPG, WEBP or GIF image'); if (f.size > 5 * 1048576) throw fail(400, 'Logo max 5 MB'); }
  else {
    if (!ext && VID[f.mimetype]) { ext = VID[f.mimetype]; type = 'video'; }
    if (!ext) throw fail(400, 'Background must be an image (PNG/JPG/WEBP/GIF) or a video (MP4/WEBM)');
    if (type === 'image' && f.size > 15 * 1048576) throw fail(400, 'Background image max 15 MB');
  }
  const old = s[kind];
  const file = `${kind}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS, file), f.buffer);
  s[kind] = '/uploads/' + file;
  if (kind === 'background') s.backgroundType = type;
  if (old && old.startsWith('/uploads/')) fs.rm(path.join(db.UPLOADS, path.basename(old)), { force: true }, () => {});
  db.save();
  res.json(publicSettings());
}));
app.delete('/api/admin/settings/:kind', auth, admin, wrap(async (req, res) => {
  const kind = req.params.kind, s = S();
  if (!['logo', 'background'].includes(kind)) throw fail(404, 'Not found');
  if (s[kind] && s[kind].startsWith('/uploads/')) fs.rm(path.join(db.UPLOADS, path.basename(s[kind])), { force: true }, () => {});
  s[kind] = ''; if (kind === 'background') s.backgroundType = '';
  db.save();
  res.json(publicSettings());
}));

// ---------- static ----------
app.get('/health', (req, res) => res.json({ ok: true }));
// web terminal library served locally (no CDN needed)
const nm = (p) => path.join(__dirname, '..', 'node_modules', p);
app.use('/vendor/xterm', express.static(nm('@xterm/xterm'), { maxAge: '7d' }));
app.use('/vendor/xterm-fit', express.static(nm('@xterm/addon-fit'), { maxAge: '7d' }));
// index.html is never cached (it names the versioned js/css files), so updates show up right away
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h',
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(path.join(__dirname, '..', 'public', 'index.html')); });

// upload errors (file too large etc.) as JSON instead of an HTML stack trace
app.use((e, req, res, next) => {
  if (res.headersSent) return next(e);
  res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : e.status || 500).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 500 MB per upload)' : e.message || 'Server error' });
});

// ---------- console websocket proxy ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const user = userFromReq(req);
  const bm = /^\/ws\/bots\/([a-f0-9-]{36})\/console$/.exec(u.pathname);
  const m = /^\/ws\/vms\/([a-f0-9-]{36})\/console$/.exec(u.pathname);
  const v = bm ? D.bots.find((x) => x.id === bm[1]) : m && D.vms.find((x) => x.id === m[1]);
  if (!user || !v || (!user.admin && (v.ownerId !== user.id || v.suspended))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (client) => {
    const n = nodeById(v.nodeId);
    const q = new URLSearchParams({ token: n.token, cols: u.searchParams.get('cols') || '100', rows: u.searchParams.get('rows') || '30' });
    const up = new WebSocket(n.url.replace(/^http/, 'ws') + (bm ? `/api/bots/${v.botName}/console?${q}` : `/api/vms/${v.hostname}/console?${q}`));
    const pending = [];
    up.on('open', () => { while (pending.length) up.send(pending.shift()); });
    up.on('message', (d) => client.readyState === 1 && client.send(d.toString()));
    up.on('close', () => client.close());
    up.on('error', () => { if (client.readyState === 1) client.send('\r\n[AVM] Cannot reach node.\r\n'); client.close(); });
    client.on('message', (d) => { const s = d.toString(); if (up.readyState === 1) up.send(s); else if (pending.length < 50) pending.push(s); });
    client.on('close', () => up.close());
  });
});

server.listen(PORT, cfg.host || '0.0.0.0', () => console.log(`[avm] ${S().panelName} on http://${cfg.host || '0.0.0.0'}:${PORT}`));
