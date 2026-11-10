// API del marcador. Recibe un Request estándar y devuelve un Response. Corre EN EL NAVEGADOR
// (public/js/cliente.mjs): la web es estática y cada móvil habla con la FAB directamente.
//
// No devuelve tokens de datos ni la key: solo datos de juego, ids estables y URLs de imagen
// (escudos y fotos, que son de la sesión de este mismo navegador).
import { ENDPOINTS, imageUrl } from './fab.mjs';
import { createResolver, publicRow } from './resolver.mjs';
import { personKey, rosterFromBoxscore, scoreboardFromPbp } from './marcador.mjs';

const LIVE_TTL_MS = 4_000;       // varios rótulos abiertos del mismo partido = una sola llamada
const ROSTER_TTL_MS = 60_000;
const PHOTOS_TTL_MS = 30 * 60_000;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export function createApi(fab) {
  const resolver = createResolver(fab);
  const cache = new Map();

  // Caché corta + peticiones en vuelo compartidas.
  function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = load().catch((err) => { cache.delete(key); throw err; });
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return value;
  }

  const params = (url) => ({
    club: url.searchParams.get('club') ?? '',
    b: url.searchParams.get('b') ?? '',
    equipo: url.searchParams.get('equipo') ?? '',
    partido: url.searchParams.get('partido') ?? '',
  });

  async function loadMatch(q) {
    // ownSide: en qué lado juega «nuestro» equipo (el del enlace, o el del club del enlace).
    const { row, ownSide } = await resolver.match(q);
    const pbp = await cached(`pbp|${row.IdPartidoNotificacion}`, LIVE_TTL_MS,
      () => fab.call(ENDPOINTS.playByPlay, { id_partido: row.IdPartido, idclublocal: '', idlocal: '' }));
    return { row, ownSide, pbp };
  }

  // ¿Foto de verdad? Sin foto, la FAB devuelve un avatar SVG genérico: entonces no se enseña.
  async function realPhoto(url) {
    if (!url) return null;
    try {
      const res = await fetch(url);
      const type = res.headers.get('content-type') ?? '';
      await res.arrayBuffer();
      return res.ok && /^image\//.test(type) && !/svg/.test(type) ? url : null;
    } catch {
      return null;
    }
  }

  // Fotos de un equipo: su plantilla (equipo.ashx?accion=jugadores) trae el token `Foto`; el acta
  // no (sus ids dan siempre el avatar). Se cruza por NOMBRE COMPLETO exacto.
  function teamPhotos(clubName, notif) {
    return cached(`fotos|${notif}`, PHOTOS_TTL_MS, async () => {
      const team = await resolver.teamByNotif(clubName, notif);
      if (!team?.Id) return new Map();
      const payload = await fab.call(ENDPOINTS.jugadores, { id_equipo: String(team.Id) });
      const rows = Array.isArray(payload?.misjugadores) ? payload.misjugadores : [];
      const out = new Map();
      await Promise.all(rows.map(async (p) => {
        const url = await realPhoto(imageUrl('jugador', p.Foto));
        if (url) out.set(personKey(p.Nombre), url);
      }));
      return out;
    });
  }

  // Foto de una jugadora que NO está en la plantilla de su equipo (vinculada/canterana: juega con
  // él pero su ficha es de otro equipo del club). Búsqueda de la FAB por nombre COMPLETO EXACTO; si
  // hay homónimas, solo la del mismo club; en la duda, sin foto (nunca la de otra persona).
  function linkedPhoto(nombreCompleto, clubName) {
    return cached(`vinc|${personKey(nombreCompleto)}|${personKey(clubName)}`, PHOTOS_TTL_MS, async () => {
      const raw = String(nombreCompleto ?? '').trim();
      const [apellidos, nombre] = raw.includes(',') ? raw.split(',').map((x) => x.trim()) : [raw, raw];
      const payload = await fab.call(ENDPOINTS.buscarJugador, { nombre: nombre || raw, apellido: apellidos, texto: apellidos, skip: '0' });
      const rows = (Array.isArray(payload?.jugadores) ? payload.jugadores : [])
        .filter((p) => personKey(p.Nombre) === personKey(raw) && String(p.Foto ?? '').trim());
      const sameClub = rows.filter((p) => personKey(p.Club ?? '') === personKey(clubName));
      const pick = sameClub[0] ?? (new Set(rows.map((p) => p.Foto)).size === 1 ? rows[0] : null);
      return pick ? realPhoto(imageUrl('jugador', pick.Foto)) : null;
    });
  }

  const routes = {
    // Búsqueda libre de partidos de HOY: «El Palo Novaschool».
    async '/api/buscar'(url) {
      const texto = (url.searchParams.get('texto') ?? '').trim();
      if (texto.length < 3) return json(400, { error: 'Escribe al menos 3 letras.' });
      return json(200, await resolver.searchMatches(texto));
    },

    // (13-11) Fuera /api/clubes, /api/equipos y /api/partidos: eran del enlace «toda la temporada» y
    // de simular cualquier partido jugado. Los ensayos son demos ficticias fijas: no llaman a la API.

    // TODO lo que necesita el widget (directo.html), en una llamada: play by play y acta en crudo
    // (la realización se calcula en el navegador, simulacion.mjs) y, por equipo, nombre, escudo,
    // color, entrenador y fotos por dorsal. Acta sin abrir: pbp/box sin datos y el widget enseña la
    // previa con lo del calendario.
    async '/api/directo'(url) {
      // Solo enlaces de UN partido (Luismi, 13-11): el «enlace por equipo para toda la temporada»
      // (sin `partido`) servía para siempre con un solo enlace, y eso no se quiere por ahora.
      const q = params(url);
      if (!q.partido) return json(410, { error: 'Este enlace ya no vale: busca el partido de hoy en Cancha Abierta TV.' });
      const { row, ownSide, pbp } = await loadMatch(q);
      const box = await cached(`box|${row.IdPartidoNotificacion}`, ROSTER_TTL_MS,
        () => fab.call(ENDPOINTS.boxscore, { id_partido: row.IdPartido, idclublocal: '', idlocal: '' }));
      return json(200, await directo({ row, ownSide, pbp, box }));
    },
  };

  // El JSON del widget a partir de la fila del calendario, el play by play y el acta. Aparte para
  // que las DEMOS (scripts/demo.mjs) salgan del mismo código que el directo.
  async function directo({ row, ownSide, pbp, box }) {
    const board = scoreboardFromPbp(pbp);
    const partido = publicRow(row);
    const side = async (lado) => {
      const isLocal = lado === 'local';
      const roster = rosterFromBoxscore(box, lado);
      const notif = String((isLocal ? pbp?.partido?.idlocal : pbp?.partido?.idvisitante) ?? '');
      const photos = roster?.jugadoras.length
        ? await teamPhotos(isLocal ? row.NombreClubLocal : row.NombreClubVisitante, notif).catch(() => new Map())
        : new Map();
      const fotos = {};
      const club = isLocal ? row.NombreClubLocal : row.NombreClubVisitante;
      await Promise.all((roster?.jugadoras ?? []).map(async (j) => {
        const f = photos.get(personKey(j.nombreCompleto))
          ?? await linkedPhoto(j.nombreCompleto, club).catch(() => null);
        if (f) fotos[j.dorsal] = f;
      }));
      return {
        nombre: isLocal ? partido.local : partido.visitante,
        escudo: isLocal ? partido.escudoLocal : partido.escudoVisitante,
        color: board ? board[lado].color : null,
        entrenador: roster?.entrenador ?? '',
        fotos,
      };
    };
    const [local, visitante] = await Promise.all([side('local'), side('visitante')]);
    return {
      partido, equipoLado: ownSide, local, visitante,
      pbp: pbp?.partido ? pbp : null,
      box: box?.estadisticas ? box : null,
      ahora: Date.now(),
    };
  }

  async function handle(request) {
    const url = new URL(request.url);
    const route = routes[url.pathname];
    if (!route) return json(404, { error: 'No existe.' });
    try {
      return await route(url);
    } catch (err) {
      return json(err?.status ?? 502, { error: err?.message || 'No hay respuesta de los datos del partido.' });
    }
  }
  handle.directo = directo;
  handle.resolver = resolver;
  return handle;
}
