// Minecraft software versions + download URLs (Paper/Purpur/Spigot/Vanilla/Forge/Fabric) and Modrinth plugin/mod search.
// Used by the panel; the node only downloads the URLs resolved here (from an allow-list of hosts).
'use strict';

const UA = 'AVM-Panel/1.0 (https://github.com/adityazdomainzz-code/avm-lxc)';
const SOFTWARE = {
  paper: { label: 'Paper', kind: 'plugins', desc: 'Fast, most plugins work' },
  purpur: { label: 'Purpur', kind: 'plugins', desc: 'Paper + extra settings' },
  spigot: { label: 'Spigot', kind: 'plugins', desc: 'Classic plugin server (built on first start)' },
  vanilla: { label: 'Vanilla', kind: 'none', desc: 'Official Mojang server' },
  forge: { label: 'Forge', kind: 'mods', desc: 'Mods (Forge)' },
  fabric: { label: 'Fabric', kind: 'mods', desc: 'Lightweight mods (Fabric)' },
};
const RELEASE = /^(1\.\d+(\.\d+)?|\d{2}\.\d+(\.\d+)?)$/; // 1.21.4 · 26.1 (no snapshots / pre-releases)

async function getJson(url, timeout = 20000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${r.status}`), { status: 502 });
  return r.json();
}
async function getText(url, timeout = 20000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${r.status}`), { status: 502 });
  return r.text();
}
// newest first
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
const uniqSorted = (l) => [...new Set(l.filter((v) => RELEASE.test(v)))].sort(cmpVer);

const cache = new Map();
async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v;
  try { const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v; throw e; } // keep serving the old list if the API is down
}

