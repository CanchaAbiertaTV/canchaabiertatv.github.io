// De ids ESTABLES a tokens de sesión, y elección del partido.
//
// Los ids cifrados de la FAB (club.Id, equipo.Id, IdPartido) van ligados al dispositivo, así
// que los enlaces del rótulo llevan solo ids estables:
//   club    = IdClub (número)            + b = texto para buscarlo (la FAB no deja pedirlo por id)
//   equipo  = IdEquipoNotificacion
//   partido = IdPartidoNotificacion       (opcional: sin él, el partido de HOY del equipo)
// Cadena: buscarClub(b) → club → equipos → equipo → fases/grupos → calendario → IdPartido.
// Probado en vivo el 07-11-26: el IdPartido sigue valiendo aunque la key rote (mismo dispositivo).
import { ENDPOINTS, imageUrl } from './fab.mjs';

const s = (v) => String(v ?? '').trim();
const MAX_PAGES = 5;
const TEAM_TTL_MS = 10 * 60 * 1000;

export function parseFabDate(value) {
  const m = /\/Date\((-?\d+)/.exec(s(value));
  return m ? new Date(Number(m[1])) : null;
}

export function createResolver(fab) {
  const teamCache = new Map(); // `${club}|${equipo}` -> { at, team, rows }

  async function searchClubs(texto, maxPages = MAX_PAGES) {
    const out = [];
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await fab.call(ENDPOINTS.buscarClub, { texto, skip: String(page * 10) });
      const clubs = Array.isArray(payload?.clubes) ? payload.clubes : [];
      out.push(...clubs);
      if (clubs.length < 10) break;
    }
    return out;
  }

  async function findClub(clubId, texto) {
    const clubs = await searchClubs(texto);
    return clubs.find((c) => s(c.IdClub) === s(clubId)) ?? null;
  }

  async function clubTeams(clubId, texto) {
    const club = await findClub(clubId, texto);
    if (!club?.Id) return { club: null, teams: [] };
    const payload = await fab.call(ENDPOINTS.club, { accion: 'equipos', id_club: s(club.Id) });
    return { club, teams: Array.isArray(payload?.equipos) ? payload.equipos : [] };
  }

  // Token de sesión de un equipo a partir de su club (por NOMBRE, que es lo que trae el partido)
  // y su IdEquipoNotificacion (= idlocal/idvisitante del play by play). Para las fotos.
  const notifCache = new Map(); // notif -> Promise<equipo|null>
  function teamByNotif(clubName, notif) {
    const key = s(notif);
    if (!key || s(clubName).length < 3) return Promise.resolve(null);
    if (!notifCache.has(key)) {
      notifCache.set(key, (async () => {
        const clubs = await searchClubs(s(clubName), 2);
        for (const c of clubs) {
          const payload = await fab.call(ENDPOINTS.club, { accion: 'equipos', id_club: s(c.Id) });
          const t = (Array.isArray(payload?.equipos) ? payload.equipos : []).find((e) => s(e.IdEquipoNotificacion) === key);
          if (t) return t;
        }
        return null;
      })().catch(() => { notifCache.delete(key); return null; }));
    }
    return notifCache.get(key);
  }

  // Todo el calendario del equipo (todas sus fases y grupos), solo SUS partidos.
  async function teamCalendar(team) {
    const fases = await fab.call(ENDPOINTS.fasesGrupos, { id_equipo: s(team.Id) });
    const list = Array.isArray(fases?.listaFasesGrupo) ? fases.listaFasesGrupo : [];
    const sets = [];
    for (const f of list) {
      for (const g of Array.isArray(f.Grupos) ? f.Grupos : []) {
        if (s(f.IdFase) && s(g.IdGrupo)) sets.push({ idFase: s(f.IdFase), idGrupo: s(g.IdGrupo) });
      }
    }
    const now = new Date();
    const from = new Date(now.getTime() - 300 * 864e5).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 300 * 864e5).toISOString().slice(0, 10);
    const name = s(team.Nombre).toUpperCase();
    const seen = new Set();
    const rows = [];
    // El calendario es del GRUPO entero: hay que quedarse con las filas del equipo. Las filas no
    // traen el id del equipo, así que se filtra por nombre (dentro de SUS grupos no hay otro igual).
    for (const set of sets) {
      const cal = await fab.call(ENDPOINTS.calendario, {
        id_equipo: s(team.Id), id_fase: set.idFase, id_grupo: set.idGrupo, id_ronda: '',
        fecha_inicial: `${from} 00:00`, fecha_final: `${to} 23:59`,
      });
      for (const r of Array.isArray(cal?.partidos) ? cal.partidos : []) {
        const mine = s(r.NombreEquipoLocal).toUpperCase() === name || s(r.NombreEquipoVisitante).toUpperCase() === name;
        if (!mine || seen.has(s(r.IdPartidoNotificacion))) continue;
        seen.add(s(r.IdPartidoNotificacion));
        rows.push(r);
      }
    }
    rows.sort((a, b) => (parseFabDate(a.FechaHoraUTC)?.getTime() ?? 0) - (parseFabDate(b.FechaHoraUTC)?.getTime() ?? 0));
    return rows;
  }

  async function team(clubId, texto, teamNotif, { fresh = false } = {}) {
    const key = `${s(clubId)}|${s(teamNotif)}`;
    const hit = teamCache.get(key);
    if (hit && !fresh && Date.now() - hit.at < TEAM_TTL_MS) return hit;
    const { teams } = await clubTeams(clubId, texto);
    const t = teams.find((x) => s(x.IdEquipoNotificacion) === s(teamNotif));
    if (!t?.Id) throw Object.assign(new Error('No se encuentra el equipo en su club.'), { status: 404 });
    const entry = { at: Date.now(), team: t, rows: await teamCalendar(t) };
    teamCache.set(key, entry);
    return entry;
  }

  // Partido a enseñar: el fijado por `partido`, o el de HOY del equipo. "Hoy" = el más
  // cercano que empieza entre 4 h antes y 18 h después de ahora; si no hay, el siguiente que
  // queda por jugar; si tampoco, el último jugado.
  function pickRow(rows, partidoNotif, now = Date.now()) {
    if (s(partidoNotif)) return rows.find((r) => s(r.IdPartidoNotificacion) === s(partidoNotif)) ?? null;
    const timed = rows.map((r) => ({ r, t: parseFabDate(r.FechaHoraUTC)?.getTime() ?? null })).filter((x) => x.t !== null);
    const window = timed.filter((x) => x.t >= now - 4 * 3600e3 && x.t <= now + 18 * 3600e3);
    if (window.length) return window.sort((a, b) => Math.abs(a.t - now) - Math.abs(b.t - now))[0].r;
    const next = timed.filter((x) => x.t > now).sort((a, b) => a.t - b.t)[0];
    if (next) return next.r;
    return timed.sort((a, b) => b.t - a.t)[0]?.r ?? null;
  }

  // Partidos del CLUB (todos sus equipos) de hoy en adelante: club.ashx?accion=partidosClub,
  // UNA llamada (la misma que usa la web del CB El Palo). `dias` cuenta desde hoy.
  const clubCache = new Map(); // `${club}|${dias}` -> { at, club, rows }
  const CLUB_TTL_MS = 2 * 60 * 1000;

  async function clubMatches(clubId, texto, dias = 2, { fresh = false, clubRow = null } = {}) {
    const key = `${s(clubId)}|${dias}`;
    const hit = clubCache.get(key);
    if (hit && !fresh && Date.now() - hit.at < CLUB_TTL_MS) return hit;
    const c = clubRow ?? await findClub(clubId, texto);
    if (!c?.Id) throw Object.assign(new Error('No se encuentra el club.'), { status: 404 });
    const payload = await fab.call(ENDPOINTS.club, { accion: 'partidosClub', id_club: s(c.Id), dias: String(dias) });
    const rows = (Array.isArray(payload?.mispartidos) ? payload.mispartidos : [])
      // «DESCANSA» es la jornada de descanso, no un partido.
      .filter((r) => !/^DESCANSA$/i.test(s(r.NombreEquipoLocal)) && !/^DESCANSA$/i.test(s(r.NombreEquipoVisitante)));
    const entry = { at: Date.now(), club: c, rows };
    clubCache.set(key, entry);
    return entry;
  }

  // Enlace por club + partido (sin equipo): se busca en los partidos del club.
  async function matchByClub({ club, b, partido }) {
    let entry = await clubMatches(club, b, 3);
    let row = entry.rows.find((r) => s(r.IdPartidoNotificacion) === s(partido));
    if (!row) {
      entry = await clubMatches(club, b, 3, { fresh: true });
      row = entry.rows.find((r) => s(r.IdPartidoNotificacion) === s(partido));
    }
    let clubRow = entry.club;
    // partidosClub solo trae de HOY en adelante: un partido ya jugado (para simularlo días después)
    // se busca en el calendario de temporada de cada equipo del club, hasta dar con él.
    if (!row?.IdPartido) {
      const { club: c, teams } = await clubTeams(club, b);
      for (const t of teams) {
        const hit = await team(club, b, t.IdEquipoNotificacion).catch(() => null);
        row = hit?.rows.find((r) => s(r.IdPartidoNotificacion) === s(partido));
        if (row?.IdPartido) { clubRow = c; break; }
      }
    }
    if (!row?.IdPartido) throw Object.assign(new Error('Ese partido ya no está en el calendario del club.'), { status: 404 });
    // «Nuestro» lado: el del club del enlace (en un derbi, el local).
    const clubName = normalize(clubRow.NombreClub);
    const ownSide = normalize(row.NombreClubLocal) === clubName || normalize(row.NombreClubVisitante) !== clubName ? 'local' : 'visitante';
    return { row, team: null, ownSide };
  }

  async function match({ club, b, equipo, partido }) {
    if (!s(equipo)) return matchByClub({ club, b, partido });
    let entry = await team(club, b, equipo);
    let row = pickRow(entry.rows, partido);
    if (!row && s(partido)) {
      // Puede ser un partido recién metido en el calendario: se refresca una vez.
      entry = await team(club, b, equipo, { fresh: true });
      row = pickRow(entry.rows, partido);
    }
    if (!row?.IdPartido) throw Object.assign(new Error('No hay partido para ese equipo.'), { status: 404 });
    const ownSide = s(row.NombreEquipoLocal).toUpperCase() === s(entry.team.Nombre).toUpperCase() ? 'local' : 'visitante';
    return { row, team: entry.team, ownSide };
  }

  // Búsqueda libre: «El Palo Novaschool». Las primeras palabras que encuentren club son el
  // club; el resto filtra sus partidos (rival, categoría…). Solo los partidos de HOY.
  async function searchMatches(texto, { now = Date.now(), maxClubs = 6 } = {}) {
    const words = s(texto).split(/\s+/).filter(Boolean);
    let clubs = [];
    let prefix = '';
    let rest = [];
    for (let k = words.length; k >= 1; k -= 1) {
      const candidate = words.slice(0, k).join(' ');
      if (candidate.length < 3) break;
      clubs = await searchClubs(candidate, 2);
      if (clubs.length) { prefix = candidate; rest = words.slice(k); break; }
    }
    if (!clubs.length) return { club: '', filtro: '', partidos: [] };
    const needles = rest.map(normalize);
    const today = todayInSpain(now);
    const out = [];
    for (const c of clubs.slice(0, maxClubs)) {
      const { rows } = await clubMatches(c.IdClub, prefix, 2, { clubRow: c }).catch(() => ({ rows: [] }));
      for (const r of rows) {
        // Solo los de HOY, por la fecha del acta («07/11/2026»).
        if (s(r.Fecha) !== today) continue;
        const hay = normalize(`${r.NombreEquipoLocal} ${r.NombreEquipoVisitante} ${r.Categoria}`);
        if (!needles.every((n) => hay.includes(n))) continue;
        const clubName = normalize(c.NombreClub);
        const lado = normalize(r.NombreClubLocal) === clubName || normalize(r.NombreClubVisitante) !== clubName ? 'local' : 'visitante';
        out.push({ ...publicRow(r), club: s(c.IdClub), b: prefix, lado, clubNombre: s(c.NombreClub), delegacion: delegacionVisible(c.NombreDelegacion) });
      }
    }
    out.sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio));
    return { club: prefix, filtro: rest.join(' '), partidos: out };
  }

  return { searchClubs, clubTeams, team, match, pickRow, searchMatches, teamByNotif };
}

