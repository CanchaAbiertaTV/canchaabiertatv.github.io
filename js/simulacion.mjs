// SIMULACIÓN y «realización»: a partir del play by play de un partido, qué hay en pantalla en
// cada instante. Parte PURA (sin red ni DOM), con tests.
//
// El tiempo es el `hora_dia` de cada evento (hora real de la mesa): de INICIO-PARTIDO a
// FINAL-PARTIDO es la duración exacta del partido. Guion (Luismi, 07-11-26):
//   · 30 s antes del salto: plantillas.
//   · Partido: marcador + la última acción («Canasta de 2 de …»), con cuarto y tiempo por jugar.
//   · Al empezar cada cuarto: 10 s las jugadoras en pista.
//   · Tiempo muerto: 30 s las 10 en pista con puntos, rebotes y faltas (09-11).
//   · Entre cuartos (1º-2º, 3º-4º): 1 min las 10 en pista con sus números (09-11).
//   · El MARCADOR no se quita nunca: las pantallas van encima de él (09-11).
//   · Descanso: 1 min estadísticas de las plantillas, 1 min comparativa, 1 min líderes (solo si la
//     liga apunta fallos y rebotes), en bucle; a los 6 min, o si empieza el 3er cuarto, marcador.
//   · Final: 30 s marcador, luego 1 min cada pantalla del descanso (con el partido entero) y fin.
import { normalizeKey, scoreboardFromPbp, splitName } from './marcador.mjs';

const text = (v) => String(v ?? '').trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const typeOf = (r) => text(r?.accion_tipo).toUpperCase();

export const PRE_SECONDS = 30;  // previa (plantillas) antes del salto inicial (Luismi, 09-11)
export const QUINTETO_SECONDS = 10;
export const TIMEOUT_SECONDS = 30;
export const BREAK_SECONDS = 60;
export const HALF_MARCADOR_AT = 6 * 60;
export const SCREEN_SECONDS = 60;
export const POST_WAIT_SECONDS = 30;

function secondsOfDay(hhmmss) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(text(hhmmss));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function remainingText(value) {
  const parts = text(value).split(':').map((p) => Number(p.replace(',', '.')));
  if (parts.some((p) => !Number.isFinite(p)) || parts.length < 2) return '';
  const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}

function scoreFrom(r) {
  try {
    const info = JSON.parse(text(r?.informacion_adicional) || 'null');
    if (info && Number.isFinite(Number(info.tanteoLocal)) && Number.isFinite(Number(info.tanteoVisitante))) {
      return { local: Number(info.tanteoLocal), visitante: Number(info.tanteoVisitante) };
    }
  } catch { /* no es JSON */ }
  return null;
}

const ordinal = (p, total = 4) => (p > total ? `prórroga${p - total > 1 ? ` ${p - total}` : ''}` : `${p}º cuarto`);

/**
 * Prepara la simulación. `box` aporta los nombres (por equipo + dorsal); sin él, «la nº 7».
 * Devuelve tiempos en SEGUNDOS desde las 00:00 del día del partido.
 */
