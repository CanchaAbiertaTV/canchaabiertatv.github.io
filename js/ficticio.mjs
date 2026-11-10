// Partido FICTICIO (13-11, Luismi): en las SIMULACIONES no sale nadie de verdad. Toma lo que da
// /api/directo (o una demo guardada, mismo formato) y cambia equipos, jugadoras, entrenadores,
// escudos y fotos por inventados. Los números (marcador, jugadas, tiempos) son los del partido.
// Lo usan el widget (directo.mjs, siempre que simula) y scripts/demo-ficticia.mjs (la demo de la portada).
//
// Pura: no toca la red ni el DOM. Si después de cambiar queda una palabra de un nombre real en
// cualquier texto, ese texto se VACÍA (mejor un hueco que una persona real).

export const EQUIPOS = {
  local: { nombre: 'CB SIERRA NEVADA', color: '#1f4fbf', siglas: 'SN' },
  visitante: { nombre: 'CB COSTA DEL SOL', color: '#f07c00', siglas: 'CS' },
};
export const NOMBRES = ['LUCÍA', 'MARTA', 'PAULA', 'CARMEN', 'SARA', 'ELENA', 'ANA', 'IRENE', 'CLARA', 'NURIA', 'LAURA', 'ALBA',
  'NOA', 'CELIA', 'JULIA', 'ROCÍO', 'INÉS', 'VERA', 'MAR', 'OLGA', 'TERESA', 'BLANCA', 'EVA', 'LOLA', 'SOFÍA', 'MARINA'];
export const APELLIDOS = ['GARCÍA', 'MARTÍN', 'LÓPEZ', 'RUIZ', 'MORENO', 'NAVARRO', 'ROMERO', 'TORRES', 'DOMÍNGUEZ', 'VÁZQUEZ',
  'SERRANO', 'BLANCO', 'MOLINA', 'ORTEGA', 'DELGADO', 'CASTRO', 'ORTIZ', 'RUBIO', 'MARÍN', 'SANZ', 'IGLESIAS', 'MEDINA',
  'GARRIDO', 'CORTÉS', 'CASTILLO', 'SANTOS', 'LOZANO', 'GUERRERO', 'CANO', 'PRIETO', 'MÉNDEZ', 'CRUZ', 'CALVO', 'GALLEGO'];

const svgUri = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
export const FOTO_ANONIMA = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#cfd6e4"/><circle cx="50" cy="38" r="19" fill="#8a97b0"/><path d="M14 100 Q16 66 50 64 Q84 66 86 100 Z" fill="#8a97b0"/></svg>');
export const escudoFicticio = (lado) => {
  const e = EQUIPOS[lado];
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 4 L92 18 L88 62 Q80 86 50 96 Q20 86 12 62 L8 18 Z" fill="${e.color}" stroke="#0b1630" stroke-width="5"/><circle cx="50" cy="42" r="17" fill="none" stroke="#fff" stroke-width="4"/><path d="M33 42 H67 M50 25 V59" stroke="#fff" stroke-width="3"/><text x="50" y="84" font-family="Arial Black, Arial" font-weight="900" font-size="17" fill="#fff" text-anchor="middle">${e.siglas}</text></svg>`);
};

const sinTilde = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
const palabras = (s) => sinTilde(s).split(/[^A-Z]+/).filter(Boolean);
const lista = (v) => (Array.isArray(v) ? v : []);

