// NeuroFly gallery screen: 138k neurons as a living point cloud.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { FlyArena } from './fly.js';

const $ = (s) => document.querySelector(s);
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

// colours per super_class (see meta.super_classes for the order)
const CLASS_COLORS = {
  optic: '#3a6fd8', central: '#a06cff', sensory: '#4fd18a', visual_projection: '#2fbfc7',
  visual_centrifugal: '#7fd6ff', descending: '#ff9f43', ascending: '#ffd166', sensory_ascending: '#bfe36b',
  motor: '#ff5a5a', endocrine: '#ff7ad9', '': '#6b6b6b',
};
const CLASS_RU = {
  optic: 'зрительная доля', central: 'центральный мозг', sensory: 'сенсорные', visual_projection: 'зрительная проекция',
  visual_centrifugal: 'центрифугальные', descending: 'нисходящие', ascending: 'восходящие', sensory_ascending: 'сенсорно-восходящие',
  motor: 'мотонейроны', endocrine: 'эндокринные', '': 'без аннотации',
};

const state = {
  meta: null, n: 0, pos: null, cls: null,
  act: null, flag: null, mode: 'look', scope: 'type',
  selected: null, pendingPre: null, status: null, ws: null, lastFrameWall: 0, linkGroups: true,
};

// ------------------------------------------------------------------ scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
controls.addEventListener('start', () => { controls.autoRotate = false; idleSince = performance.now(); });
let idleSince = performance.now();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let points, pointMat, synLines, extraLines, skeletonLines, selectMarker, synPoints = null, contactPoints = null;

function buildPoints() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(state.pos, 3));
  const color = new Float32Array(state.n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < state.n; i++) {
    c.set(CLASS_COLORS[state.meta.super_classes[state.cls[i]]] || '#777');
    color[3 * i] = c.r; color[3 * i + 1] = c.g; color[3 * i + 2] = c.b;
  }
  g.setAttribute('base', new THREE.BufferAttribute(color, 3));
  state.act = new Float32Array(state.n);
  state.flag = new Float32Array(state.n);
  g.setAttribute('act', new THREE.BufferAttribute(state.act, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('flag', new THREE.BufferAttribute(state.flag, 1).setUsage(THREE.DynamicDrawUsage));
  pointMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: innerHeight / 2 } },
    vertexShader: `
      attribute vec3 base; attribute float act; attribute float flag;
      varying vec3 vColor; varying float vAlpha;
      uniform float uScale;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float a = clamp(act, 0.0, 1.0);
        vec3 col = mix(base * 0.95, vec3(1.0, 0.95, 0.75), a);
        float size = 2.1 + a * 7.0;
        if (flag > 1.5) { col = mix(vec3(0.55, 0.12, 0.12), vec3(1.0, 0.3, 0.3), a); size = 2.2; }
        else if (flag > 0.5) { col = mix(vec3(0.2, 0.7, 1.0), vec3(0.8, 1.0, 1.0), a); size += 1.5; }
        vColor = col;
        vAlpha = 0.42 + a * 0.58 + step(0.5, flag) * 0.3;
        gl_PointSize = size * uScale / -mv.z * 2.2;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.1, d) * vAlpha;
        gl_FragColor = vec4(vColor, a);
      }`,
  });
  points = new THREE.Points(g, pointMat);
  scene.add(points);

  selectMarker = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9 }));
  selectMarker.visible = false; scene.add(selectMarker);
}

function frameCamera() {
  const [lo, hi] = state.meta.bounds;
  const center = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  controls.target.copy(center);
  camera.position.set(center.x, center.y - 60, center.z + 980);
  camera.up.set(0, -1, 0); // EM space: y grows downwards
  camera.lookAt(center);
}

async function loadMesh(name, opts) {
  try {
    const buf = await (await fetch(`/api/mesh/${name}`)).arrayBuffer();
    const [nv, nf] = new Uint32Array(buf, 0, 2);
    const v = new Float32Array(buf, 8, nv * 3);
    const f = new Uint32Array(buf, 8 + nv * 12, nf * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.setIndex(new THREE.BufferAttribute(f, 1));
    g.computeVertexNormals();
    const surf = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: opts.color, transparent: true, opacity: opts.opacity, depthWrite: false, side: THREE.DoubleSide }));
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: opts.color, transparent: true, opacity: opts.wire }));
    scene.add(surf); scene.add(wire);
  } catch (e) { console.warn('mesh', name, e); }
}

