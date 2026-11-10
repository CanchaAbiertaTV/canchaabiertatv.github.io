// La API corre EN EL NAVEGADOR (la web es estática, en GitHub Pages): la FAB contesta con
// Access-Control-Allow-Origin: *, así que cada móvil habla con ella directamente, como la app
// oficial. La identidad del dispositivo (id + key rotativa) se guarda en localStorage; si no hay
// localStorage (algún visor embebido), se da de alta un dispositivo en cada carga y ya.
import { createFabClient } from './fab.mjs';
import { createApi } from './api.mjs';

const KEY = 'marcador-directo:fab';

const store = {
  async load() {
    try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
  },
  async save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* sin almacenamiento */ }
  },
};

const handle = createApi(createFabClient({ store }));

/** Mismo contrato que un fetch a /api/...: devuelve un Response. */
export function api(path, params = {}) {
  const url = new URL(path, 'https://marcador.local');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return handle(new Request(url));
}