export function buildSim(pbp, box = null) {
  const partido = pbp?.partido;
  if (!partido) return null;
  const sides = { [text(partido.idlocal)]: 'local', [text(partido.idvisitante)]: 'visitante' };
  const raw = (Array.isArray(pbp?.envivo?.historialacciones) ? pbp.envivo.historialacciones : [])
    .filter((r) => r && text(r.eliminado) !== 'True')
    .slice()
    .sort((a, b) => (num(a.autoincremental_id) ?? 0) - (num(b.autoincremental_id) ?? 0));

  // Hora de cada evento; si la mesa cruza la medianoche, se suma un día.
  let offset = 0;
  let prev = null;
  const events = [];
  for (const r of raw) {
    let t = secondsOfDay(r.hora_dia);
    if (t === null) continue;
    if (prev !== null && t + offset < prev - 6 * 3600) offset += 86400;
    t += offset;
    prev = t;
    events.push({ ...r, t, side: sides[text(r.equipo_id)] ?? null, tipo: typeOf(r) });
  }
  // Puntos que lleva la jugadora DESPUÉS de cada canasta («… 12 PTS») y faltas después de cada
  // falta («… 3 FAL»), para el rótulo (Luismi, 09-11). Mismas faltas que cuenta snapshotAt.
  const PTS = { 'CANASTA-1P': 1, 'CANASTA-2P': 2, 'CANASTA-3P': 3 };
  const FALTAS = new Set(['FALTA-COMETIDA', 'TANTIDEPORTIVA', 'TDESCALIFICANTE', 'TECNICA']);
  const pts = new Map();
  const fal = new Map();
  for (const e of events) {
    if (!e.side) continue;
    const k = `${e.side}|${text(e.dorsal)}`;
    if (PTS[e.tipo]) { pts.set(k, (pts.get(k) ?? 0) + PTS[e.tipo]); e.ptsTras = pts.get(k); }
    if (FALTAS.has(e.tipo)) { fal.set(k, (fal.get(k) ?? 0) + 1); e.faltasTras = fal.get(k); }
  }

  // En DIRECTO el partido puede no haber empezado (start null) o no haber acabado (end null).
  const start = events.find((e) => e.tipo === 'INICIO-PARTIDO')?.t
    ?? events.find((e) => e.tipo === 'INICIO-PERIODO')?.t ?? null;
  const end = events.find((e) => e.tipo === 'FINAL-PARTIDO')?.t ?? null;

  // Nombres por equipo + dorsal (el acta).
  const players = { local: new Map(), visitante: new Map() };
  const roster = { local: [], visitante: [] };
  for (const lado of ['local', 'visitante']) {
    const rows = box?.estadisticas?.[lado === 'local' ? 'estadisticasequipolocal' : 'estadisticasequipovisitante'];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!text(r?.dorsal) || normalizeKey(r?.nombre) === 'TOTALES') continue;
      const p = {
        dorsal: text(r.dorsal), nombreCompleto: text(r.nombre), ...splitName(r.nombre), capitana: Boolean(r.capitan),
        // Faltas del ACTA: en 26/27 la mesa no publica en el play by play las técnicas ni las
        // antideportivas de jugadora (control 07-11: 3 de 24 jugadoras con una de menos).
        faltasActa: num(r.faltascometidas),
      };
      players[lado].set(p.dorsal, p);
      roster[lado].push(p);
    }
    roster[lado].sort((a, b) => (num(a.dorsal) ?? 999) - (num(b.dorsal) ?? 999));
  }

  // ¿La liga apunta fallos de campo y rebotes? Si no, todas tiran al 100 % y los líderes no dicen
  // nada. OJO: los tiros LIBRES fallados sí se apuntan en todas (cadete del 07-11: 3/6 en libres,
  // 17/17 en tiros de 2 y 0 rebotes), así que no cuentan para decidirlo.
  const detalle = events.some((e) => /^TIRO[23]-FALLADO$/.test(e.tipo) || /^REBOTE-/.test(e.tipo));

  // Tramos de la realización.
  const totalPeriods = num(partido.numperiodos) || 4;
  const half = totalPeriods / 2;
  const halfEnd = events.find((e) => e.tipo === 'FINAL-PERIODO' && num(e.numero_periodo) === half)?.t ?? null;
  const secondHalf = events.find((e) => e.tipo === 'INICIO-PERIODO' && num(e.numero_periodo) === half + 1)?.t
    ?? events.find((e) => num(e.numero_periodo) === half + 1)?.t ?? null;
  // Quinteto en pantalla 10 s al empezar el cuarto, pero NUNCA después de la primera acción de
  // juego (Luismi, 07-11: «no deberíamos tener los quintetos si ya se ha marcado la primera canasta»).
  const quarterStarts = [];
  events.forEach((e, i) => {
    if (e.tipo !== 'INICIO-PERIODO') return;
    const firstPlay = events.slice(i + 1).find((x) => !/^(CAMBIO-|INICIO-|FLECHA-)/.test(x.tipo));
    quarterStarts.push({ t: e.t, periodo: num(e.numero_periodo), hasta: Math.min(e.t + QUINTETO_SECONDS, firstPlay?.t ?? Infinity) });
  });
  const timeouts = [];
  events.forEach((e, i) => {
    if (e.tipo !== 'TIEMPO-MUERTO-SOLICITADO') return;
    // 30 s (Luismi, 09-11), o menos si se vuelve a jugar antes: el primer evento que no es un
    // cambio ni otro tiempo muerto.
    const resume = events.slice(i + 1).find((x) => x.t > e.t && !/^CAMBIO-|^TIEMPO-MUERTO/.test(x.tipo));
    timeouts.push({ t: e.t, hasta: Math.min(resume?.t ?? Infinity, e.t + TIMEOUT_SECONDS), side: e.side });
  });
  // Entre cuartos (no el descanso, que tiene sus pantallas): 1 min las de pista con sus números
  // (Luismi, 09-11), o menos si el cuarto siguiente empieza antes.
  const breaks = [];
  events.forEach((e, i) => {
    const p = num(e.numero_periodo);
    if (e.tipo !== 'FINAL-PERIODO' || p === half) return;
    const next = events.slice(i + 1).find((x) => x.tipo === 'INICIO-PERIODO');
    breaks.push({ t: e.t, periodo: p, hasta: Math.min(e.t + BREAK_SECONDS, next?.t ?? Infinity) });
  });

  const screens = detalle ? ['estadisticas', 'comparativa', 'lideres'] : ['estadisticas', 'comparativa'];
  return {
    partido, events, players, roster, detalle, totalPeriods,
    start, end, halfEnd, secondHalf, quarterStarts, timeouts, breaks, screens,
    t0: start === null ? null : start - PRE_SECONDS,
    tFin: end === null ? null : end + POST_WAIT_SECONDS + screens.length * SCREEN_SECONDS,
    lastT: events.length ? events[events.length - 1].t : null,
  };
}

