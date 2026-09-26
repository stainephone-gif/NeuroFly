// A stylised fly, seen from above, driven only by the brain's named channels.
// The mapping from channels to body is in BODY_RULES and nowhere else.

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

export class FlyArena {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.rates = {}; this.smooth = {};
    this.x = 0; this.y = 0; this.heading = -Math.PI / 2;
    this.phase = 0; this.trail = []; this.jumpT = -1; this.jumpFrom = null; this.jumpTo = null;
    this.lastGf = 0; this.t = 0; this.action = '';
  }
  setRates(r) { this.rates = r || {}; }
  resize() {
    const dpr = Math.min(devicePixelRatio, 2), w = this.c.clientWidth, h = this.c.clientHeight;
    if (this.c.width !== w * dpr) { this.c.width = w * dpr; this.c.height = h * dpr; this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    return [w, h];
  }
  level(key) {
    const r = BODY_RULES[key], raw = clamp01((this.rates[r.channel] || 0) / r.ref);
    const s = this.smooth[key] === undefined ? raw : this.smooth[key] + (raw - this.smooth[key]) * 0.15;
    this.smooth[key] = s;
    return s;
  }
  step(dt) {
    const [w, h] = this.resize();
    const R = Math.min(w, h) / 2 - 36;
    this.t += dt;
    const fwd = this.level('forward'), back = this.level('backward');
    const tl = this.level('turnLeft'), tr = this.level('turnRight');
    const prob = this.level('proboscis'), taste = this.level('taste');
    const gf = this.rates.gf || 0;
    // jump on a rising crossing of the giant-fibre threshold
    if (gf >= BODY_RULES.jump.threshold && this.lastGf < BODY_RULES.jump.threshold && this.jumpT < 0) {
      this.jumpT = 0;
      const a = Math.random() * Math.PI * 2, d = R * (0.4 + Math.random() * 0.5);
      this.jumpFrom = [this.x, this.y]; this.jumpTo = [Math.cos(a) * d, Math.sin(a) * d];
      this.heading = Math.atan2(this.jumpTo[1] - this.y, this.jumpTo[0] - this.x);
    }
    this.lastGf = gf;
    let lift = 0;
    if (this.jumpT >= 0) {
      this.jumpT += dt; const u = Math.min(1, this.jumpT / 0.7);
      this.x = this.jumpFrom[0] + (this.jumpTo[0] - this.jumpFrom[0]) * u;
      this.y = this.jumpFrom[1] + (this.jumpTo[1] - this.jumpFrom[1]) * u;
      lift = Math.sin(u * Math.PI);
      if (u >= 1) this.jumpT = -1;
      this.action = 'прыжок';
    } else {
      const v = fwd * BODY_RULES.forward.speed - back * BODY_RULES.backward.speed;
      this.heading += ((tr - tl) * BODY_RULES.turnLeft.rate) * Math.PI / 180 * dt;
      this.x += Math.cos(this.heading) * v * dt; this.y += Math.sin(this.heading) * v * dt;
      this.phase += Math.abs(v) * dt * 0.12;
      const d = Math.hypot(this.x, this.y);
      if (d > R) { this.x *= R / d; this.y *= R / d; this.heading += Math.PI * 0.9 + (Math.random() - 0.5); }
      this.action = fwd > 0.15 && fwd >= back ? 'идёт вперёд' : back > 0.15 ? 'пятится' : Math.abs(tr - tl) > 0.15 ? (tr > tl ? 'поворачивает вправо' : 'поворачивает влево') : prob > 0.2 ? 'вытягивает хоботок' : taste > 0.2 ? 'пробует лапкой' : 'стоит';
    }
    if (Math.abs(fwd - back) > 0.05 || this.jumpT >= 0) { this.trail.push([this.x, this.y]); if (this.trail.length > 400) this.trail.shift(); }
    this.draw(w, h, R, { prob, taste, lift, tl, tr, fwd, back });
  }
  draw(w, h, R, s) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.translate(w / 2, h / 2);
    // arena
    ctx.beginPath(); ctx.arc(0, 0, R + 12, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R + 12, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.015)'; ctx.fill();
    // trail
    if (this.trail.length > 1) {
      ctx.beginPath(); ctx.moveTo(this.trail[0][0], this.trail[0][1]);
      for (const [x, y] of this.trail) ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255,209,102,.45)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // shadow
    ctx.save(); ctx.translate(this.x + s.lift * 10, this.y + s.lift * 14); ctx.rotate(this.heading);
    ctx.beginPath(); ctx.ellipse(0, 0, 36, 20, 0, 0, Math.PI * 2); ctx.fillStyle = `rgba(0,0,0,${0.35 - s.lift * 0.2})`; ctx.fill(); ctx.restore();
    // body
    ctx.save(); ctx.translate(this.x, this.y - s.lift * 18); ctx.rotate(this.heading); const sc = 1.7 * (1 + s.lift * 0.35); ctx.scale(sc, sc);
    const ink = '#e8e6df', dim = 'rgba(232,230,223,.55)';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // legs: tripod gait, each leg swings with phase; when standing legs twitch with taste
    ctx.strokeStyle = dim; ctx.lineWidth = 1.6;
    for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
      const ph = this.phase + ((i + (side > 0 ? 1 : 0)) % 2) * Math.PI;
      const swing = Math.sin(ph) * 5 + (s.taste > 0.2 && i === 0 ? Math.sin(this.t * 25) * 2 * s.taste : 0);
      const bx = -6 + i * 7, by = side * 5;
      const kx = bx + 4 + swing * 0.5 - i * 6, ky = side * 15;
      const fx = bx + 10 + swing - i * 11, fy = side * 24;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    }
    // wings (visible when jumping)
    if (s.lift > 0.05) {
      ctx.fillStyle = `rgba(200,220,255,${0.25 * s.lift})`;
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(-8, side * 12, 16, 6, side * (0.5 + Math.sin(this.t * 80) * 0.3), 0, Math.PI * 2); ctx.fill(); }
    }
    // abdomen, thorax, head
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.ellipse(-12, 0, 13, 7.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2, 0, 8, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(13, 0, 5.5, 0, Math.PI * 2); ctx.fill();
    // eyes
    ctx.fillStyle = '#ff5a5a';
    ctx.beginPath(); ctx.arc(14.5, -3.5, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(14.5, 3.5, 2.2, 0, Math.PI * 2); ctx.fill();
    // antennae
    ctx.strokeStyle = dim; ctx.lineWidth = 1.2;
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(17, side * 2); ctx.lineTo(21 + Math.sin(this.t * 6) * s.taste * 2, side * (5 + s.taste * 2)); ctx.stroke(); }
    // proboscis
    if (s.prob > 0.03) {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(17, 0); ctx.lineTo(17 + 14 * s.prob, 0); ctx.stroke();
      ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(17 + 14 * s.prob, 0, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }
}