// ------------------------------------------------------------ picking
const _v = new THREE.Vector3();
function pick(clientX, clientY) {
  const w = innerWidth, h = innerHeight;
  const nx = (clientX / w) * 2 - 1, ny = -(clientY / h) * 2 + 1;
  camera.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = m.elements, p = state.pos;
  let best = -1, bestD = (14 / w * 2) ** 2, bestZ = Infinity;
  for (let i = 0; i < state.n; i++) {
    const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 0) continue;
    const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
    const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
    const dx = cx - nx, dy = (cy - ny) * (h / w);
    const d = dx * dx + dy * dy;
    if (d < bestD * 1.0001 && (d < bestD * 0.5 || cw < bestZ)) { best = i; bestD = Math.max(d, bestD * 0.5); bestZ = cw; }
  }
  return best;
}

let downAt = null, lastTouch = 0;
function touch() { const now = performance.now(); if (now - lastTouch > 2000) { lastTouch = now; send({ cmd: 'touch' }); } }
addEventListener('pointerdown', touch, { passive: true });
addEventListener('wheel', touch, { passive: true });
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 6 || !state.pos) return;
  const i = pick(e.clientX, e.clientY);
  if (i < 0) return;
  onNeuronClick(i);
});

function onNeuronClick(i) { select(i); }

function select(i) {
  state.selected = i;
  selectMarker.position.set(state.pos[3 * i], state.pos[3 * i + 1], state.pos[3 * i + 2]);
  selectMarker.visible = true;
  send({ cmd: 'info', idx: i });
}