function nameOf(sim, side, dorsal) {
  const p = side ? sim.players[side].get(text(dorsal)) : null;
  if (p) return [p.nombre, p.apellidos].filter(Boolean).join(' ');
  return text(dorsal) && text(dorsal) !== '-1' ? `la nº ${text(dorsal)}` : '';
}

const ACTIONS = {
  'CANASTA-1P': 'Tiro libre anotado de',
  'CANASTA-2P': 'Canasta de 2 de',
  'CANASTA-3P': 'Triple de',
  'TIRO1-FALLADO': 'Tiro libre fallado de',
  'TIRO2-FALLADO': 'Tiro de 2 fallado de',
  'TIRO3-FALLADO': 'Triple fallado de',
  'REBOTE-DEFENSIVO': 'Rebote defensivo de',
  'REBOTE-OFENSIVO': 'Rebote ofensivo de',
  ASISTENCIA: 'Asistencia de',
  PERDIDA: 'Pérdida de',
  RECUPERACION: 'Recuperación de',
  'TAPON-COMETIDO': 'Tapón de',
  'FALTA-COMETIDA': 'Falta de',
  TANTIDEPORTIVA: 'Antideportiva de',
  TDESCALIFICANTE: 'Descalificante de',
  TECNICA: 'Técnica de',
};

/**
 * Texto de UNA acción, o null si no se enseña (faltas RECIBIDAS, tapones recibidos, marcas de
 * tiros libres, flechas). Los cambios SALE+ENTRA del mismo equipo y momento van juntos.
 */