export function anonimizar(src) {
  if (!src || typeof src !== 'object') return src;
  const est = src.box?.estadisticas ?? {};
  const ott = src.pbp?.EnVivoJugadoresOTT ?? {};
  const envivo = src.pbp?.envivo ?? {};

  // Personas reales → inventadas («APELLIDOS, NOMBRE», el formato del acta).
  const mapa = new Map();
  let n = 0;
  const pon = (real) => {
    const r = String(real ?? '').trim();
    if (!r || mapa.has(r) || /^TOTALES$/i.test(r)) return;
    const i = n++;
    mapa.set(r, `${APELLIDOS[(i * 7) % APELLIDOS.length]} ${APELLIDOS[(i * 11 + 3) % APELLIDOS.length]}, ${NOMBRES[i % NOMBRES.length]}`);
  };
  for (const lado of ['local', 'visitante']) {
    for (const j of lista(est[`estadisticasequipo${lado}`])) pon(j.nombre);
    pon(est[`entrenador${lado}`]);
    for (const j of lista(ott[`JugadoresEnVivo${lado === 'local' ? 'Local' : 'Visitante'}`])) pon(j.Nombre);
    for (const j of lista(envivo[`jugadoresenpista${lado}`])) pon(j.nombre);
  }
  // Equipos reales (de todas partes donde vienen) → ficticios.
  const equipos = new Map();
  const ponEquipo = (real, lado) => { const r = String(real ?? '').trim(); if (r) equipos.set(r, EQUIPOS[lado].nombre); };
  for (const lado of ['local', 'visitante']) {
    ponEquipo(src.partido?.[lado], lado);
    ponEquipo(src.pbp?.partido?.[lado], lado);
    ponEquipo(src.box?.partido?.[lado], lado);
    ponEquipo(est[`equipo${lado}`], lado);
    ponEquipo(src[lado]?.nombre, lado);
  }

  const cambia = (v) => {
    if (typeof v === 'string') return mapa.get(v.trim()) ?? equipos.get(v.trim()) ?? v;
    if (Array.isArray(v)) return v.map(cambia);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cambia(x)]));
    return v;
  };
  const out = cambia(src);

  // Cabecera de cada equipo: nombre, escudo, color, fotos (todas la silueta) y el entrenador, que
  // aquí llega en OTRO formato («NOMBRE APELLIDOS») y el mapa no lo pilla.
  for (const lado of ['local', 'visitante']) {
    const fotos = Object.fromEntries(Object.keys(src[lado]?.fotos ?? {}).map((d) => [d, FOTO_ANONIMA]));
    for (const j of lista(est[`estadisticasequipo${lado}`])) if (j?.dorsal != null) fotos[String(j.dorsal)] = FOTO_ANONIMA;
    out[lado] = { ...(out[lado] ?? {}), nombre: EQUIPOS[lado].nombre, escudo: escudoFicticio(lado), color: EQUIPOS[lado].color,
      fotos, entrenador: mapa.get(String(est[`entrenador${lado}`] ?? '').trim()) ?? '' };
  }
  const L = 'Local', V = 'Visitante';
  if (out.partido) Object.assign(out.partido, { [`escudo${L}`]: escudoFicticio('local'), [`escudo${V}`]: escudoFicticio('visitante') });
  // Nada que apunte al partido real ni a la federación.
  if (out.pbp?.EnVivoJugadoresOTT) Object.assign(out.pbp.EnVivoJugadoresOTT, { UrlOTT: '', OTT: false });
  for (const k of ['Delegacion', 'Competicion']) if (out.box?.estadisticas?.[k] != null) out.box.estadisticas[k] = '';

  // Red de seguridad: cualquier texto con una palabra de un nombre real (en cualquier formato,
  // con o sin tildes), una URL o la federación se queda vacío.
  const inventadas = new Set([...NOMBRES, ...APELLIDOS, ...Object.values(EQUIPOS).flatMap((e) => palabras(e.nombre))].map(sinTilde));
  const reales = new Set([...mapa.keys(), ...equipos.keys()].flatMap(palabras)
    .filter((w) => w.length >= 4 && !inventadas.has(w) && !['CLUB', 'BALONCESTO', 'BASKET', 'BASQUET'].includes(w)));
  const delata = (s) => /https?:\/\//i.test(s) || /\bFAB\b/.test(s) || /federaci/i.test(s) || palabras(s).some((w) => reales.has(w));
  const limpia = (v) => {
    if (typeof v === 'string') return v.startsWith('data:image/') ? v : (delata(v) ? '' : v);
    if (Array.isArray(v)) return v.map(limpia);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpia(x)]));
    return v;
  };
  const final = limpia(out);
  Object.defineProperty(final, 'ficticio', { value: { personas: mapa.size, equipos: equipos.size }, enumerable: false });
  return final;
}
