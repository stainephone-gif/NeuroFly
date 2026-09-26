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

// leg geometry in body units (head points +x). coxa: attachment on the thorax;
// rest: resting foot position; swing: how far the foot travels during a stride
const LEGS = [
  { coxa: [7, 4],  rest: [22, 17],  swing: 7 },   // front
  { coxa: [2, 5],  rest: [4, 23],   swing: 8 },   // middle
  { coxa: [-4, 5], rest: [-18, 20], swing: 7 },   // hind
];

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
    const S = 2.0 * (1 + s.lift * 0.35);
    // shadow on the floor
    ctx.save(); ctx.translate(this.x + s.lift * 12, this.y + s.lift * 18); ctx.rotate(this.heading); ctx.scale(2.0, 2.0);
    ctx.beginPath(); ctx.ellipse(-2, 0, 22, 11, 0, 0, TAU); ctx.fillStyle = `rgba(0,0,0,${0.4 - s.lift * 0.25})`; ctx.filter = 'blur(2px)'; ctx.fill(); ctx.filter = 'none'; ctx.restore();

    ctx.save(); ctx.translate(this.x, this.y - s.lift * 22); ctx.rotate(this.heading); ctx.scale(S, S);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    this.drawLegs(ctx, s);
    this.drawWings(ctx, s);
    this.drawBody(ctx, s);
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
      const c = Math.cos(ph);              // stance: foot slides back; swing: foot flies forward
      dx = -dir * c * L.swing;
      up = Math.max(0, Math.sin(ph)) * 3;  // lifted during swing
      if (Math.sin(ph) > 0) dx = dir * Math.cos(ph) * L.swing;
    } else if (s.taste > 0.2 && i === 0) {
      dx = Math.sin(this.t * 22) * 2.5 * s.taste; up = Math.abs(Math.sin(this.t * 22)) * 2 * s.taste;
    } else if (this.groom && i === 0) {
      dx = -6 + Math.sin(this.t * 9) * 3; dy = -6 * side; up = 2;
    }
    return [L.rest[0] + dx, side * L.rest[1] + dy, up];
  }

  drawLegs(ctx, s) {
    for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
      const L = LEGS[i];
      const [cx, cy] = [L.coxa[0], L.coxa[1] * side];
      const [fx, fy, up] = this.legFoot(i, side, s);
      // femur goes outward and up (towards the viewer), tibia comes back down to the foot
      const kx = cx + (fx - cx) * 0.45 - (i === 2 ? 2 : i === 0 ? -2 : 0);
      const ky = cy + (fy - cy) * 0.62 + side * 2;
      const shade = 'rgba(70,45,25,.95)', hi = 'rgba(160,120,70,.9)';
      ctx.strokeStyle = shade; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(kx, ky); ctx.stroke();           // femur
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(fx, fy - up * 0.3); ctx.stroke(); // tibia
      ctx.strokeStyle = hi; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(fx, fy - up * 0.3); ctx.lineTo(fx + 3, fy + side * 1.5); ctx.stroke(); // tarsus
      ctx.fillStyle = shade; ctx.beginPath(); ctx.arc(kx, ky, 1.3, 0, TAU); ctx.fill();  // knee
    }
  }

  drawWings(ctx, s) {
    const buzz = this.wingBuzz;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(-2, side * 4);
      // folded flat over the abdomen when at rest, spread and blurred when jumping
      const angle = side * (0.12 + buzz * (0.9 + Math.sin(this.t * 90) * 0.35));
      ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, 0, -30, 0);
      g.addColorStop(0, 'rgba(210,225,245,.55)'); g.addColorStop(1, 'rgba(210,225,245,.18)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-8, side * -6, -26, side * -7, -32, side * -1);
      ctx.bezierCurveTo(-30, side * 4, -12, side * 5, 0, side * 1.5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(120,130,150,.6)'; ctx.lineWidth = 0.5; ctx.stroke();
      // veins
      ctx.strokeStyle = 'rgba(90,100,120,.55)'; ctx.lineWidth = 0.45;
      for (const k of [-1.5, -4, -6]) { ctx.beginPath(); ctx.moveTo(-2, side * k * 0.4); ctx.quadraticCurveTo(-16, side * k, -31, side * (k * 0.35 - 0.5)); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(-14, side * -5.5); ctx.lineTo(-13, side * 2.5); ctx.stroke();
      ctx.restore();
    }
    // halteres
    for (const side of [-1, 1]) {
      ctx.strokeStyle = 'rgba(200,170,90,.8)'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-4, side * 5); ctx.lineTo(-7, side * 8.5); ctx.stroke();
      ctx.fillStyle = 'rgba(230,200,110,.9)'; ctx.beginPath(); ctx.arc(-7, side * 8.5, 1.2, 0, TAU); ctx.fill();
    }
  }

  drawBody(ctx, s) {
    // abdomen: tan with black bands, widest in the middle
    let g = ctx.createRadialGradient(-10, -3, 1, -11, 0, 15);
    g.addColorStop(0, '#d9b37a'); g.addColorStop(0.7, '#a97d45'); g.addColorStop(1, '#5a3d20');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(-3, -7);
    ctx.bezierCurveTo(-12, -9, -24, -6, -27, 0);
    ctx.bezierCurveTo(-24, 6, -12, 9, -3, 7);
    ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(25,15,8,.85)';
    for (const bx of [-8, -13, -18, -22.5]) { ctx.beginPath(); ctx.ellipse(bx, 0, 1.4, 9, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
    // thorax: rounded, lighter, with a dorsal seam and bristle hints
    g = ctx.createRadialGradient(3, -3, 1, 2, 0, 10);
    g.addColorStop(0, '#e2c28c'); g.addColorStop(0.6, '#b5884f'); g.addColorStop(1, '#6b4a26');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(2, 0, 9.5, 7.8, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,20,.5)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-5, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(40,25,10,.6)'; ctx.lineWidth = 0.5;
    for (let k = 0; k < 8; k++) { const a = -1.1 + k * 0.31, r = 7.4; ctx.beginPath(); ctx.moveTo(2 + Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(2 + Math.cos(a) * (r + 2.2), Math.sin(a) * (r + 2.2)); ctx.stroke(); }
    // neck + head
    ctx.fillStyle = '#7a5630'; ctx.beginPath(); ctx.ellipse(11, 0, 2.5, 3.5, 0, 0, TAU); ctx.fill();
    g = ctx.createRadialGradient(14, -1.5, 1, 14, 0, 7);
    g.addColorStop(0, '#d8b57e'); g.addColorStop(1, '#6b4a26');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(14, 0, 5.5, 6.2, 0, 0, TAU); ctx.fill();
    // compound eyes: big, red, with a facet sheen
    for (const side of [-1, 1]) {
      g = ctx.createRadialGradient(15, side * 3.8, 0.5, 15, side * 4.2, 3.6);
      g.addColorStop(0, '#ff8a7a'); g.addColorStop(0.5, '#d9302a'); g.addColorStop(1, '#6e0f10');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(15, side * 4.2, 3.2, 3.9, side * 0.3, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      for (let u = -2; u <= 2; u++) for (let q = -2; q <= 2; q++) { if (u * u + q * q > 5) continue; ctx.beginPath(); ctx.arc(15 + u * 1.1, side * 4.2 + q * 1.2, 0.35, 0, TAU); ctx.fill(); }
    }
    // ocelli
    ctx.fillStyle = '#c93a2c'; for (const [ox, oy] of [[12.5, 0], [13.3, -1.2], [13.3, 1.2]]) { ctx.beginPath(); ctx.arc(ox, oy, 0.45, 0, TAU); ctx.fill(); }
    // antennae with aristae
    for (const side of [-1, 1]) {
      const wig = Math.sin(this.t * 6 + side) * s.taste * 1.5;
      ctx.strokeStyle = '#4a3218'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(18.5, side * 1.6); ctx.lineTo(21, side * (2.8 + wig)); ctx.stroke();
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(21, side * (2.8 + wig)); ctx.lineTo(24.5, side * (4.5 + wig)); ctx.stroke();
    }
    // proboscis: extends from under the head, ends in the labellum
    if (s.prob > 0.03) {
      const len = 3 + 11 * s.prob;
      ctx.strokeStyle = '#8a6437'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(18 + len, 0); ctx.stroke();
      ctx.fillStyle = '#b98a55'; ctx.beginPath(); ctx.ellipse(18 + len + 0.5, 0, 1.6, 2.4, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(60,40,20,.7)'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(18 + len, -2); ctx.lineTo(18 + len, 2); ctx.stroke();
    }
  }
}