export function describeEvent(sim, e, siblings = []) {
  const t = e.tipo;
  let texto = null;
  // Quién sale en la foto de la acción (la que la hace; en un cambio, la primera que entra).
  let dorsal = null;
  if (ACTIONS[t]) dorsal = text(e.dorsal);
  if (ACTIONS[t]) texto = `${ACTIONS[t]} ${nameOf(sim, e.side, e.dorsal)}`.trim();
  if (ACTIONS[t] && e.ptsTras) texto += ` (${e.ptsTras} PTS)`;
  if (ACTIONS[t] && e.faltasTras) texto += ` (${e.faltasTras} FAL)`;
  else if (t === 'TIEMPO-MUERTO-SOLICITADO') texto = 'Tiempo muerto';
  else if (t === 'TBANQUILLO-C') texto = 'Técnica al entrenador';
  else if (t === 'TBANQUILLO-B') texto = 'Técnica al banquillo';
  else if (t === 'INICIO-PARTIDO') texto = 'Empieza el partido';
  else if (t === 'INICIO-PERIODO') texto = `Empieza el ${ordinal(num(e.numero_periodo), sim.totalPeriods)}`;
  else if (t === 'FINAL-PERIODO') texto = `Final del ${ordinal(num(e.numero_periodo), sim.totalPeriods)}`;
  else if (t === 'FINAL-PARTIDO') texto = 'Final del partido';
  else if (t === 'CAMBIO-JUGADOR-ENTRA' || t === 'CAMBIO-JUGADOR-SALE') {
    // Las de inicio de cuarto (antes de INICIO-PERIODO) no son cambios: es el quinteto.
    if (siblings.some((x) => x.t === e.t && /^INICIO-(PERIODO|PARTIDO)$/.test(x.tipo))) return null;
    const mates = [e, ...siblings].filter((x) => x.side === e.side && x.t === e.t && /^CAMBIO-/.test(x.tipo));
    const entran = mates.filter((x) => x.tipo === 'CAMBIO-JUGADOR-ENTRA').map((x) => nameOf(sim, x.side, x.dorsal));
    const salen = mates.filter((x) => x.tipo === 'CAMBIO-JUGADOR-SALE').map((x) => nameOf(sim, x.side, x.dorsal));
    if (!entran.length && !salen.length) return null;
    dorsal = text((mates.find((x) => x.tipo === 'CAMBIO-JUGADOR-ENTRA') ?? mates[0]).dorsal);
    texto = entran.length && salen.length
      ? `Cambio: entra ${entran.join(' y ')} por ${salen.join(' y ')}`
      : entran.length ? `Entra ${entran.join(' y ')}` : `Sale ${salen.join(' y ')}`;
  }
  if (!texto) return null;
  const periodo = num(e.numero_periodo);
  return {
    id: text(e.autoincremental_id),
    texto,
    side: e.side,
    dorsal: dorsal && dorsal !== '-1' ? dorsal : null,
    // Acción de una jugadora: el rótulo le añade «(EQUIPO)» y su foto.
    deJugadora: Boolean(dorsal) && Boolean(e.side),
    tipo: t,
    periodo,
    periodoTexto: periodo ? (periodo > sim.totalPeriods ? `PR${periodo - sim.totalPeriods > 1 ? periodo - sim.totalPeriods : ''}` : `${periodo}º`) : '',
    quedan: remainingText(e.tiempo_partido),
  };
}

function emptyLine() {
  return { pts: 0, reb: 0, ro: 0, rd: 0, ast: 0, fal: 0, perd: 0, rec: 0, tap: 0, t1: [0, 0], t2: [0, 0], t3: [0, 0] };
}

