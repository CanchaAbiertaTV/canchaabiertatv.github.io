// Cliente de la API de la FAB (la de la app «Afición FAB»). Solo usa `fetch`, así que corre
// igual en Node que en un Worker de Cloudflare.
//
// CÓMO FUNCIONA LA SESIÓN (aprendido en AND Scout, aquí copiado y simplificado):
//   · Un DISPOSITIVO se da de alta una vez (dispositivo.ashx?accion=registrar, con un uid
//     nuevo) y la FAB devuelve { idDispositivo, key }.
//   · La KEY ROTA: cada respuesta trae la siguiente. Hay que guardar siempre la última.
//   · Si la key envejece, la FAB NO da un 401: responde `resultado: "error"` como si no hubiera
//     datos. Por eso, ante un "error", se pide un acceso nuevo (accion=acceso) y se reintenta
//     UNA vez, solo si la key cambió de verdad.
//   · Los ids cifrados (IdPartido, Id de equipo…) van LIGADOS a la sesión. Por eso los enlaces
//     del marcador llevan ids estables (ver resolver.mjs), nunca un IdPartido.

const DEVICE_URL = 'https://appaficionfab.gesdeportiva.es/dispositivo.ashx';
const API = 'https://appaficion.andaluzabaloncesto.org/v2';

export const ENDPOINTS = {
  playByPlay: `${API}/envivo/partido.ashx`,
  boxscore: `${API}/envivo/estadisticas.ashx`,
  buscarClub: `${API}/busqueda.ashx?accion=buscarClub`,
  buscarJugador: `${API}/busqueda.ashx?accion=buscarJugador`,
  club: `${API}/club.ashx`,
  fasesGrupos: `${API}/equipo.ashx?accion=fasesGrupos`,
  calendario: `${API}/equipo.ashx?accion=horariosJornadas`,
  jugadores: `${API}/equipo.ashx?accion=jugadores`,
};

// Escudos y fotos: GET simple con el token que da la PROPIA sesión (ImgEquipoLocal, Foto…).
// Contesta con Access-Control-Allow-Origin: *. Una jugadora sin foto devuelve un avatar SVG.
export function imageUrl(tipo, token) {
  const t = String(token ?? '').trim();
  return t ? `https://appaficionfab.gesdeportiva.es/imagenes.ashx?tipo=${tipo}&id=${encodeURIComponent(t)}` : null;
}

const DEVICE_DEFAULTS = {
  plataforma: 'android',
  tipo_dispositivo: 'mobile',
  token_push: '',
  version: '50014',
};

// SOLO Content-Type de formulario: así la petición es «simple» para el navegador (sin preflight;
// el OPTIONS de la FAB da 405) y la FAB contesta con Access-Control-Allow-Origin: *. Las
// cabeceras de la app oficial (X-Requested-With, User-Agent…) no hacen falta (probado 07-11-26).
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

const REFRESH_MIN_INTERVAL_MS = 30_000;

function randomUid() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// POST de formulario. Los parámetros de la query de la URL viajan TAMBIÉN en el cuerpo
// (así lo hace la app oficial).
async function post(url, params) {
  const target = new URL(url);
  const body = new URLSearchParams();
  for (const [k, v] of target.searchParams) body.set(k, v);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  const res = await fetch(target, { method: 'POST', headers: HEADERS, body: body.toString() });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isRejection = (payload) => String(payload?.resultado ?? '').trim().toLowerCase() === 'error';

/**
 * Sesión con la FAB. `store` (opcional) guarda la identidad entre arranques:
 *   { load(): Promise<{idDispositivo, key}|null>, save({idDispositivo, key}): Promise<void> }
 */
export function createFabClient({ store = null } = {}) {
  let state = { idDispositivo: '', key: '' };
  let loaded = false;
  let bootstrapping = null;
  let lastRefresh = 0;

  async function persist() {
    if (store) await store.save({ ...state }).catch(() => {});
  }

  function absorb(payload) {
    const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
    const dev = String(payload?.idDispositivo ?? payload?.id_dispositivo ?? '').trim();
    let changed = false;
    if (key && key !== state.key) { state.key = key; changed = true; }
    if (dev && dev !== state.idDispositivo) { state.idDispositivo = dev; changed = true; }
    return changed;
  }

  async function register() {
    const payload = await post(`${DEVICE_URL}?accion=registrar`, { ...DEVICE_DEFAULTS, uid: randomUid() });
    absorb(payload);
  }

  async function access() {
    const payload = await post(`${DEVICE_URL}?accion=acceso`, {
      ...DEVICE_DEFAULTS,
      uid: '',
      id_dispositivo: state.idDispositivo,
      key: state.key,
    });
    absorb(payload);
  }

  // Garantiza identidad + key. Las llamadas simultáneas comparten el mismo arranque: dos altas
  // a la vez serían dos dispositivos distintos.
  async function ensure() {
    if (!loaded) {
      loaded = true;
      const saved = store ? await store.load().catch(() => null) : null;
      if (saved?.idDispositivo) state = { idDispositivo: saved.idDispositivo, key: saved.key ?? '' };
    }
    if (state.idDispositivo && state.key) return;
    if (!bootstrapping) {
      bootstrapping = (async () => {
        if (state.idDispositivo) await access();
        if (!state.key) await register();
        await persist();
      })().finally(() => { bootstrapping = null; });
    }
    await bootstrapping;
    if (!state.idDispositivo || !state.key) throw new Error('No se ha podido abrir sesión con los datos del partido.');
  }

  // Acceso nuevo (key fresca). Devuelve true si la key CAMBIÓ: si no cambia, el "error" era
  // del dato y reintentar solo gastaría otra petición.
  async function refresh() {
    if (Date.now() - lastRefresh < REFRESH_MIN_INTERVAL_MS) return false;
    lastRefresh = Date.now();
    const before = state.key;
    await access().catch(() => {});
    if (!state.key || state.key === before) {
      // El dispositivo puede haber caducado: alta nueva.
      await register().catch(() => {});
    }
    await persist();
    return Boolean(state.key) && state.key !== before;
  }

  async function call(url, params = {}) {
    await ensure();
    const send = () => post(url, { ...params, id_dispositivo: state.idDispositivo, key: state.key });
    let payload = await send();
    if (isRejection(payload) && (await refresh())) {
      payload = await send();
    }
    if (absorb(payload)) await persist();
    return payload;
  }

  return {
    call,
    ensure,
    refresh,
    /** Solo para diagnóstico: longitudes, nunca los valores. */
    describe: () => ({ dispositivo: state.idDispositivo.length, key: state.key.length }),
  };
}