// ---------- version lists ----------
const LISTERS = {
  async paper() { const j = await getJson('https://fill.papermc.io/v3/projects/paper'); return uniqSorted(Object.values(j.versions || {}).flat()); },
  async purpur() { const j = await getJson('https://api.purpurmc.org/v2/purpur'); return uniqSorted(j.versions || []); },
  async vanilla() { const j = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'); return uniqSorted((j.versions || []).filter((v) => v.type === 'release').map((v) => v.id)); },
  async fabric() { const j = await getJson('https://meta.fabricmc.net/v2/versions/game'); return uniqSorted(j.filter((v) => v.stable).map((v) => v.version)); },
  async forge() {
    const j = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    return uniqSorted(Object.keys(j.promos || {}).map((k) => k.replace(/-(latest|recommended)$/, ''))).filter((v) => !v.startsWith('1.') || cmpVer(v, '1.12.2') <= 0);
  },
  async spigot() {
    const html = await getText('https://hub.spigotmc.org/versions/');
    return uniqSorted([...html.matchAll(/href="([0-9][0-9.]*)\.json"/g)].map((m) => m[1])).filter((v) => !v.startsWith('1.') || cmpVer(v, '1.8') <= 0);
  },
};
async function versions(software) {
  if (!LISTERS[software]) throw Object.assign(new Error('Unknown software'), { status: 400 });
  return cached('v:' + software, 30 * 60000, LISTERS[software]);
}

// ---------- download URLs for one version: [{ url, file }] ----------
async function resolve(software, version) {
  if (!RELEASE.test(version)) throw Object.assign(new Error('Pick a version from the list'), { status: 400 });
  const ver = encodeURIComponent(version);
  if (software === 'paper') {
    const builds = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${ver}/builds`);
    const list = (Array.isArray(builds) ? builds : builds.builds || []).slice().sort((a, b) => (+b.id || 0) - (+a.id || 0)); // newest first
    const b = list.find((x) => String(x.channel).toUpperCase() === 'STABLE') || list[0];
    const d = b && b.downloads && b.downloads['server:default'];
    if (!d || !d.url) throw Object.assign(new Error(`No Paper build for ${version}`), { status: 404 });
    return [{ url: d.url, file: 'server.jar' }];
  }
  if (software === 'purpur') return [{ url: `https://api.purpurmc.org/v2/purpur/${ver}/latest/download`, file: 'server.jar' }];
  if (software === 'vanilla') {
    const m = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const v = (m.versions || []).find((x) => x.id === version);
    if (!v) throw Object.assign(new Error(`Unknown Minecraft version ${version}`), { status: 404 });
    const j = await getJson(v.url);
    if (!j.downloads || !j.downloads.server) throw Object.assign(new Error(`Minecraft ${version} has no server download`), { status: 404 });
    return [{ url: j.downloads.server.url, file: 'server.jar' }];
  }
  if (software === 'fabric') {
    const [loaders, installers] = await Promise.all([getJson(`https://meta.fabricmc.net/v2/versions/loader/${ver}`), getJson('https://meta.fabricmc.net/v2/versions/installer')]);
    const l = (loaders.find((x) => x.loader && x.loader.stable) || loaders[0] || {}).loader;
    const i = installers.find((x) => x.stable) || installers[0];
    if (!l || !i) throw Object.assign(new Error(`No Fabric loader for ${version}`), { status: 404 });
    return [{ url: `https://meta.fabricmc.net/v2/versions/loader/${ver}/${encodeURIComponent(l.version)}/${encodeURIComponent(i.version)}/server/jar`, file: 'fabric-server.jar' }];
  }
  if (software === 'forge') {
    const j = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const fv = j.promos[`${version}-recommended`] || j.promos[`${version}-latest`];
    if (!fv) throw Object.assign(new Error(`No Forge for ${version}`), { status: 404 });
    const full = `${version}-${fv}`;
    return [{ url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`, file: 'forge-installer.jar' }];
  }
  if (software === 'spigot') return [{ url: 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', file: '.buildtools/BuildTools.jar' }];
  throw Object.assign(new Error('Unknown software'), { status: 400 });
}

// ---------- Modrinth (plugins for Paper/Purpur/Spigot, mods for Forge/Fabric) ----------
const LOADERS = { paper: ['paper', 'spigot', 'bukkit', 'purpur'], purpur: ['purpur', 'paper', 'spigot', 'bukkit'], spigot: ['spigot', 'bukkit'], forge: ['forge'], fabric: ['fabric'] };
async function search(software, version, q, offset = 0) {
  const loaders = LOADERS[software];
  if (!loaders) throw Object.assign(new Error('Vanilla servers have no plugins or mods'), { status: 400 });
  const kind = SOFTWARE[software].kind === 'mods' ? 'mod' : 'plugin';
  const facets = [loaders.map((l) => `categories:${l}`), [`versions:${version}`], [`project_type:${kind}`], ['server_side!=unsupported']];
  const u = `https://api.modrinth.com/v2/search?limit=20&offset=${Math.max(0, +offset || 0)}&index=${q ? 'relevance' : 'downloads'}&query=${encodeURIComponent(String(q || '').slice(0, 80))}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const j = await cached('s:' + u, 5 * 60000, () => getJson(u));
  return { total: j.total_hits || 0, hits: (j.hits || []).map((h) => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || '', downloads: h.downloads || 0, author: h.author || '' })) };
}
// best file of a project for this server: [{ url, filename, name, version }]
async function pickFile(software, version, projectId) {
  if (!/^[A-Za-z0-9]{6,12}$/.test(projectId || '')) throw Object.assign(new Error('bad project'), { status: 400 });
  const loaders = LOADERS[software];
  if (!loaders) throw Object.assign(new Error('Vanilla servers have no plugins or mods'), { status: 400 });
  const list = await getJson(`https://api.modrinth.com/v2/project/${projectId}/version?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([version]))}`);
  const v = list.find((x) => x.version_type === 'release') || list[0];
  if (!v) throw Object.assign(new Error(`No version of this ${SOFTWARE[software].kind === 'mods' ? 'mod' : 'plugin'} for ${SOFTWARE[software].label} ${version}`), { status: 404 });
  const f = v.files.find((x) => x.primary) || v.files[0];
  const deps = (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id);
  return { url: f.url, filename: f.filename, name: v.name, version: v.version_number, deps };
}

module.exports = { SOFTWARE, versions, resolve, search, pickFile, cmpVer };