/** Todo lo que se sabe en el instante `t` (segundos del día). */
export function snapshotAt(sim, t) {
  const evs = sim.events.filter((e) => e.t <= t);
  const lines = { local: new Map(), visitante: new Map() };
  const team = { local: emptyLine(), visitante: emptyLine() };
  const onCourt = { local: new Set(), visitante: new Set() };
  const lastCourt = { local: new Set(), visitante: new Set() };
  let score = { local: 0, visitante: 0 };
  const line = (side, dorsal) => {
    if (!lines[side].has(dorsal)) lines[side].set(dorsal, emptyLine());
    return lines[side].get(dorsal);
  };
  for (const e of evs) {
    const sc = scoreFrom(e);
    if (sc) score = sc;
    // Al acabar el cuarto la pista se vacía (el siguiente vuelve a anunciar su quinteto), pero se
    // recuerda quién lo terminó: es lo que se enseña ENTRE cuartos.
    if (e.tipo === 'FINAL-PERIODO') {
      for (const s of ['local', 'visitante']) { lastCourt[s] = new Set(onCourt[s]); onCourt[s].clear(); }
      continue;
    }
    if (!e.side) continue;
    const d = text(e.dorsal);
    if (e.tipo === 'CAMBIO-JUGADOR-ENTRA') { onCourt[e.side].add(d); continue; }
    if (e.tipo === 'CAMBIO-JUGADOR-SALE') { onCourt[e.side].delete(d); continue; }
    const targets = [line(e.side, d), team[e.side]];
    for (const L of targets) {
      switch (e.tipo) {
        case 'CANASTA-1P': L.pts += 1; L.t1[0] += 1; L.t1[1] += 1; break;
        case 'CANASTA-2P': L.pts += 2; L.t2[0] += 1; L.t2[1] += 1; break;
        case 'CANASTA-3P': L.pts += 3; L.t3[0] += 1; L.t3[1] += 1; break;
        case 'TIRO1-FALLADO': L.t1[1] += 1; break;
        case 'TIRO2-FALLADO': L.t2[1] += 1; break;
        case 'TIRO3-FALLADO': L.t3[1] += 1; break;
        case 'REBOTE-DEFENSIVO': L.reb += 1; L.rd += 1; break;
        case 'REBOTE-OFENSIVO': L.reb += 1; L.ro += 1; break;
        case 'ASISTENCIA': L.ast += 1; break;
        case 'PERDIDA': L.perd += 1; break;
        case 'RECUPERACION': L.rec += 1; break;
        case 'TAPON-COMETIDO': L.tap += 1; break;
        case 'FALTA-COMETIDA': case 'TANTIDEPORTIVA': case 'TDESCALIFICANTE': case 'TECNICA': L.fal += 1; break;
        default: break;
      }
    }
  }

  // El marcador se pinta con el MISMO cálculo que en directo: un play by play recortado.
  const finished = evs.some((e) => e.tipo === 'FINAL-PARTIDO');
  const started = evs.some((e) => e.tipo === 'INICIO-PARTIDO');
  const pbpAt = {
    partido: {
      ...sim.partido,
      estado_partido: finished ? 'FINALIZADO' : started ? 'COMENZADO' : 'NO COMENZADO',
      tanteo_local: score.local,
      tanteo_visitante: score.visitante,
    },
    envivo: { historialacciones: evs.slice().reverse() },
  };
  const marcador = started ? scoreboardFromPbp(pbpAt) : null;

  // Última acción que se enseña (los cambios del mismo instante, juntos).
  let accion = null;
  for (let i = evs.length - 1; i >= 0 && !accion; i -= 1) {
    const e = evs[i];
    const siblings = evs.filter((x) => x !== e && x.t === e.t);
    const d = describeEvent(sim, e, siblings);
    if (d) accion = { ...d, t: e.t };
  }
  // Las 2 últimas de CADA equipo (la más nueva primero): se enseñan sobre su mitad del marcador,
  // apiladas, así una asistencia no tapa la canasta que acaba de entrar (Luismi, 09-11). Solo se
  // busca en los últimos 30 s: más atrás ya no se enseñaría.
  const POR_EQUIPO = 2;
  const acciones = { local: [], visitante: [] };
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    if (acciones.local.length >= POR_EQUIPO && acciones.visitante.length >= POR_EQUIPO) break;
    const e = evs[i];
    if (e.t < t - 30) break;
    const d = describeEvent(sim, e, evs.filter((x) => x !== e && x.t === e.t));
    // Un cambio múltiple sale una vez (los eventos del mismo instante dan el mismo texto).
    if (d?.side && acciones[d.side].length < POR_EQUIPO && !acciones[d.side].some((a) => a.texto === d.texto)) {
      acciones[d.side].push({ ...d, t: e.t });
    }
  }

  // Acabado el partido, las faltas salen del acta (las que la mesa no publica en el play by play).
  if (finished) {
    for (const side of ['local', 'visitante']) {
      let total = 0;
      for (const p of sim.roster[side]) {
        const L = line(side, p.dorsal);
        if (p.faltasActa !== null && p.faltasActa > L.fal) L.fal = p.faltasActa;
        total += L.fal;
      }
      team[side].fal = Math.max(team[side].fal, total);
    }
  }
  const people = (side) => sim.roster[side].map((p) => ({ ...p, ...(lines[side].get(p.dorsal) ?? emptyLine()) }));
  const court = (side) => [...(onCourt[side].size ? onCourt[side] : lastCourt[side])]
    .map((d) => ({ ...(sim.players[side].get(d) ?? { dorsal: d, nombre: `Nº ${d}`, apellidos: '' }), ...(lines[side].get(d) ?? emptyLine()) }))
    .sort((a, b) => (num(a.dorsal) ?? 999) - (num(b.dorsal) ?? 999));
  return {
    t,
    marcador,
    accion,
    acciones,
    score,
    team,
    jugadoras: { local: people('local'), visitante: people('visitante') },
    enPista: { local: court('local'), visitante: court('visitante') },
  };
}