// Fecha de hoy en España con el formato de la FAB («07/11/2026»). En hora de Madrid y no del
// servidor: el Worker de Cloudflare corre en UTC y de 00:00 a 01:00 diría «ayer».
// La web no nombra a la federación (Luismi, 13-11): los clubes inscritos en la autonómica salen
// como «Andalucía»; las delegaciones provinciales, tal cual («Delegación de Málaga»).
export function delegacionVisible(nombre) {
  const t = String(nombre ?? '').trim();
  return /^federaci[oó]n andaluza de baloncesto$/i.test(t) ? 'Andalucía' : t;
}

export function todayInSpain(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

export function normalize(value) {
  return s(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ');
}

/** Fila del calendario → lo que necesita el selector. Sin tokens de datos; los escudos sí van, como
 * URL de imagen: son de la sesión de ESTE navegador y solo sirven para pintarlos. */
export function publicRow(r) {
  const when = parseFabDate(r.FechaHoraUTC);
  return {
    partido: s(r.IdPartidoNotificacion),
    local: s(r.NombreEquipoLocal),
    visitante: s(r.NombreEquipoVisitante),
    fecha: s(r.Fecha),
    hora: s(r.Hora).slice(0, 5),
    inicio: when ? when.toISOString() : null,
    estado: s(r.Estado),
    resultado: r?.Resultados?.ResultadoLocal && r?.Resultados?.ResultadoVisitante
      && s(r.Resultados.ResultadoLocal) !== '-'
      ? `${s(r.Resultados.ResultadoLocal)}-${s(r.Resultados.ResultadoVisitante)}`
      : '',
    pabellon: s(r.CampoJuego),
    jornada: r.NumeroJornada ?? null,
    categoria: s(r.Categoria),
    escudoLocal: imageUrl("escudo", r.ImgEquipoLocal),
    escudoVisitante: imageUrl("escudo", r.ImgEquipoVisitante),
  };
}
