// Parte PURA (sin red): del play by play y el boxscore de la FAB al estado que pintan los
// rótulos. Copiado y adaptado de AND Scout (match-meta.js / liveScoreboard.mjs); NO se importa
// de allí: este proyecto no comparte código con AND Scout.

const text = (v) => String(v ?? '').trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function normalizeKey(value) {
  return text(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

const isFinalState = (s) => /FINAL|TERMIN/.test(normalizeKey(s));
const isPendingState = (s) => /NO COMENZ|NO EMPEZ/.test(normalizeKey(s));
const isOffState = (s) => /APLAZ|SUSPEND|CANCEL/.test(normalizeKey(s));

// Eventos válidos, en orden de juego. La FAB los da del más nuevo al más viejo y marca los
// borrados con eliminado:"True".
export function eventsOf(pbp) {
  const rows = Array.isArray(pbp?.envivo?.historialacciones) ? pbp.envivo.historialacciones : [];
  return rows
    .filter((r) => r && text(r.eliminado) !== 'True')
    .slice()
    .sort((a, b) => (num(a.autoincremental_id) ?? 0) - (num(b.autoincremental_id) ?? 0));
}

const typeOf = (r) => text(r?.accion_tipo).toUpperCase();

// Faltas que cuentan como FALTA DE EQUIPO (FIBA: todas las de jugadora; las de banquillo no).
const TEAM_FOUL_TYPES = new Set(['FALTA-COMETIDA', 'TANTIDEPORTIVA', 'TDESCALIFICANTE', 'TECNICA']);
const TIMEOUT_TYPE = 'TIEMPO-MUERTO-SOLICITADO';

// Colores de la FAB (vienen en texto) → color del rótulo. Si llega uno desconocido, gris.
const COLORS = {
  BLANCO: '#f4f4f4', NEGRO: '#1b1b1f', ROJO: '#c8102e', GRANATE: '#7b1e2b', BURDEOS: '#6d1a2a',
  AZUL: '#1f4fbf', 'AZUL MARINO': '#14284b', MARINO: '#14284b', 'AZUL CLARO': '#4ba3e3', CELESTE: '#5bb8e8',
  VERDE: '#1d8a4a', 'VERDE CLARO': '#5cc16b', AMARILLO: '#f2c200', NARANJA: '#f07c00', MORADO: '#6a2c91',
  LILA: '#9b6bc9', VIOLETA: '#7a3fb0', ROSA: '#e85a9b', FUCSIA: '#d6247a', GRIS: '#7c8088', PLATA: '#a9adb3',
  ORO: '#c9a227', DORADO: '#c9a227', TURQUESA: '#1fb5a8', MARRON: '#7a4a21',
};

export function colorFromFab(name) {
  return COLORS[normalizeKey(name)] ?? '#3b3f47';
}

// "CB EL PALO - BASKET4LIFE" → "CB EL PALO": lo que va detrás del guion suele ser el patrocinador.
export function defaultShortName(name) {
  const full = text(name).replace(/\s+/g, ' ');
  const cut = full.split(/\s+-\s+/)[0];
  return (cut || full).toUpperCase();
}

// Instante del último evento con reloj, para saber en qué periodo vamos y si está parado.
function periodLength(partido, period) {
  const normal = num(partido?.duracion_periodo_normal_mm) || 10;
  const extra = num(partido?.duracion_periodo_extra_mm) || 5;
  const periods = num(partido?.numperiodos) || 4;
  return (period > periods ? extra : normal) * 60;
}

function remainingSeconds(value) {
  const parts = text(value).split(':').map((p) => Number(p.replace(',', '.')));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

export function periodLabel(period, totalPeriods = 4) {
  if (!period) return '';
  return period > totalPeriods ? `PR${period - totalPeriods > 1 ? period - totalPeriods : ''}` : `${period}º`;
}

/**
 * Estado del marcador.
 *   fase: 'previa' | 'juego' | 'descanso' | 'final' | 'suspendido'
 *   periodo / periodoTexto, reloj (lo que QUEDA según el último evento, "mm:ss" o null),
 *   minuto jugado, y por equipo: nombre, color, puntos, faltas del periodo, bonus, tiempos muertos.
 */
export function scoreboardFromPbp(pbp) {
  const partido = pbp?.partido ?? null;
  if (!partido) return null;
  const events = eventsOf(pbp);
  const rawState = text(partido.estado_partido);
  const totalPeriods = num(partido.numperiodos) || 4;
  const localId = text(partido.idlocal);
  const awayId = text(partido.idvisitante);
  const sideOf = (r) => (text(r?.equipo_id) === localId ? 'local' : text(r?.equipo_id) === awayId ? 'visitante' : null);

  let period = 0;
  let periodClosed = false;
  let lastClock = null;
  let started = false;
  let finished = false;
  const fouls = { local: new Map(), visitante: new Map() };
  const timeouts = { local: [], visitante: [] };

  for (const r of events) {
    const type = typeOf(r);
    const p = num(r.numero_periodo) || period || 1;
    if (type === 'INICIO-PARTIDO') started = true;
    if (type === 'INICIO-PERIODO') { period = p; periodClosed = false; started = true; continue; }
    if (type === 'FINAL-PERIODO') { period = p; periodClosed = true; continue; }
    if (type === 'FINAL-PARTIDO') { finished = true; periodClosed = true; continue; }
    if (p > period) { period = p; periodClosed = false; }
    const secs = remainingSeconds(r.tiempo_partido);
    if (secs !== null && p === period) lastClock = secs;
    const side = sideOf(r);
    if (!side) continue;
    started = true;
    if (TEAM_FOUL_TYPES.has(type)) fouls[side].set(p, (fouls[side].get(p) ?? 0) + 1);
    if (type === TIMEOUT_TYPE) timeouts[side].push(p);
  }

  let fase;
  if (isOffState(rawState)) fase = 'suspendido';
  else if (finished || isFinalState(rawState)) fase = 'final';
  else if (!started || isPendingState(rawState) || !rawState) fase = 'previa';
  else if (periodClosed) fase = 'descanso';
  else fase = 'juego';

  // Tiempos muertos FIBA: 2 en la 1ª mitad, 3 en la 2ª, 1 por prórroga.
  const half = period <= totalPeriods / 2 ? 1 : period <= totalPeriods ? 2 : 3;
  const timeoutsLeft = (side) => {
    const used = timeouts[side].filter((p) => {
      if (half === 1) return p <= totalPeriods / 2;
      if (half === 2) return p > totalPeriods / 2 && p <= totalPeriods;
      return p === period;
    }).length;
    return Math.max(0, (half === 1 ? 2 : half === 2 ? 3 : 1) - used);
  };

  const team = (side) => {
    const isLocal = side === 'local';
    const periodFouls = fouls[side].get(period) ?? 0;
    return {
      nombre: text(isLocal ? partido.local : partido.visitante),
      corto: defaultShortName(isLocal ? partido.local : partido.visitante),
      color: colorFromFab(isLocal ? partido.color_local : partido.color_visitante),
      colorFab: text(isLocal ? partido.color_local : partido.color_visitante),
      puntos: num(isLocal ? partido.tanteo_local : partido.tanteo_visitante) ?? 0,
      // Fuera de juego (previa, final) no hay faltas que enseñar: null, y el rótulo las oculta.
      faltas: fase === 'juego' || fase === 'descanso' ? periodFouls : null,
      bonus: (fase === 'juego') && periodFouls >= 4,
      tiempos: fase === 'juego' || fase === 'descanso' ? timeoutsLeft(side) : null,
      tiemposMax: half === 1 ? 2 : half === 2 ? 3 : 1,
    };
  };

  let periodoTexto = '';
  if (fase === 'previa') periodoTexto = 'PREVIA';
  else if (fase === 'final') periodoTexto = 'FINAL';
  else if (fase === 'suspendido') periodoTexto = normalizeKey(rawState) || 'SUSPENDIDO';
  else if (fase === 'descanso') periodoTexto = period === totalPeriods / 2 ? 'DESCANSO' : `FIN ${periodLabel(period, totalPeriods)}`;
  else periodoTexto = periodLabel(period, totalPeriods);

  const len = period ? periodLength(partido, period) : null;
  const reloj = fase === 'juego' && lastClock !== null
    ? `${String(Math.floor(lastClock / 60)).padStart(2, '0')}:${String(Math.floor(lastClock % 60)).padStart(2, '0')}`
    : null;
  const prior = period > totalPeriods
    ? totalPeriods * periodLength(partido, 1) + (period - totalPeriods - 1) * periodLength(partido, period)
    : (period - 1) * periodLength(partido, 1);
  const minuto = fase === 'juego' && lastClock !== null && len
    ? Math.floor((prior + Math.max(0, len - lastClock)) / 60)
    : null;

  const parciales = Array.isArray(partido.periodos)
    ? partido.periodos.map((x) => ({ periodo: num(x.periodo), local: num(x.tanteo_periodo_local), visitante: num(x.tanteo_periodo_visitante) }))
    : [];

  return {
    fase,
    estadoFab: rawState,
    periodo: period || null,
    periodoTexto,
    reloj,
    minuto,
    local: team('local'),
    visitante: team('visitante'),
    parciales,
  };
}

// "SILVA GUITTON,  VALENTINA MARIE ANA" → { nombre: "VALENTINA MARIE ANA", apellidos: "SILVA GUITTON" }
// Completos: hay sitio de sobra en el cartel (Luismi, 07-11: sin diminutivos ni iniciales).
export function splitName(full) {
  const [surnames = '', given = ''] = text(full).split(',').map((x) => x.trim().replace(/\s+/g, ' '));
  if (!given) return { nombre: surnames.toUpperCase(), apellidos: '' };
  return { nombre: given.toUpperCase(), apellidos: surnames.toUpperCase() };
}

// "MONTIEL PAZ, LUIS MIGUEL" → "LUIS MIGUEL MONTIEL PAZ"
export function coachDisplayName(full) {
  const { nombre, apellidos } = splitName(full);
  return [nombre, apellidos].filter(Boolean).join(' ');
}

/** Plantilla de un lado ('local' | 'visitante') a partir del boxscore. */
export function rosterFromBoxscore(box, side) {
  const stats = box?.estadisticas;
  if (!stats) return null;
  const isLocal = side === 'local';
  const rows = Array.isArray(isLocal ? stats.estadisticasequipolocal : stats.estadisticasequipovisitante)
    ? (isLocal ? stats.estadisticasequipolocal : stats.estadisticasequipovisitante)
    : [];
  // El boxscore mete al final una fila «TOTALES» del equipo (sin dorsal): no es una jugadora.
  const players = rows
    .filter((r) => r && text(r.nombre) && text(r.dorsal) && normalizeKey(r.nombre) !== 'TOTALES')
    .map((r) => ({
      dorsal: text(r.dorsal),
      nombreCompleto: text(r.nombre),
      ...splitName(r.nombre),
      capitana: Boolean(r.capitan),
      titular: Boolean(r.quintetotitular),
      puntos: num(r.puntos) ?? 0,
      faltas: num(r.faltascometidas) ?? 0,
    }))
    .sort((a, b) => (num(a.dorsal) ?? 999) - (num(b.dorsal) ?? 999));
  const coach = text(isLocal ? stats.entrenadorlocal : stats.entrenadorvisitante);
  return {
    equipo: text(isLocal ? stats.equipolocal : stats.equipovisitante),
    corto: defaultShortName(isLocal ? stats.equipolocal : stats.equipovisitante),
    jugadoras: players,
    entrenador: coach ? coachDisplayName(coach) : '',
  };
}

// Clave para cruzar la plantilla del acta con la del equipo (fotos): el nombre completo EXACTO,
// sin tildes, mayúsculas ni espacios de más. Nada de parecidos.
export function personKey(full) {
  return normalizeKey(full).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
}
