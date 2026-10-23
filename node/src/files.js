// Host-folder file manager routes (used by Discord bots): every path stays inside the item's folder,
// symlinks pointing outside are refused, optional disk quota and .zip extraction.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

module.exports = function mountFiles(app, prefix, o) {
  // o: { pick(req) -> name, base(name) -> folder, wrap, err, cleanPath, multer, quota(name, extraBytes), touched(name), protect: ['/x'] }
  const { wrap, err, cleanPath } = o;
  const protect = o.protect || [];
  function resolveIn(name, p) {
    const base = o.base(name), rel = cleanPath(p), full = path.join(base, rel);
    if (full !== base && !full.startsWith(base + '/')) throw err(400, 'Bad path');
    return { base, full, rel };
  }
  async function checkReal(base, p) {
    const r = await fsp.realpath(p).catch(() => { throw err(404, 'Not found'); });
    if (r !== base && !r.startsWith(base + '/')) throw err(403, 'That path points outside this folder');
    return r;
  }
  async function checkParent(base, full) {
    let d = path.dirname(full);
    while (!fs.existsSync(d)) d = path.dirname(d);
    await checkReal(base, d);
  }
  const quota = (name, extra) => (o.quota ? o.quota(name, extra) : null);
  const touched = (name) => o.touched && o.touched(name);

  app.get(`${prefix}/files`, wrap(async (req, res) => {
    const name = o.pick(req), { base, full } = resolveIn(name, req.query.path);
    const real = await checkReal(base, full);
    if (!(await fsp.stat(real)).isDirectory()) throw err(400, 'Not a folder');
    const list = [];
    for (const d of await fsp.readdir(real, { withFileTypes: true })) {
      try { const st = await fsp.lstat(path.join(real, d.name)); list.push({ name: d.name, dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.size, mtime: st.mtimeMs }); } catch {}
    }
    res.json(list.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)));
  }));
  app.get(`${prefix}/files/content`, wrap(async (req, res) => {
    const name = o.pick(req), { base, full } = resolveIn(name, req.query.path);
    const real = await checkReal(base, full);
    const st = await fsp.stat(real);
    if (st.isDirectory()) throw err(400, 'That is a folder');
    if (st.size > 5 * 1048576) throw err(413, 'File too large to edit (5MB max) - download it instead');
    res.json({ content: await fsp.readFile(real, 'utf8') });
  }));
  app.post(`${prefix}/files/write`, wrap(async (req, res) => {
    const name = o.pick(req), { base, full } = resolveIn(name, req.body.path);
    if (full === base) throw err(400, 'Bad path');
    const content = String(req.body.content ?? '');
    await quota(name, Buffer.byteLength(content));
    await checkParent(base, full);
    const st = await fsp.lstat(full).catch(() => null);
    if (st && (st.isSymbolicLink() || st.isDirectory())) throw err(400, 'Cannot write to that path');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
    touched(name);
    res.json({ ok: true });
  }));
  app.post(`${prefix}/files/mkdir`, wrap(async (req, res) => {
    const name = o.pick(req), { base, full } = resolveIn(name, req.body.path);
    await checkParent(base, full);
    await fsp.mkdir(full, { recursive: true });
    res.json({ ok: true });
  }));
  app.post(`${prefix}/files/rename`, wrap(async (req, res) => {
    const name = o.pick(req), a = resolveIn(name, req.body.from), b = resolveIn(name, req.body.to);
    if (a.full === a.base || b.full === b.base || protect.includes(a.rel)) throw err(400, 'That cannot be renamed');
    await checkParent(a.base, a.full); await checkParent(b.base, b.full);
    await fsp.mkdir(path.dirname(b.full), { recursive: true });
    await fsp.rename(a.full, b.full);
    res.json({ ok: true });
  }));
  app.post(`${prefix}/files/delete`, wrap(async (req, res) => {
    const name = o.pick(req);
    for (const p of req.body.paths || []) {
      const { base, full, rel } = resolveIn(name, p);
      if (full === base || protect.includes(rel)) continue;
      await checkParent(base, full);
      await fsp.rm(full, { recursive: true, force: true });
    }
    touched(name);
    res.json({ ok: true });
  }));
  const upload = o.multer({ dest: path.join(os.tmpdir(), 'avm-files-up'), limits: { fileSize: 2048 * 1048576 } });
  app.post(`${prefix}/files/upload`, upload.array('files'), wrap(async (req, res) => {
    const name = o.pick(req), { base, full: dir } = resolveIn(name, req.query.path);
    try {
      await quota(name, (req.files || []).reduce((a, f) => a + f.size, 0));
      await checkParent(base, path.join(dir, 'x'));
      await fsp.mkdir(dir, { recursive: true });
      await checkReal(base, dir);
      for (const f of req.files || []) {
        const target = path.join(dir, path.basename(f.originalname));
        const st = await fsp.lstat(target).catch(() => null);
        if (st && st.isSymbolicLink()) continue;
        await fsp.copyFile(f.path, target);
      }
    } finally { for (const f of req.files || []) fsp.rm(f.path, { force: true }).catch(() => {}); }
    touched(name);
    res.json({ ok: true, count: (req.files || []).length });
  }));
  app.get(`${prefix}/files/download`, wrap(async (req, res) => {
    const name = o.pick(req), { base, full } = resolveIn(name, req.query.path);
    const real = await checkReal(base, full);
    if ((await fsp.stat(real)).isDirectory()) throw err(400, 'That is a folder - download single files');
    res.download(real, path.basename(real));
  }));
  // extract a .zip next to itself (Python's zipfile drops absolute and ".." paths, never creates symlinks)
  app.post(`${prefix}/files/extract`, wrap(async (req, res) => {
    const name = o.pick(req), { base, full } = resolveIn(name, req.body.path);
    if (!/\.zip$/i.test(full)) throw err(400, 'Only .zip files can be extracted');
    const real = await checkReal(base, full);
    const st = await fsp.stat(real);
    await quota(name, st.size * 3);
    const dest = path.dirname(real);
    const script = `import zipfile,sys,os
z=zipfile.ZipFile(sys.argv[1]); d=os.path.realpath(sys.argv[2]); n=0
for m in z.infolist():
    t=os.path.realpath(os.path.join(d, m.filename))
    if t!=d and not t.startswith(d+os.sep): continue
    z.extract(m, d); n+=1
print(n)`;
    const out = await new Promise((resolve, reject) => execFile('python3', ['-c', script, real, dest], { timeout: 300000, maxBuffer: 4 * 1048576 }, (e, so, se) => (e ? reject(err(500, e.code === 'ENOENT' ? 'python3 is not installed on the node (needed to extract .zip)' : 'Extract failed: ' + String(se || e.message).trim().split('\n').pop())) : resolve(so))));
    touched(name);
    res.json({ ok: true, files: parseInt(out, 10) || 0 });
  }));
};