/** Líderes de un equipo en cada apartado (empates: el primero por dorsal). */
export function leaders(players) {
  const best = (key) => {
    const top = players.reduce((acc, p) => (p[key] > (acc?.[key] ?? 0) ? p : acc), null);
    return top ? { ...top, valor: top[key] } : null;
  };
  return {
    puntos: best('pts'), rebotes: best('reb'), asistencias: best('ast'), recuperaciones: best('rec'), tapones: best('tap'),
  };
}

/**
 * Qué escena toca en `t`:
 *   plantillas · marcador · quinteto · tiempo-muerto · entre-cuartos · estadisticas · comparativa · lideres · fin
 * `marcador: true` siempre: el resultado no se quita nunca (Luismi, 09-11); la escena va encima.
 * `datos`: 'parcial' (descanso: lo jugado) o 'final'.
 */
export function sceneAt(sim, t) {
  // Antes del salto (en directo: con el acta abierta y sin empezar), las plantillas.
  if (sim.start === null || t < sim.start) return { escena: 'plantillas', marcador: true, hasta: sim.start };
  if (sim.end !== null && t >= sim.end) {
    const post = t - sim.end;
    if (post < POST_WAIT_SECONDS) return { escena: 'marcador', marcador: true, hasta: sim.end + POST_WAIT_SECONDS };
    const i = Math.floor((post - POST_WAIT_SECONDS) / SCREEN_SECONDS);
    if (i < sim.screens.length) {
      return { escena: sim.screens[i], marcador: true, datos: 'final', hasta: sim.end + POST_WAIT_SECONDS + (i + 1) * SCREEN_SECONDS };
    }
    return { escena: 'fin', marcador: true, hasta: null };
  }
  // Descanso: estadísticas en bucle hasta los 6 min o hasta que empiece el 3er cuarto.
  if (sim.halfEnd !== null && t >= sim.halfEnd && (sim.secondHalf === null || t < sim.secondHalf)) {
    const into = t - sim.halfEnd;
    if (into < HALF_MARCADOR_AT) {
      const i = Math.floor(into / SCREEN_SECONDS);
      const next = Math.min(sim.halfEnd + (i + 1) * SCREEN_SECONDS, sim.halfEnd + HALF_MARCADOR_AT, sim.secondHalf ?? Infinity);
      return { escena: sim.screens[i % sim.screens.length], marcador: true, datos: 'parcial', hasta: next };
    }
    return { escena: 'marcador', marcador: true, hasta: sim.secondHalf };
  }
  const q = sim.quarterStarts.find((x) => t >= x.t && t < x.hasta);
  if (q) return { escena: 'quinteto', marcador: true, periodo: q.periodo, hasta: q.hasta };
  const to = sim.timeouts.find((x) => t >= x.t && t < x.hasta);
  if (to) return { escena: 'tiempo-muerto', marcador: true, side: to.side, hasta: to.hasta };
  const br = sim.breaks.find((x) => t >= x.t && t < x.hasta);
  if (br) return { escena: 'entre-cuartos', marcador: true, periodo: br.periodo, hasta: br.hasta };
  return { escena: 'marcador', marcador: true, hasta: null };
}

/** «18:31:44» */
export function clockText(t) {
  const s = ((Math.floor(t) % 86400) + 86400) % 86400;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
}
