// Cancha Abierta TV · el WIDGET: un solo enlace en PRISM que hace de realizador automático.
//
//   directo.html?club=…&b=…&partido=…            → el partido EN DIRECTO
//   directo.html?…&simular=1                     → un partido TERMINADO, reproducido a su hora real
//                                                  sobre un parqué, con controles (velocidad, saltos)
// Otros: nombre/color (nuestro equipo), rnombre/rcolor (rival), limpio=1 (simulación sin controles ni parqué).
//
// Qué se enseña en cada momento lo decide simulacion.mjs (sceneAt) con el MISMO guion en directo
// y en simulación; aquí solo se lleva el reloj y se pinta.
import { api } from './cliente.mjs';
import { buildSim, leaders, sceneAt, snapshotAt } from './simulacion.mjs';
import { defaultShortName } from './marcador.mjs';
import * as V from './vistas.mjs';
import { anonimizar } from './ficticio.mjs';

const q = new URLSearchParams(location.search);
// DEMO: un partido guardado en local (demo/<nombre>.json, scripts/demo.mjs), sin FAB; siempre simulado.
// Se publican SOLO las ficticias (ficticio, ficticio-cantera: portada y ensayos); n1/cantera, solo en local.
const DEMO = /^[a-z0-9-]+$/.test(q.get('demo') ?? '') ? q.get('demo') : null;
const SIM = q.get('simular') === '1' || Boolean(DEMO);
const LINK = Object.fromEntries(['club', 'b', 'equipo', 'partido'].map((k) => [k, q.get(k) ?? '']));
const POLL_MS = 5000;
const TICKER_SECONDS = 5;
const hex = (v) => (/^[0-9a-f]{3,8}$/i.test(v ?? '') ? `#${v}` : null);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// «2º CUARTO» / «PRÓRROGA»
const cuarto = (p) => (p > (sim?.totalPeriods || 4) ? 'PRÓRROGA' : `${p}º CUARTO`);

// Texto legible sobre el color del equipo (un equipo de blanco: dorsal en negro).
function inkFor(color) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(color ?? ''));
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111318' : '#fff';
}

