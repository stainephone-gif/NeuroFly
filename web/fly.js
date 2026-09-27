// A fruit fly seen from above, drawn procedurally and driven only by the
// brain's named channels. The channel -> body mapping is BODY_RULES and
// nothing else; everything below it is drawing.

export const BODY_RULES = {
  forward:   { channel: 'p9',      ref: 100, speed: 70 },   // px/s at the reference rate
  backward:  { channel: 'mdn',     ref: 100, speed: 45 },
  turnLeft:  { channel: 'dna02_l', ref: 100, rate: 110 },   // deg/s
  turnRight: { channel: 'dna02_r', ref: 100, rate: 110 },
  proboscis: { channel: 'mn9',     ref: 90 },                // extension 0..1
  jump:      { channel: 'gf',      threshold: 25 },          // Hz; a jump per crossing
  taste:     { channel: 'sugar',   ref: 200 },               // leg / antenna twitch
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const TAU = Math.PI * 2;

// Look: a metallic green blow fly seen from above (as in the reference photo).
// leg geometry in body units (head points +x). coxa: attachment on the thorax;
// rest: resting foot position; swing: how far the foot travels during a stride
const LEGS = [
  { coxa: [8, 4],   rest: [27, 19],  swing: 7 },   // front
  { coxa: [3, 6],   rest: [4, 27],   swing: 8 },   // middle
  { coxa: [-2, 6],  rest: [-22, 24], swing: 7 },   // hind
];

// deterministic pseudo-random numbers so the bristles do not flicker
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
function bristles(seed, n, cx, cy, rx, ry, len) {
  const r = rng(seed), out = [];
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r());
    const x = cx + Math.cos(a) * rx * d, y = cy + Math.sin(a) * ry * d;
    const dir = Math.atan2(y - cy, x - cx) + (r() - 0.5) * 0.8 + Math.PI * 0.85;   // lie backwards
    out.push([x, y, dir, len * (0.6 + r() * 0.8)]);
  }
  return out;
}
const THORAX_BRISTLES = bristles(7, 34, 4, 0, 8.5, 9, 1.5);
const ABDOMEN_BRISTLES = bristles(11, 50, -14, 0, 11.5, 10, 1.3);
const HEAD_BRISTLES = bristles(3, 16, 15, 0, 3, 7, 1.6);