// ------------------------------------------------------------- lines
function setLines(holder, segs, colors) {
  if (holder.obj) { scene.remove(holder.obj); holder.obj.geometry.dispose(); }
  if (!segs.length) { holder.obj = null; return; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(segs, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  holder.obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: holder.opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(holder.obj);
}
synLines = { obj: null, opacity: 0.55 }; extraLines = { obj: null, opacity: 0.95 }; skeletonLines = { obj: null, opacity: 0.9 };

function showSynapses(info) {
  const rows = info.out.slice(0, 150).map(([j, w]) => [info.idx, j, w]).concat(info.in.slice(0, 80).map(([j, w]) => [j, info.idx, w]));
  const segs = new Float32Array(rows.length * 6), col = new Float32Array(rows.length * 6);
  rows.forEach(([a, b, w], k) => {
    segs.set([state.pos[3 * a], state.pos[3 * a + 1], state.pos[3 * a + 2], state.pos[3 * b], state.pos[3 * b + 1], state.pos[3 * b + 2]], 6 * k);
    const c = w > 0 ? [0.4, 1.0, 0.6] : [1.0, 0.35, 0.35];
    col.set([...c, ...c], 6 * k);
  });
  setLines(synLines, segs, col);
}

function drawExtra(list) {
  const segs = new Float32Array(list.length * 6), col = new Float32Array(list.length * 6);
  list.forEach(([a, b, w], k) => {
    segs.set([state.pos[3 * a], state.pos[3 * a + 1], state.pos[3 * a + 2], state.pos[3 * b], state.pos[3 * b + 1], state.pos[3 * b + 2]], 6 * k);
    const c = w > 0 ? [1.0, 0.85, 0.3] : [1.0, 0.4, 0.7];
    col.set([...c, ...c], 6 * k);
  });
  setLines(extraLines, segs, col);
}

function setSynPoints(xyz, colors) {
  if (synPoints) { scene.remove(synPoints); synPoints.geometry.dispose(); synPoints = null; }
  if (!xyz.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  synPoints = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  scene.add(synPoints);
}

async function showSynapsePoints(i) {
  setStatus('загружаю синапсы…');
  try {
    const [outB, inB] = await Promise.all([
      (await fetch(`/api/synapses/${i}/out`)).arrayBuffer(), (await fetch(`/api/synapses/${i}/in`)).arrayBuffer()]);
    const parse = (buf) => { const m = new Uint32Array(buf, 0, 1)[0]; return new Float32Array(buf, 4, m * 3); };
    const o = parse(outB), n = parse(inB);
    const xyz = new Float32Array(o.length + n.length); xyz.set(o); xyz.set(n, o.length);
    const col = new Float32Array(xyz.length);
    for (let k = 0; k < o.length / 3; k++) col.set([1.0, 0.75, 0.3], 3 * k);
    for (let k = 0; k < n.length / 3; k++) col.set([0.35, 0.7, 1.0], o.length + 3 * k);
    setSynPoints(xyz, col);
    setStatus(`${o.length / 3} выходных (жёлтые) и ${n.length / 3} входных (синие) синапсов`);
  } catch (e) { setStatus('синапсы недоступны'); }
}

const contactCache = new Map();
const MAX_CONTACT_DOTS = 80;
async function drawContacts(list) {
  // one bright dot where each hand-made synapse sits (first MAX_CONTACT_DOTS of them)
  const shown = list.slice(0, MAX_CONTACT_DOTS);
  const missing = shown.map(([a, b]) => `${a}-${b}`).filter((k) => !contactCache.has(k));
  if (missing.length) {
    try {
      const got = await (await fetch(`/api/contacts?pairs=${missing.join(',')}`)).json();
      for (const k in got) contactCache.set(k, got[k]);
    } catch (e) { /* offline: no dots */ }
  }
  const pts = [];
  for (const [a, b, w] of shown) { const p = contactCache.get(`${a}-${b}`); if (p) pts.push([p, w]); }
  if (contactPoints) { scene.remove(contactPoints); contactPoints.geometry.dispose(); contactPoints = null; }
  if (!pts.length) return;
  const xyz = new Float32Array(pts.length * 3), col = new Float32Array(pts.length * 3);
  pts.forEach(([p, w], k) => { xyz.set(p, 3 * k); col.set(w > 0 ? [1.0, 0.85, 0.3] : [1.0, 0.4, 0.7], 3 * k); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  contactPoints = new THREE.Points(g, new THREE.PointsMaterial({ size: 9, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(contactPoints);
}

async function showSkeleton(i) {
  setStatus('загружаю форму нейрона…');
  try {
    const buf = await (await fetch(`/api/skeleton/${i}`)).arrayBuffer();
    const m = new Uint32Array(buf, 0, 1)[0];
    const segs = new Float32Array(buf, 4, m * 6);
    const col = new Float32Array(m * 6).fill(0.9);
    setLines(skeletonLines, segs, col);
    setStatus('');
  } catch (e) { setStatus('форма недоступна (нет сети или архива)'); }
}

// --------------------------------------------------------- websocket
function send(obj) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); }
function stimOf(i) { return state.stimMap && state.stimMap.get(i); }

function connect() {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { onFrame(ev.data); return; }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'status') onStatus(msg);
    else if (msg.type === 'channels') { arena.setRates(msg.rates); if (state.status) { state.status.channels = msg.rates; renderTranslation(); } }
    else if (msg.type === 'info') onInfo(msg);
    else if (msg.type === 'error') setStatus('ошибка: ' + msg.message);
  };
  ws.onclose = () => { setStatus('нет связи с симуляцией, переподключаюсь…'); setTimeout(connect, 1500); };
  ws.onopen = () => setStatus('');
  state.ws = ws;
}

function onFrame(buf) {
  const head = new DataView(buf);
  const n = head.getUint32(8, true);
  const idx = new Uint32Array(buf, 12, n);
  const act = state.act;
  if (!act) return;
  for (let k = 0; k < n; k++) { const i = idx[k]; act[i] = Math.min(1.5, act[i] + 0.7); }
  state.lastFrameWall = performance.now();
  state.tModel = head.getFloat32(0, true);
}

function onStatus(s) {
  state.status = s;
  state.stimMap = new Map(s.stim);
  state.silSet = new Set(s.silenced);
  const flag = state.flag;
  if (flag) {
    flag.fill(0);
    for (const [i] of s.stim) flag[i] = 1;
    for (const i of s.silenced) flag[i] = 2;
    points.geometry.attributes.flag.needsUpdate = true;
  }
  drawExtra(s.extra); drawContacts(s.extra);
  if (s.traces) {
    const tr = s.traces;
    $('#day-actions').textContent = tr.actions; $('#day-traced').textContent = tr.traced_neurons;
    const verb = { activate: 'возбудил', silence: 'выключил', unsilence: 'включил', connect: 'связал', disconnect: 'разорвал', clear: 'снял всё' };
    $('#feed').innerHTML = tr.recent.slice(-4).map((e) => {
      const t = new Date(e.t * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      const what = e.action === 'connect' ? e.label : (e.label ? `${e.label}${e.n > 1 ? ' × ' + e.n : ''}` : '');
      return `<div>${t} · ${verb[e.action] || e.action} ${what}</div>`;
    }).join('');
  }
  renderTranslation();
  $('#n-stim').textContent = s.n_stim; $('#n-sil').textContent = s.n_silenced; $('#n-extra').textContent = s.n_extra;
  $('#rate').textContent = Math.round(s.spikes_per_s); $('#active').textContent = s.active;
  $('#speed').textContent = s.paused ? 'пауза' : `${s.realtime.toFixed(2)}× реального (счёт ${(s.compute || 0).toFixed(2)}×${s.engine && s.engine.startsWith('NumPy') ? ', без numba!' : ''})` + (s.speed < 0.999 ? ` (задано 1/${Math.round(1 / s.speed)})` : '') + (s.awake >= 0 ? ` · не спят ${s.awake}` : '');
  $('#pause').textContent = s.paused ? 'Пуск' : 'Пауза';
  if (s.attract) setStatus(`демонстрация: ${s.attract.toLowerCase()} · коснитесь экрана, чтобы управлять самим`);
  else if ($('#status').textContent.startsWith('демонстрация')) setStatus('');
  $('#pause').classList.toggle('on', !!s.paused);
  for (const b of document.querySelectorAll('#presets button')) {
    const p = state.meta.presets[+b.dataset.k];
    b.classList.toggle('stim', p.rate > 0 && p.idx.some((i) => state.stimMap.has(i)));
    b.classList.toggle('sel', p.rate === 0 && state.selected !== null && p.idx.includes(state.selected));
  }
}

function onInfo(info) {
  state.info = info;
  $('#info').style.display = 'block';
  $('#info-label').textContent = info.cell_type || 'без типа';
  $('#info-id').textContent = `FlyWire ${info.id} · #${info.idx}`;
  const st = [];
  st.push(['класс', CLASS_RU[info.super_class] || info.super_class || '—']);
  st.push(['подкласс', info.cell_class || '—']);
  st.push(['сторона', info.side === 'left' ? 'левая' : info.side === 'right' ? 'правая' : info.side || '—']);
  st.push(['медиатор', info.nt || '—']);
  st.push(['входов', `${info.n_in} нейронов · ${info.syn_in} синапсов`]);
  st.push(['выходов', `${info.n_out} нейронов · ${info.syn_out} синапсов`]);
  st.push(['состояние', info.silenced ? 'выключен' : info.stim > 0 ? `возбуждён ${info.stim} Гц` : 'обычное']);
  if (info.gain && Math.abs(info.gain - 1) > 0.001) st.push(['след дня', `выходы × ${info.gain.toFixed(3)}`]);
  $('#info-stats').innerHTML = st.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}

// ------------------------------------------------------------ the fly
const arena = new FlyArena(document.querySelector('#fly'));

// ---------------------------------------------- stage: fly or meme video
const FLY_WORDS = { sugar: 'пробует лапкой', mn9: 'вытягивает хоботок', p9: 'идёт вперёд', mdn: 'пятится', dna02_l: 'поворачивает влево', dna02_r: 'поворачивает вправо', gf: 'прыгает' };
const stage = { clip: null };
function videoFor(name, key) {
  const v = tr.vocab && tr.vocab.videos && tr.vocab.videos[name];
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v[key] || v.idle || null;
}
function setStage() {
  const meme = tr.vocabName !== FLY_TAB;
  $('#fly').style.display = meme ? 'none' : 'block';
  $('#meme-video').style.display = meme ? 'block' : 'none';
  $('#meme-caption').style.display = meme ? 'block' : 'none';
  $('#arena-title').textContent = meme ? tr.vocabName : 'Муха';
  $('#arena-action').textContent = meme ? 'так это выглядит в ролике' : arena.action;
  $('#arena-note').textContent = meme
    ? 'Ролик из интернета. Подпись берётся из словаря мема: это всё, что связывает видео с мозгом.'
    : 'Телом управляют только каналы мозга: DNp09 вперёд, MDN назад, DNa02 повороты, MN9 хоботок, DNp01 прыжок. В экскурсии видно, как одна новая связь меняет походку.';
  if (!meme) { const v = $('#meme-video'); v.pause(); v.removeAttribute('src'); v.load(); stage.clip = null; $('#meme-missing').style.display = 'none'; }
}
function updateStage(best, action) {
  if (tr.vocabName === FLY_TAB) return;
  $('#meme-caption').textContent = action;
  const file = videoFor(tr.vocabName, best);
  const v = $('#meme-video');
  if (!file) { v.style.display = 'none'; $('#meme-missing').style.display = 'flex'; $('#meme-missing').textContent = `нет видео для «${tr.vocabName}»: укажите файл в web/vocab.json`; return; }
  if (stage.clip !== file) {
    stage.clip = file;
    v.style.display = 'block'; $('#meme-missing').style.display = 'none';
    v.src = `/memes/${encodeURIComponent(file)}`;
    v.onerror = () => { v.style.display = 'none'; $('#meme-missing').style.display = 'flex'; $('#meme-missing').textContent = `положите файл web/memes/${file}`; };
    v.play().catch(() => {});
  }
}

// ----------------------------------------------------------------- tour
const camGoal = { active: false, target: new THREE.Vector3(), pos: new THREE.Vector3() };
function focusOn(idx, distance = 420) {
  if (idx === null || idx === undefined) { camGoal.active = false; return; }
  const p = new THREE.Vector3(state.pos[3 * idx], state.pos[3 * idx + 1], state.pos[3 * idx + 2]);
  camGoal.target.copy(p);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  camGoal.pos.copy(p).addScaledVector(dir, distance);
  camGoal.active = true;
}
function presetIdx(key) {
  const p = state.meta.presets.find((q) => q.key === key);
  if (p) return p.idx;
  const c = state.meta.channels && state.meta.channels.find((q) => q.key === key);   // e.g. mn9
  return c && c.idx ? c.idx : [];
}
let TOUR = [];
async function loadTour() {
  try {
    const j = await (await fetch('/tour.json')).json();
    TOUR = j.parts.flatMap((p) => p.steps.map((st) => ({ ...st, part: p.name })));
  } catch (e) { TOUR = []; }
}
const tour = {
  i: -1,
  scenario(key, on) {
    const p = state.meta.presets.find((q) => q.key === key); if (!p) return;
    send({ cmd: on ? 'activate' : 'deactivate', idx: p.idx, rate: p.rate, hold: 0 });
  },
  connect(fromKey, toKey) {
    const a = presetIdx(fromKey), b = presetIdx(toKey); if (!a.length || !b.length) return;
    send({ cmd: 'connect', pre: a[0], post: b[0], pres: a, posts: b, n: 30, sign: 1 });
  },
  async run(ops) {
    for (const op of ops || []) {
      const [name, x, y] = op;
      if (name === 'scenario') this.scenario(x, y);
      else if (name === 'connect') this.connect(x, y);
      else if (name === 'disconnect') send({ cmd: 'disconnect' });
      else if (name === 'wait') await new Promise((r) => setTimeout(r, x));
      else if (name === 'info') {
        if (!state.info) continue;
        if (x === 'lines') showSynapses(state.info);
        else if (x === 'skeleton') showSkeleton(state.info.idx);
        else if (x === 'points') showSynapsePoints(state.info.idx);
      } else if (name === 'overlays') {
        setLines(synLines, new Float32Array(0), new Float32Array(0));
        setLines(skeletonLines, new Float32Array(0), new Float32Array(0));
        setSynPoints(new Float32Array(0), new Float32Array(0));
      } else if (name === 'memes') { if (!x) setMemes(false); }
      else if (name === 'vocab') { setVocab(x); }
    }
  },
  async start() {
    if (!TOUR.length) await loadTour();
    if (!TOUR.length) { setStatus('экскурсия не загрузилась'); return; }
    controls.autoRotate = false;
    send({ cmd: 'clear' });
    $('#tour').style.display = 'block'; $('#tour-start').classList.add('on'); document.body.classList.add('touring');
    this.i = -1; this.next();
  },
  stop() {
    this.i = -1; $('#tour').style.display = 'none'; $('#tour-start').classList.remove('on'); document.body.classList.remove('touring');
    send({ cmd: 'clear' }); camGoal.active = false;
    this.run([['overlays', 'clear'], ['vocab', 'Муха'], ['memes', false]]);
    selectMarker.visible = false;
  },
  async next() {
    this.i += 1;
    if (this.i >= TOUR.length) { this.stop(); return; }
    const st = TOUR[this.i];
    setStatus('');
    await this.run(st.before);
    $('#tour-title').textContent = st.title; $('#tour-step').textContent = `${st.part} · ${this.i + 1} / ${TOUR.length}`;
    $('#tour-text').textContent = st.text; $('#tour-after').textContent = '';
    const act = $('#tour-action');
    act.style.display = st.action ? '' : 'none';
    if (st.action) { act.textContent = st.action; act.disabled = false; }
    $('#tour-next').textContent = st.last ? 'Закончить' : (st.next || 'Дальше');
    $('#tour-next').style.display = st.action ? 'none' : '';
    const fi = st.focus ? presetIdx(st.focus)[0] : null;
    if (fi !== null && fi !== undefined) {
      focusOn(fi);
      if (!state.info || state.info.idx !== fi) { setLines(synLines, new Float32Array(0), new Float32Array(0)); select(fi); }
    } else if (!st.keepFocus) { camGoal.active = false; }
    if (st.lines) { const li = presetIdx(st.lines)[0]; if (li !== undefined) setTimeout(() => { if (state.info && state.info.idx === li) showSynapses(state.info); }, 700); }
  },
  async act() {
    const st = TOUR[this.i]; if (!st || !st.action) return;
    $('#tour-action').disabled = true;
    await this.run(st.ops);
    setTimeout(() => { $('#tour-after').textContent = st.after || ''; $('#tour-next').style.display = ''; }, st.wait || 2500);
  },
};
$('#tour-start').onclick = () => { if (tour.i >= 0) { tour.stop(); return; } setMemes(false); tour.start(); };
$('#tour-close').onclick = () => tour.stop();
$('#tour-next').onclick = () => tour.next();
$('#tour-action').onclick = () => tour.act();

function setMemes(open) {
  $('#memes').style.display = open ? 'block' : 'none';
  $('#memes-toggle').classList.toggle('on', open);
  if (!open) { if (tr.vocabName !== FLY_TAB) setVocab(FLY_TAB); }
  else if (tr.vocabName === FLY_TAB && tr.vocab) setVocab(Object.keys(tr.vocab.idle)[0]);
}
$('#memes-toggle').onclick = () => { const open = $('#memes').style.display === 'none'; if (open && tour.i >= 0) tour.stop(); setMemes(open); };

// ------------------------------------------------------- translation
const tr = { open: false, vocab: null, vocabName: 'Муха' };
const FLY_TAB = 'Муха';
function setVocab(name) {
  tr.vocabName = name;
  for (const o of document.querySelectorAll('#tr-vocab button')) o.classList.toggle('on', o.dataset.v === name);
  setStage(); renderTranslation();
}
async function loadVocab() {
  try { tr.vocab = await (await fetch('/vocab.json')).json(); } catch (e) { tr.vocab = null; }
  if (!tr.vocab) return;
  const names = Object.keys(tr.vocab.idle);   // meme tabs only; the fly is shown when the menu is closed
  $('#tr-vocab').innerHTML = names.map((n) => `<button data-v="${n}" class="${n === tr.vocabName ? 'on' : ''}">${n}</button>`).join('');
  for (const b of document.querySelectorAll('#tr-vocab button')) b.onclick = () => setVocab(b.dataset.v);
}
function renderTranslation() {
  if (!tr.open || !state.status || !state.meta || !tr.vocab) return;
  const rates = state.status.channels || {};
  // the video author's rule: the output channel with the highest normalised rate wins
  let best = null, bestF = 0.15;
  for (const c of state.meta.channels) {
    if (c.role !== 'выход') continue;
    const f = (rates[c.key] || 0) / c.ref;
    if (f > bestF) { best = c.key; bestF = f; }
  }
  const name = tr.vocabName;
  if (name === FLY_TAB) return;
  const w = tr.vocab.words;
  const action = best ? (w[best] && w[best][name]) || best : tr.vocab.idle[name];
  updateStage(best, action);
}

// ----------------------------------------------------------------- UI
function setStatus(t) { $('#status').textContent = t; }
tr.open = true;
loadVocab().then(renderTranslation);
// slider 0..100 -> slow-down factor 1..50 (log scale); the server paces to 1/factor of real time
const slowFactor = (v) => Math.round(Math.pow(50, v / 100) * 10) / 10;
$('#speed-slider').oninput = (e) => { const f = slowFactor(+e.target.value); $('#speed-out').textContent = f <= 1 ? '1×' : `1/${f}`; };
$('#speed-slider').onchange = (e) => { const f = slowFactor(+e.target.value); send({ cmd: 'speed', value: 1 / f }); };
$('#pause').onclick = () => send({ cmd: state.status && state.status.paused ? 'play' : 'pause' });
$('#clear').onclick = () => {
  if (tour.i >= 0) tour.stop();
  send({ cmd: 'clear' });
  setLines(synLines, new Float32Array(0), new Float32Array(0));
  setLines(skeletonLines, new Float32Array(0), new Float32Array(0));
  setSynPoints(new Float32Array(0), new Float32Array(0));
  setMemes(false);
  $('#info').style.display = 'none'; selectMarker.visible = false; state.selected = null;
  frameCamera(); controls.autoRotate = true;
};
$('#info-close').onclick = () => { $('#info').style.display = 'none'; selectMarker.visible = false; };
$('#info-synapses').onclick = () => showSynapses(state.info);
$('#info-skeleton').onclick = () => showSkeleton(state.info.idx);
$('#info-points').onclick = () => showSynapsePoints(state.info.idx);
$('#new-day').onclick = () => { if (confirm('Забыть весь день: следы, лезии и связи всех посетителей?')) { send({ cmd: 'new_day' }); contactCache.clear(); } };

function buildPresets() {
  const box = $('#presets');
  state.meta.presets.forEach((p, k) => {
    const b = document.createElement('button');
    b.textContent = p.label; b.title = p.hint; b.dataset.k = k;
    b.onclick = () => {
      if (p.rate > 0) {
        const on = b.classList.contains('stim');
        send({ cmd: on ? 'deactivate' : 'activate', idx: p.idx, rate: p.rate });
        b.classList.toggle('stim', !on);   // immediate feedback; the next status confirms
      }
      select(p.idx[0]);
    };
    box.appendChild(b);
  });
  const lg = $('#legend');
  lg.innerHTML = state.meta.super_classes.filter((c) => c).map((c) => `<span><i style="background:${CLASS_COLORS[c] || '#777'}"></i>${CLASS_RU[c] || c}</span>`).join('');
}

// ---------------------------------------------------------------- main
async function main() {
  setStatus('загружаю нейроны…');
  state.meta = await (await fetch('/api/meta.json')).json();
  const buf = await (await fetch('/api/neurons.bin')).arrayBuffer();
  state.n = state.meta.n;
  state.pos = new Float32Array(buf, 0, state.n * 3);
  state.cls = new Uint8Array(buf, state.n * 12, state.n);
  $('#n-neurons').textContent = state.n.toLocaleString('ru');
  $('#n-syn').textContent = state.meta.n_synapses.toLocaleString('ru');
  buildPoints(); frameCamera(); buildPresets();
  loadMesh('volume', { color: 0x8fa3c7, opacity: 0.035, wire: 0.05 });
  connect();
  setStatus('');
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    const decay = Math.pow(0.03, dt / 0.9);
    const act = state.act;
    for (let i = 0; i < act.length; i++) if (act[i] > 0.002) act[i] *= decay; else act[i] = 0;
    points.geometry.attributes.act.needsUpdate = true;
    if (state.tModel !== undefined) $('#t').textContent = `${(state.tModel / 1000).toFixed(2)} с`;
    if (!controls.autoRotate && now - idleSince > 45000 && tour.i < 0) controls.autoRotate = true;
    if (camGoal.active) {
      controls.target.lerp(camGoal.target, 0.06); camera.position.lerp(camGoal.pos, 0.06);
      if (camera.position.distanceTo(camGoal.pos) < 1) camGoal.active = false;
    }
    pointMat.uniforms.uScale.value = innerHeight / 2;
    if (tr.vocabName === FLY_TAB) { arena.step(Math.min(dt, 0.1)); $('#arena-action').textContent = arena.action; }
    controls.update();
    renderer.render(scene, camera);
  });
}
main().catch((e) => setStatus('ошибка: ' + e.message));