// «23:14» o «1:31:45»
function videoTime(s) {
  const x = Math.max(0, Math.floor(s));
  const h = Math.floor(x / 3600);
  const mm = String(Math.floor((x % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(x % 60).padStart(2, '0')}`;
}

let data = null;
let sim = null;
let lastOk = 0;              // última respuesta buena de la FAB (en directo)
const RECONNECT_MS = 20_000; // sin respuesta tanto tiempo → «RECONECTANDO»

// ── Reloj ───────────────────────────────────────────────────────────────────
// En DIRECTO se cuenta en la hora de la MESA (hora_dia de los eventos): el último evento visto +
// lo que ha pasado desde que lo vimos. Así los 10 s del quinteto o el minuto de cada pantalla del
// descanso corren aunque no lleguen eventos, sin depender de que el reloj de la mesa esté en hora.
let anchor = { t: null, at: 0 };
// En SIMULACIÓN, un reloj propio con velocidad.
const clock = { t: null, speed: 1, playing: true, last: performance.now() };

function now() {
  if (SIM) return clock.t;
  if (anchor.t === null) return null;
  return anchor.t + (Date.now() - anchor.at) / 1000;
}

async function load() {
  const res = DEMO ? await fetch(`demo/${DEMO}.json`) : await api('/api/directo', LINK);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(DEMO ? `No se encuentra el partido de ensayo «${DEMO}».` : payload.error || 'No hay respuesta de los datos del partido.');
  // SIMULAR = partido FICTICIO siempre (Luismi, 13-11): ni equipos, ni jugadoras, ni fotos reales.
  data = SIM ? anonimizar(payload) : payload;
  lastOk = Date.now();
  sim = data.pbp ? buildSim(data.pbp, data.box) : null;
  if (!SIM && sim?.lastT != null && sim.lastT !== anchor.t) anchor = { t: sim.lastT, at: Date.now() };
}

// ── Equipos tal como se pintan ──────────────────────────────────────────────
function teams() {
  const out = {};
  for (const side of ['local', 'visitante']) {
    const base = data?.[side] ?? {};
    const own = side === (data?.equipoLado || 'local');
    out[side] = {
      nombre: base.nombre || '',
      // Sin datos aún no se sabe en qué lado juega cada uno: nombres en blanco, solo el 0-0.
      // En simulación, los nombres del enlace (los reales del club) no se usan: todo es ficticio.
      corto: data ? (!SIM && (own ? q.get('nombre') : q.get('rnombre'))) || defaultShortName(base.nombre) : '',
      color: (own ? hex(q.get('color')) : hex(q.get('rcolor'))) || base.color || '#3b3f47',
      get ink() { return inkFor(this.color); },
      escudo: base.escudo,
      fotos: base.fotos ?? {},
      entrenador: base.entrenador,
    };
  }
  return out;
}

// ── Pintar (solo lo que cambia) ─────────────────────────────────────────────
const painted = { sb: '', screen: '', wait: '' };
let lastScores = null;

function setLayer(id, html, on, extraClass = '') {
  const el = $(id);
  if (html !== null && html !== painted[id]) {
    painted[id] = html;
    el.innerHTML = html;
  }
  el.classList.toggle('is-off', !on);
  if (id === 'screen') el.classList.toggle('with-sb', extraClass === 'with-sb');
}

// Pila de rótulos de un equipo (lista: la más nueva primero). Solo entra lo nuevo (arriba) y sale
// lo caducado (se desvanece): lo que sigue visible no se repinta ni salta.
function paintStack(el, lista, T) {
  const keys = new Set(lista.map((a) => a.id));
  for (const n of [...el.children]) {
    if (!keys.has(n.dataset.k) && !n.classList.contains('is-off')) {
      n.classList.add('is-off');
      setTimeout(() => n.remove(), 450);
    }
  }
  for (const a of [...lista].reverse()) {
    if ([...el.children].some((n) => n.dataset.k === a.id && !n.classList.contains('is-off'))) continue;
    const n = document.createElement('div');
    n.className = 'tk';
    n.dataset.k = a.id;
    n.innerHTML = V.tickerHtml({ accion: a, teams: T, compacto: true });
    el.prepend(n);
  }
}

function bumpScores(m) {
  const scores = m ? `${m.local.puntos}-${m.visitante.puntos}` : null;
  if (lastScores && scores && scores !== lastScores) {
    const [a, b] = lastScores.split('-');
    for (const [side, prev] of [['local', a], ['visitante', b]]) {
      if (String(m[side].puntos) !== prev) {
        const el = document.querySelector(`[data-score="${side}"]`);
        el?.classList.remove('is-bump'); void el?.offsetWidth; el?.classList.add('is-bump');
      }
    }
  }
  lastScores = scores;
}

function render() {
  // Sin datos todavía (en directo): marcador 0-0 con lo que traiga el enlace y el cartel.
  if (!data && SIM) return;
  const T = teams();
  // En directo, sin acta de la FAB (o sin respuesta hace rato): cartel encima del marcador.
  const sinActa = !data?.pbp;
  const caida = Boolean(data) && Date.now() - lastOk > RECONNECT_MS;
  const espera = !SIM && (sinActa || caida);
  setLayer('wait', `<span class="live-dot"></span>${sinActa ? 'ESPERANDO CONEXIÓN' : 'RECONECTANDO…'}`, espera);
  const t = now();
  let scene;
  let snap = null;
  if (!sim) scene = { escena: 'previa', marcador: true };
  else {
    const tt = t ?? sim.t0 ?? 0;
    scene = sceneAt(sim, tt);
    snap = snapshotAt(sim, tt);
    // Sin plantillas publicadas todavía: la previa del marcador.
    if (scene.escena === 'plantillas' && !sim.roster.local.length && !sim.roster.visitante.length) scene = { escena: 'previa', marcador: true };
  }

  // Marcador
  const m = snap?.marcador ?? null;
  setLayer('sb', V.marcadorHtml({ teams: T, m, previaHora: data?.partido?.hora }), Boolean(scene.marcador));
  bumpScores(m);

  // Última acción DE CADA EQUIPO, encima de su mitad del marcador: hasta dos a la vez (Luismi,
  // 09-11). Solo con el marcador «limpio» y como mucho TICKER_SECONDS (07-11: 5 s).
  // Hasta 2 por equipo, la nueva encima: una asistencia no tapa la canasta (09-11).
  for (const [id, side] of [['tkL', 'local'], ['tkR', 'visitante']]) {
    const vis = scene.escena === 'marcador' && t !== null
      ? (snap?.acciones?.[side] ?? []).filter((a) => t - a.t < TICKER_SECONDS && a.tipo !== 'FINAL-PARTIDO')
      : [];
    paintStack($(id), vis, T);
    // Mientras se ve una CANASTA, el tanteo del equipo que ha anotado se queda resaltado.
    document.querySelector(`[data-score="${side}"]`)?.classList.toggle('is-hot', vis.some((a) => /^CANASTA-/.test(a.tipo)));
  }

  // Pantallas
  let html = '';
  const momento = scene.datos === 'final' ? 'FINAL' : 'DESCANSO';
  switch (scene.escena) {
    case 'plantillas': html = V.plantillasHtml({ teams: T, roster: sim.roster, categoria: data.partido?.categoria }); break;
    case 'quinteto':
      html = V.enPistaHtml({ teams: T, enPista: snap.enPista, detalle: sim.detalle, stats: scene.periodo > 1, titulo: `EN PISTA <span>·</span> ${cuarto(scene.periodo)}` });
      break;
    case 'tiempo-muerto':
      html = V.enPistaHtml({ teams: T, enPista: snap.enPista, detalle: sim.detalle, titulo: `TIEMPO MUERTO${scene.side ? ` <span>·</span> ${esc(T[scene.side].corto)}` : ''}` });
      break;
    case 'entre-cuartos':
      html = V.enPistaHtml({ teams: T, enPista: snap.enPista, detalle: sim.detalle, titulo: `EN PISTA <span>·</span> FINAL ${cuarto(scene.periodo)}` });
      break;
    case 'estadisticas': html = V.estadisticasHtml({ teams: T, jugadoras: snap.jugadoras, detalle: sim.detalle, momento }); break;
    case 'comparativa': html = V.comparativaHtml({ teams: T, team: snap.team, detalle: sim.detalle, momento, score: snap.score }); break;
    case 'lideres': html = V.lideresHtml({ teams: T, lideres: { local: leaders(snap.jugadoras.local), visitante: leaders(snap.jugadoras.visitante) }, momento }); break;
    default: break;
  }
  // El marcador no se quita nunca: toda pantalla va ENCIMA de él (Luismi, 09-11).
  setLayer('screen', html || null, Boolean(html), 'with-sb');

  if (SIM) {
    // Minuto del VÍDEO (no la hora de la mesa): cuánto llevamos de simulación y cuánto dura.
    $('simClock').textContent = t === null ? '' : `${videoTime(t - sim.t0)} / ${videoTime(sim.tFin - sim.t0)}`;
    if (document.activeElement !== $('simRange')) $('simRange').value = String(Math.round(t ?? 0));
  }
}

// ── Simulación: controles ───────────────────────────────────────────────────
function setupSim() {
  // limpio=1: sin parqué ni controles, transparente como el directo (ensayo sobre la cámara).
  document.body.classList.toggle('is-sim', q.get('limpio') !== '1');
  if (!sim || sim.end === null || sim.start === null) {
    $('msg').textContent = 'Este partido no ha terminado (o no tiene acta): no se puede simular.';
    $('msg').hidden = false;
    return;
  }
  clock.t = sim.t0;
  // Para pruebas automáticas (capturas): saltar a un instante y leer los tiempos del partido.
  window.fabScore = {
    tiempos: () => ({ t0: sim.t0, start: sim.start, end: sim.end, halfEnd: sim.halfEnd, secondHalf: sim.secondHalf, timeouts: sim.timeouts, breaks: sim.breaks, quarterStarts: sim.quarterStarts, tFin: sim.tFin, detalle: sim.detalle, cambios: sim.events.filter((e) => e.tipo === 'CAMBIO-JUGADOR-SALE').slice(0, 2).map((e) => e.t), canastas: sim.events.filter((e) => /^CANASTA-/.test(e.tipo)).slice(0, 3).map((e) => e.t) }),
    ir: (t) => { clock.t = t; clock.playing = false; render(); },
  };
  const bar = $('simBar');
  bar.hidden = q.get('limpio') === '1';
  const range = $('simRange');
  range.min = String(sim.t0);
  range.max = String(sim.tFin);
  range.addEventListener('input', () => { clock.t = Number(range.value); render(); });
  const play = $('simPlay');
  const syncPlay = () => { play.textContent = clock.playing ? '❚❚' : '▶'; play.setAttribute('aria-label', clock.playing ? 'Pausa' : 'Reproducir'); };
  play.addEventListener('click', () => { if (clock.t >= sim.tFin) clock.t = sim.t0; clock.playing = !clock.playing; syncPlay(); });
  syncPlay();
  bar.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    clock.speed = Number(b.dataset.speed);
    bar.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  const firstTimeout = sim.timeouts[0]?.t;
  const q3 = sim.secondHalf;
  const jumps = { inicio: sim.t0, salto: sim.start - 5, tm: firstTimeout ? firstTimeout - 5 : null, descanso: sim.halfEnd ? sim.halfEnd - 5 : null, tercero: q3 ? q3 - 5 : null, final: sim.end - 5 };
  bar.querySelectorAll('[data-jump]').forEach((b) => {
    const to = jumps[b.dataset.jump];
    if (to == null) { b.hidden = true; return; }
    b.addEventListener('click', () => { clock.t = to; render(); });
  });
  // Mando a distancia para la app (Cancha Abierta TV): con limpio=1 la barra no se ve (saldría en
  // el vídeo), y la app pone sus propios botones fuera de la imagen y llama aquí (10-11).
  // Capítulos (como los de YouTube): previa, cada cuarto, descanso y final. 2 s antes de cada uno
  // para que se vea el cambio.
  const nombreCuarto = (p) => (p > 4 ? `Prórroga${p > 5 ? ` ${p - 4}` : ''}` : `${p}.º cuarto`);
  const capitulos = [{ nombre: 'Previa', t: sim.t0 }];
  for (const qs of sim.quarterStarts) capitulos.push({ nombre: nombreCuarto(qs.periodo), t: Math.max(sim.t0, qs.t - 2) });
  if (sim.halfEnd) capitulos.push({ nombre: 'Descanso', t: sim.halfEnd });
  // Cada tiempo muerto, un capítulo (Luismi, 10-11).
  for (const tm of sim.timeouts) capitulos.push({ nombre: 'Tiempo muerto', t: Math.max(sim.t0, tm.t - 2) });
  capitulos.push({ nombre: 'Final', t: sim.end });
  capitulos.sort((a, b) => a.t - b.t);
  const capituloEn = (t) => capitulos.reduce((i, c, k) => (c.t <= t + 0.5 ? k : i), 0);
  const ir = (t) => { clock.t = Math.max(sim.t0, Math.min(sim.tFin, t)); render(); };
  const estado = () => ({
    playing: clock.playing, speed: clock.speed, t: clock.t, t0: sim.t0, tFin: sim.tFin,
    reloj: $('simClock').textContent, saltos: Object.keys(jumps).filter((k) => jumps[k] != null),
    capitulos, capitulo: capituloEn(clock.t),
  });
  window.fabScore.control = (accion, valor) => {
    if (accion === 'play') play.click();
    if (accion === 'speed') bar.querySelector(`[data-speed="${Number(valor)}"]`)?.click();   // ×1, ×2, ×5
    if (accion === 'jump' && jumps[valor] != null) ir(jumps[valor]);
    if (accion === 'seek') ir(clock.t + Number(valor));
    if (accion === 'ir') ir(Number(valor));
    if (accion === 'anterior') {
      // Como YouTube: al principio del capítulo actual; si ya se está ahí (3 s), al anterior.
      const i = capituloEn(clock.t);
      ir(capitulos[clock.t - capitulos[i].t > 3 ? i : Math.max(0, i - 1)].t);
    }
    if (accion === 'siguiente') {
      const i = capituloEn(clock.t);
      if (i + 1 < capitulos.length) ir(capitulos[i + 1].t);
    }
    return estado();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); play.click(); }
    if (e.key === 'h' || e.key === 'H') bar.hidden = !bar.hidden;
    // Flechas: ±10 s del vídeo (con Mayúsculas, ±1 min).
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = (e.shiftKey ? 60 : 10) * (e.key === 'ArrowRight' ? 1 : -1);
      clock.t = Math.max(sim.t0, Math.min(sim.tFin, clock.t + step));
      render();
    }
  });
  const frame = (ts) => {
    const dt = (ts - clock.last) / 1000;
    clock.last = ts;
    if (clock.playing) {
      clock.t = Math.min(sim.tFin, clock.t + dt * clock.speed);
      if (clock.t >= sim.tFin) { clock.playing = false; syncPlay(); }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ── Arranque ────────────────────────────────────────────────────────────────
async function start() {
  // Enlace sin partido (el antiguo «para toda la temporada»): ya no vale, y se dice (13-11).
  if (!DEMO && !LINK.partido) {
    $('msg').textContent = 'Este enlace ya no vale: busca el partido de hoy en Cancha Abierta TV.';
    $('msg').hidden = false;
    return;
  }
  try {
    await load();
  } catch (err) {
    $('msg').textContent = err.message;
    $('msg').hidden = !SIM;  // en directo no se enseña el error: marcador 0-0 + «ESPERANDO CONEXIÓN»
    if (!SIM) { render(); setTimeout(start, POLL_MS); }
    return;
  }
  if (SIM) setupSim();
  else {
    setInterval(() => { load().catch(() => {}); }, POLL_MS);
  }
  render();
  setInterval(render, 250);
}
start();