export class FlyArena {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.rates = {}; this.smooth = {};
    this.x = 0; this.y = 0; this.heading = -Math.PI / 2;
    this.phase = 0; this.trail = []; this.jumpT = -1; this.jumpFrom = null; this.jumpTo = null;
    this.lastGf = 0; this.t = 0; this.action = ''; this.wingBuzz = 0; this.groom = 0;
  }
  setRates(r) { this.rates = r || {}; }
  resize() {
    const dpr = Math.min(devicePixelRatio, 2), w = this.c.clientWidth, h = this.c.clientHeight;
    if (this.c.width !== w * dpr) { this.c.width = w * dpr; this.c.height = h * dpr; this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    return [w, h];
  }
  level(key, dt = 1 / 60) {
    const r = BODY_RULES[key], raw = clamp01((this.rates[r.channel] || 0) / r.ref);
    const k = 1 - Math.exp(-dt / 0.25);   // time-based smoothing, independent of frame rate
    const s = this.smooth[key] === undefined ? raw : this.smooth[key] + (raw - this.smooth[key]) * k;
    this.smooth[key] = s;
    return s;
  }
  step(dt) {
    const [w, h] = this.resize();
    const R = Math.min(w, h) / 2 - 36;
    this.t += dt;
    const fwd = this.level('forward', dt), back = this.level('backward', dt);
    const tl = this.level('turnLeft', dt), tr = this.level('turnRight', dt);
    const prob = this.level('proboscis', dt), taste = this.level('taste', dt);
    const gf = this.rates.gf || 0;
    if (gf >= BODY_RULES.jump.threshold && this.lastGf < BODY_RULES.jump.threshold && this.jumpT < 0) {
      this.jumpT = 0;
      const a = Math.random() * TAU, d = R * (0.4 + Math.random() * 0.5);
      this.jumpFrom = [this.x, this.y]; this.jumpTo = [Math.cos(a) * d, Math.sin(a) * d];
      this.heading = Math.atan2(this.jumpTo[1] - this.y, this.jumpTo[0] - this.x);
    }
    this.lastGf = gf;
    let lift = 0, v = 0;
    if (this.jumpT >= 0) {
      this.jumpT += dt; const u = Math.min(1, this.jumpT / 0.7);
      this.x = this.jumpFrom[0] + (this.jumpTo[0] - this.jumpFrom[0]) * u;
      this.y = this.jumpFrom[1] + (this.jumpTo[1] - this.jumpFrom[1]) * u;
      lift = Math.sin(u * Math.PI);
      this.wingBuzz = 1;
      if (u >= 1) this.jumpT = -1;
      this.action = 'прыжок';
    } else {
      this.wingBuzz = Math.max(0, this.wingBuzz - dt * 2);
      v = fwd * BODY_RULES.forward.speed - back * BODY_RULES.backward.speed;
      const turn = (tr - tl) * BODY_RULES.turnLeft.rate * Math.PI / 180;
      this.heading += turn * dt;
      this.x += Math.cos(this.heading) * v * dt; this.y += Math.sin(this.heading) * v * dt;
      // stride phase advances with speed and with turning in place
      this.phase += (Math.abs(v) * 0.11 + Math.abs(turn) * 1.6) * dt;
      const d = Math.hypot(this.x, this.y);
      if (d > R) { this.x *= R / d; this.y *= R / d; this.heading += Math.PI * 0.9 + (Math.random() - 0.5); }
      const turning = Math.abs(tr - tl) > 0.15;
      this.action = fwd > 0.15 && fwd >= back ? 'идёт вперёд' : back > 0.15 ? 'пятится' : turning ? (tr > tl ? 'поворачивает вправо' : 'поворачивает влево') : prob > 0.2 ? 'вытягивает хоботок' : taste > 0.2 ? 'пробует лапкой' : 'стоит';
      // idle grooming: every few seconds the front legs rub together
      this.groom = (Math.abs(v) < 2 && !turning && prob < 0.2) ? (Math.sin(this.t * 0.5) > 0.85 ? 1 : 0) : 0;
    }
    if (Math.abs(v) > 3 || this.jumpT >= 0) { this.trail.push([this.x, this.y]); if (this.trail.length > 400) this.trail.shift(); }
    this.draw(w, h, R, { prob, taste, lift, tl, tr, fwd, back, v, moving: Math.abs(v) > 3 || Math.abs(tr - tl) > 0.15 });
  }

  draw(w, h, R, s) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.translate(w / 2, h / 2);
    // arena floor
    const floor = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R + 12);
    floor.addColorStop(0, 'rgba(255,255,255,.035)'); floor.addColorStop(1, 'rgba(255,255,255,.01)');
    ctx.beginPath(); ctx.arc(0, 0, R + 12, 0, TAU); ctx.fillStyle = floor; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1; ctx.stroke();
    if (this.trail.length > 1) {
      ctx.beginPath(); ctx.moveTo(this.trail[0][0], this.trail[0][1]);
      for (const [x, y] of this.trail) ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255,209,102,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    const S = 2.6 * (1 + s.lift * 0.35);
    // shadow on the floor
    ctx.save(); ctx.translate(this.x + s.lift * 12, this.y + s.lift * 18); ctx.rotate(this.heading); ctx.scale(2.6, 2.6);
    ctx.beginPath(); ctx.ellipse(-6, 0, 26, 16, 0, 0, TAU); ctx.fillStyle = `rgba(0,0,0,${0.4 - s.lift * 0.25})`; ctx.filter = 'blur(2px)'; ctx.fill(); ctx.filter = 'none'; ctx.restore();

    ctx.save(); ctx.translate(this.x, this.y - s.lift * 22); ctx.rotate(this.heading); ctx.scale(S, S);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    this.drawLegs(ctx, s);
    this.drawBody(ctx, s);
    this.drawWings(ctx, s);
    this.drawFront(ctx, s);
    ctx.restore();
    ctx.restore();
  }

  legFoot(i, side, s) {
    // tripod gait: legs front-left, mid-right, hind-left share a phase
    const L = LEGS[i];
    const ph = this.phase + (((i + (side > 0 ? 1 : 0)) % 2) ? Math.PI : 0);
    const dir = s.v >= 0 ? 1 : -1;
    let dx = 0, dy = 0, up = 0;
    if (s.moving) {
      const sw = Math.sin(ph) > 0;           // swing phase: foot flies forward; stance: slides back
      dx = (sw ? dir : -dir) * Math.cos(ph) * L.swing;
      up = Math.max(0, Math.sin(ph)) * 3;
    } else if (s.taste > 0.2 && i === 0) {
      dx = Math.sin(this.t * 22) * 2.5 * s.taste; up = Math.abs(Math.sin(this.t * 22)) * 2 * s.taste;
    } else if (this.groom && i === 0) {
      dx = -7 + Math.sin(this.t * 9) * 3; dy = -8 * side; up = 2;
    }
    return [L.rest[0] + dx, side * L.rest[1] + dy, up];
  }

  drawLegs(ctx, s) {
    for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
      const L = LEGS[i];
      const [cx, cy] = [L.coxa[0], L.coxa[1] * side];
      const [fx, fy, up] = this.legFoot(i, side, s);
      const kx = cx + (fx - cx) * 0.42 + (i === 0 ? 2 : i === 2 ? -2 : 0);
      const ky = cy + (fy - cy) * 0.6 + side * 3;
      const tx = fx - up * 0.2, ty = fy;
      for (const [col, extra] of [['rgba(150,150,145,.55)', 0.9], ['#141414', 0]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.9 + extra; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(kx, ky); ctx.stroke();   // femur
        ctx.lineWidth = 1.3 + extra; ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(tx, ty); ctx.stroke();   // tibia
      }
      ctx.strokeStyle = '#141414';
      // tarsus: five little segments bending forward, ending in claws
      const ux = (tx - kx), uy = (ty - ky), ul = Math.hypot(ux, uy) || 1;
      const ex = tx + (ux / ul) * 6, ey = ty + (uy / ul) * 6;
      ctx.strokeStyle = 'rgba(150,150,145,.7)'; ctx.lineWidth = 1.0; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + 1.2, ey + 0.9 * side); ctx.moveTo(ex, ey); ctx.lineTo(ex + 1.2, ey - 0.6 * side); ctx.stroke();
      // bristles along femur and tibia
      ctx.strokeStyle = 'rgba(170,170,165,.6)'; ctx.lineWidth = 0.3;
      for (const [ax, ay, bx, by, n] of [[cx, cy, kx, ky, 5], [kx, ky, tx, ty, 7]]) {
        const lx = bx - ax, ly = by - ay, ll = Math.hypot(lx, ly) || 1, nx = -ly / ll, ny = lx / ll;
        for (let k = 1; k <= n; k++) {
          const u = k / (n + 1), px = ax + lx * u, py = ay + ly * u, sgn = k % 2 ? 1 : -1;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + nx * 1.4 * sgn + (lx / ll) * 0.8, py + ny * 1.4 * sgn + (ly / ll) * 0.8); ctx.stroke();
        }
      }
    }
  }

  drawWings(ctx, s) {
    const buzz = this.wingBuzz;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(1, side * 5.5);
      // spread in a V at rest, sweeping out and blurring when the fly jumps
      const spread = 0.42 + buzz * (0.7 + Math.sin(this.t * 90) * 0.35);
      ctx.rotate(-side * spread);
      const L = 40, W = 13;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-10, side * 3.5, -28, side * 6, -L, side * 2.5);           // leading (outer) edge
      ctx.bezierCurveTo(-L - 2, -side * 3, -30, -side * W * 0.62, -14, -side * W * 0.5); // tip and trailing edge
      ctx.bezierCurveTo(-7, -side * 4.5, -2, -side * 2, 0, 0);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, -L, 0);
      g.addColorStop(0, 'rgba(130,105,80,.5)'); g.addColorStop(0.25, 'rgba(215,220,225,.3)'); g.addColorStop(1, 'rgba(235,240,245,.2)');
      ctx.fillStyle = g; ctx.fill();
      // faint rainbow sheen of the membrane
      const sh = ctx.createLinearGradient(0, side * 6, -L, -side * 6);
      sh.addColorStop(0.3, 'rgba(120,200,255,0)'); sh.addColorStop(0.55, 'rgba(160,120,255,.08)'); sh.addColorStop(0.75, 'rgba(120,255,190,.07)'); sh.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = sh; ctx.fill();
      ctx.strokeStyle = 'rgba(200,190,175,.45)'; ctx.lineWidth = 0.4; ctx.stroke();
      // venation: costa, radial and medial veins, two crossveins
      ctx.strokeStyle = 'rgba(150,115,80,.85)';
      ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-10, side * 3.4, -26, side * 5.6, -36, side * 3.6); ctx.stroke();
      ctx.lineWidth = 0.45;
      for (const [y0, y1, y2, x2] of [[0.6, 3.2, 2.6, -37], [0.2, 1.4, -0.4, -39], [-0.6, -1.8, -4.5, -36], [-1.2, -4.2, -6.5, -26]]) {
        ctx.beginPath(); ctx.moveTo(-2, side * y0); ctx.quadraticCurveTo(-18, side * y1, x2, side * y2); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(-17, side * 1.6); ctx.lineTo(-18, side * -1.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-25, side * -2.7); ctx.lineTo(-23.5, side * -5.6); ctx.stroke();
      ctx.restore();
    }
    // calypters: pale scales covering the halteres at the wing bases
    for (const side of [-1, 1]) {
      ctx.fillStyle = 'rgba(232,226,210,.85)';
      ctx.beginPath(); ctx.ellipse(-3.5, side * 6.2, 2.6, 1.8, side * 0.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawBristles(ctx, list, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (const [x, y, a, l] of list) { ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); }
    ctx.stroke();
  }

  metallic(ctx, cx, cy, r, stops) {
    const g = ctx.createRadialGradient(cx, cy, 0.5, cx + r * 0.25, cy + r * 0.3, r);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    return g;
  }

  drawBody(ctx, s) {
    // abdomen: rounded, metallic green shading into blue at the rim
    ctx.fillStyle = this.metallic(ctx, -11, -4, 14, [[0, '#b8f0c0'], [0.18, '#5cc98a'], [0.5, '#1f8a6e'], [0.8, '#135a66'], [1, '#0a2a3a']]);
    ctx.beginPath(); ctx.ellipse(-14, 0, 12.5, 10.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(8,30,35,.6)'; ctx.lineWidth = 0.5;
    for (const bx of [-9, -15, -20.5]) { ctx.beginPath(); ctx.ellipse(bx, 0, 1.2, 9.6 - Math.abs(bx + 14) * 0.25, 0, -1.2, 1.2); ctx.stroke(); }
    this.drawBristles(ctx, ABDOMEN_BRISTLES, 'rgba(10,15,15,.7)', 0.25);
  }

  drawFront(ctx, s) {
    // scutellum: small rounded plate behind the thorax
    ctx.fillStyle = this.metallic(ctx, -3, -2, 6, [[0, '#d8f08a'], [0.4, '#5fb85a'], [1, '#1d5a45']]);
    ctx.beginPath(); ctx.ellipse(-3.2, 0, 3.6, 5.2, 0, 0, Math.PI * 2); ctx.fill();
    // thorax: gold-green metallic with three faint dark stripes
    ctx.fillStyle = this.metallic(ctx, 6, -4, 11, [[0, '#f4f8b0'], [0.2, '#c9e05a'], [0.45, '#6fbb4a'], [0.75, '#2a8a5a'], [1, '#12423a']]);
    ctx.beginPath(); ctx.ellipse(4.5, 0, 9, 9.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(10,40,25,.28)'; ctx.lineWidth = 1.1;
    for (const y of [-3.6, 0, 3.6]) { ctx.beginPath(); ctx.moveTo(11, y * 0.7); ctx.quadraticCurveTo(4, y, -3, y * 0.8); ctx.stroke(); }
    this.drawBristles(ctx, THORAX_BRISTLES, 'rgba(8,10,8,.75)', 0.28);
    // head: wide, almost all eyes
    ctx.fillStyle = '#2b2622';
    ctx.beginPath(); ctx.ellipse(15, 0, 4.2, 8.4, 0, 0, Math.PI * 2); ctx.fill();
    for (const side of [-1, 1]) {
      const g = ctx.createRadialGradient(16, side * 3, 0.4, 15.5, side * 4.4, 5);
      g.addColorStop(0, '#d0786a'); g.addColorStop(0.35, '#8e3a30'); g.addColorStop(0.8, '#521c18'); g.addColorStop(1, '#2a0d0b');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(15.3, side * 4.5, 4.4, 4.2, side * 0.25, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.ellipse(16.2, side * 3.4, 1.3, 0.8, side * 0.4, 0, Math.PI * 2); ctx.fill();
    }
    // frons: pale silvery stripe between the eyes, dark centre
    ctx.fillStyle = '#cfc7b3'; ctx.beginPath(); ctx.ellipse(15, 0, 3.6, 1.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3b2c24'; ctx.beginPath(); ctx.ellipse(15, 0, 3.2, 0.5, 0, 0, Math.PI * 2); ctx.fill();
    this.drawBristles(ctx, HEAD_BRISTLES, 'rgba(10,10,10,.85)', 0.35);
    // antennae: short, dark, with feathery aristae
    for (const side of [-1, 1]) {
      const wig = Math.sin(this.t * 6 + side) * s.taste * 1.2;
      ctx.strokeStyle = '#1a1512'; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(18.6, side * 0.9); ctx.lineTo(20.6, side * (1.8 + wig)); ctx.stroke();
      ctx.lineWidth = 0.4; ctx.beginPath(); ctx.moveTo(20.6, side * (1.8 + wig)); ctx.lineTo(23.6, side * (3.2 + wig)); ctx.stroke();
    }
    // proboscis with its sponge-like tip
    if (s.prob > 0.03) {
      const len = 3 + 10 * s.prob;
      ctx.strokeStyle = '#2a211c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(18.5, 0); ctx.lineTo(18.5 + len, 0); ctx.stroke();
      ctx.fillStyle = '#4a3a2e'; ctx.beginPath(); ctx.ellipse(19 + len, 0, 1.6, 2.4, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
}
