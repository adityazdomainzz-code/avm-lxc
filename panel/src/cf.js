// Cloudflare for SaaS: customers point their own domain to us with ONE CNAME record.
//   their-domain  CNAME  sites.<your zone>   (fallback origin, routed to this server's Cloudflare Tunnel)
// The panel creates a Custom Hostname (Cloudflare issues the SSL certificate) and an ingress rule
// in the tunnel (host -> http://localhost:80, where AVM's web server answers).
'use strict';
const API = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';

function client(token) {
  return async function cf(method, p, body) {
    let r;
    try {
      r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch (e) { throw Object.assign(new Error('Cloudflare API unreachable: ' + e.message), { status: 502 }); }
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok || !j || j.success === false) {
      const e = (j && j.errors && j.errors[0]) || {};
      const msg = e.message || `Cloudflare API error ${r.status}`;
      throw Object.assign(new Error('Cloudflare: ' + msg + (e.code ? ` (code ${e.code})` : '')), { status: r.status === 403 || r.status === 401 ? 400 : 502, cfCode: e.code });
    }
    return j.result;
  };
}

// resolve a zone by name (e.g. hikehost.xyz) -> { zoneId, accountId }
async function zoneInfo(token, zone) {
  const cf = client(token);
  const list = await cf('GET', `/zones?name=${encodeURIComponent(zone)}`);
  if (!list || !list.length) throw Object.assign(new Error(`Zone "${zone}" not found - the API token needs Zone:Read on it`), { status: 400 });
  return { zoneId: list[0].id, accountId: list[0].account.id, zoneName: list[0].name };
}
async function listTunnels(token, accountId) {
  const cf = client(token);
  const list = await cf('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
  return (list || []).map((t) => ({ id: t.id, name: t.name, status: t.status }));
}

let chain = Promise.resolve(); // tunnel config edits are read-modify-write: run them one at a time
function editIngress(c, fn) {
  const run = chain.then(async () => {
    const cf = client(c.token);
    const cur = await cf('GET', `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}/configurations`);
    const config = (cur && cur.config) || {};
    const ingress = Array.isArray(config.ingress) ? config.ingress : [];
    const catchAll = ingress.filter((r) => !r.hostname).pop() || { service: 'http_status:404' };
    const rules = fn(ingress.filter((r) => r.hostname));
    await cf('PUT', `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}/configurations`, { config: { ...config, ingress: [...rules, catchAll] } });
  });
  chain = run.catch(() => {});
  return run;
}
const WEB = 'http://localhost:80';
const addRules = (hosts) => (rules) => [...rules.filter((r) => !hosts.includes(r.hostname)), ...hosts.map((h) => ({ hostname: h, service: WEB, originRequest: {} }))];
const dropRules = (hosts) => (rules) => rules.filter((r) => !hosts.includes(r.hostname));

// one-time setup: fallback hostname record + tunnel rule + SaaS fallback origin
async function setup(c) {
  const cf = client(c.token);
  const fallback = c.fallback;
  // 1. DNS: fallback -> tunnel (proxied CNAME)
  const target = `${c.tunnelId}.cfargotunnel.com`;
  const existing = await cf('GET', `/zones/${c.zoneId}/dns_records?name=${encodeURIComponent(fallback)}`);
  const rec = (existing || [])[0];
  if (!rec) await cf('POST', `/zones/${c.zoneId}/dns_records`, { type: 'CNAME', name: fallback, content: target, proxied: true, ttl: 1, comment: 'AVM Panel - customer websites' });
  else if (rec.type !== 'CNAME' || rec.content !== target || !rec.proxied) {
    if (rec.type !== 'CNAME') { await cf('DELETE', `/zones/${c.zoneId}/dns_records/${rec.id}`); await cf('POST', `/zones/${c.zoneId}/dns_records`, { type: 'CNAME', name: fallback, content: target, proxied: true, ttl: 1 }); }
    else await cf('PATCH', `/zones/${c.zoneId}/dns_records/${rec.id}`, { content: target, proxied: true });
  }
  // 2. tunnel: fallback hostname -> AVM web server
  await editIngress(c, addRules([fallback]));
  // 3. Cloudflare for SaaS fallback origin
  try { await cf('PUT', `/zones/${c.zoneId}/custom_hostnames/fallback_origin`, { origin: fallback }); }
  catch (e) { throw Object.assign(new Error(e.message + ' - enable Cloudflare for SaaS first: Cloudflare dashboard → your domain → SSL/TLS → Custom Hostnames'), { status: 400 }); }
  return status(c);
}
async function status(c) {
  const cf = client(c.token);
  let fallback = null;
  try { fallback = await cf('GET', `/zones/${c.zoneId}/custom_hostnames/fallback_origin`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, fallback: fallback && fallback.origin, fallbackStatus: fallback && fallback.status, errors: (fallback && fallback.errors) || [] };
}

// customer hostnames
async function addHost(c, hostname) {
  const cf = client(c.token);
  await editIngress(c, addRules([hostname]));
  try {
    const r = await cf('POST', `/zones/${c.zoneId}/custom_hostnames`, { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
    return r.id;
  } catch (e) {
    const found = await cf('GET', `/zones/${c.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`).catch(() => null);
    if (found && found[0]) return found[0].id; // already there (e.g. created before)
    await editIngress(c, dropRules([hostname])).catch(() => {});
    throw e;
  }
}
async function removeHost(c, hostname, id) {
  const cf = client(c.token);
  if (id) await cf('DELETE', `/zones/${c.zoneId}/custom_hostnames/${id}`).catch(() => {});
  await editIngress(c, dropRules([hostname])).catch(() => {});
}
async function hostStatus(c, id) {
  const cf = client(c.token);
  const h = await cf('GET', `/zones/${c.zoneId}/custom_hostnames/${id}`);
  const ssl = h.ssl || {};
  return {
    hostname: h.hostname, status: h.status, sslStatus: ssl.status,
    errors: [...(h.verification_errors || []), ...((ssl.validation_errors || []).map((x) => x.message))].filter(Boolean),
    txt: [h.ownership_verification, ...((ssl.validation_records || []).filter((x) => x.txt_name).map((x) => ({ type: 'txt', name: x.txt_name, value: x.txt_value })))].filter((x) => x && x.name),
  };
}

module.exports = { zoneInfo, listTunnels, setup, status, addHost, removeHost, hostStatus };
