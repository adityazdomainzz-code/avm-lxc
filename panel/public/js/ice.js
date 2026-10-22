// Slowly drifting ice crystals & snow for the sidebar / login art
(function () {
  function IceDrift(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const colors = opts.colors || ['rgba(255,255,255,.95)', 'rgba(190,238,250,.9)', 'rgba(120,214,235,.7)', 'rgba(255,255,255,.7)'];
    let W = 0, H = 0, items = [], raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function size() {
      const r = canvas.parentElement.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function make(top) {
      const crystal = Math.random() < 0.3;
      return {
        x: Math.random() * W, y: top ? -20 : Math.random() * H,
        r: crystal ? 4 + Math.random() * 5 : 1 + Math.random() * 2.4,
        vy: 0.15 + Math.random() * 0.45, vx: -0.12 + Math.random() * 0.24,
        rot: Math.random() * 6.28, vr: -0.01 + Math.random() * 0.02, sway: Math.random() * 6.28,
        crystal, color: colors[(Math.random() * colors.length) | 0],
      };
    }
    function crystal(p) {
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        ctx.save(); ctx.rotate((i * Math.PI) / 3);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -p.r);
        ctx.moveTo(0, -p.r * 0.55); ctx.lineTo(p.r * 0.28, -p.r * 0.8);
        ctx.moveTo(0, -p.r * 0.55); ctx.lineTo(-p.r * 0.28, -p.r * 0.8);
        ctx.stroke(); ctx.restore();
      }
    }
    function frame() {
      ctx.clearRect(0, 0, W, H);
      for (const p of items) {
        p.sway += 0.012; p.y += p.vy; p.x += p.vx + Math.sin(p.sway) * 0.25; p.rot += p.vr;
        if (p.y > H + 12 || p.x < -20 || p.x > W + 20) Object.assign(p, make(true));
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        if (p.crystal) crystal(p);
        else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    }
    size();
    items = Array.from({ length: Math.min(opts.count || Math.round((W * H) / 7000) + 14, 110) }, () => make(false));
    const ro = new ResizeObserver(size); ro.observe(canvas.parentElement);
    if (reduce) { frame(); cancelAnimationFrame(raf); } else frame();
    return { stop() { cancelAnimationFrame(raf); ro.disconnect(); } };
  }
  window.IceDrift = IceDrift;
})();
