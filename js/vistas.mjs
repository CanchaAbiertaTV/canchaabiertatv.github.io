// HTML de cada pantalla del widget. Funciones puras: datos → texto HTML (sin DOM).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (src, cls = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="" onerror="this.remove()">` : '');
const pct = ([m, a]) => (a ? `${Math.round((m / a) * 100)}%` : '–');
const ma = ([m, a]) => `${m}/${a}`;

function pips(n, total, cls) {
  let html = `<span class="pips ${cls}">`;
  for (let i = 0; i < total; i += 1) html += `<span class="pip${i < n ? ' is-on' : ''}"></span>`;
  return `${html}</span>`;
}

function crest(team, cls = 'crest') {
  return team.escudo ? `<span class="${cls}">${img(team.escudo)}</span>` : '';
}

function photo(team, p, cls = 'photo') {
  const src = team.fotos?.[p.dorsal];
  return `<span class="${cls}">${src ? img(src) : esc((p.nombre || '?').charAt(0))}</span>`;
}

const fullName = (p) => `<b>${esc(p.nombre)}</b> <span>${esc(p.apellidos)}</span>`;

// ── Marcador ────────────────────────────────────────────────────────────────
// teams: { local, visitante } con { corto, color, escudo }; m: scoreboardFromPbp o null (previa).
export function marcadorHtml({ teams, m, previaHora }) {
  const team = (side) => {
    const t = teams[side];
    const d = m?.[side];
    const enJuego = m && (m.fase === 'juego' || m.fase === 'descanso');
    const meta = enJuego
      ? `<span>FALTAS</span>${pips(Math.min(5, d.faltas ?? 0), 5, 'pips--fouls')}${d.bonus ? '<span class="bonus">BONUS</span>' : ''}`
        + (d.tiempos != null ? `<span>T. M.</span>${pips(d.tiempos, d.tiemposMax || 3, 'pips--to')}` : '')
      : '';
    // Nombres largos: letra algo menor y DOS filas, nunca «…» (Luismi, 07-11).
    const long = t.corto.length > 26 ? ' is-long' : t.corto.length > 16 ? ' is-mid' : '';
    return `
      <div class="sb-team" style="--team-color:${t.color};--team-ink:${t.ink}">
        <div class="sb-stripe"></div>
        ${crest(t, 'sb-crest')}
        <div class="sb-info"><div class="sb-name${long}">${esc(t.corto)}</div>${meta ? `<div class="sb-meta">${meta}</div>` : ''}</div>
        <div class="sb-score" data-score="${side}">${!m || m.fase === 'previa' ? '0' : esc(d.puntos)}</div>
      </div>`;
  };
  let period = 'PREVIA';
  let sub = previaHora ? `${esc(previaHora)} H` : '&nbsp;';
  let fase = 'previa';
  if (m && m.fase !== 'previa') {
    fase = m.fase;
    period = esc(m.periodoTexto);
    sub = m.fase === 'juego' ? `<span class="live-dot"></span>${m.minuto != null ? `MIN ${m.minuto + 1}` : 'EN JUEGO'}` : '&nbsp;';
  }
  return `${team('local')}${team('visitante')}
    <div class="sb-clock" data-fase="${fase}"><div class="sb-period">${period}</div><div class="sb-sub">${sub}</div></div>`;
}

// ── Última acción ───────────────────────────────────────────────────────────
// Con la FOTO de la jugadora y «(EQUIPO)» detrás del nombre; el escudo, solo en los tiempos muertos
// (Luismi, 07-11).
// compacto: el rótulo va ENCIMA de la mitad del marcador de su equipo (uno por equipo): sin
// minuto (ya está en el marcador) ni «(EQUIPO)» (ya lo dice el sitio).
export function tickerHtml({ accion, teams, compacto = false }) {
  const t = accion.side ? teams[accion.side] : null;
  if (compacto) {
    let foto = '';
    if (t && accion.tipo === 'TIEMPO-MUERTO-SOLICITADO') foto = crest(t, 'tk-crest');
    else if (t && accion.deJugadora && t.fotos?.[accion.dorsal]) foto = `<span class="tk-photo">${img(t.fotos[accion.dorsal])}</span>`;
    // «(12 PTS)» / «(3 FAL)» aparte: si el nombre no cabe, se corta el nombre, nunca la cifra.
    // Faltas: en aviso a partir de 4 (como en las listas).
    const [, texto, n, que] = /^(.*) \((\d+) (PTS|FAL)\)$/.exec(accion.texto) ?? [null, accion.texto, null, null];
    const cls = que === 'FAL' ? `tk-pts tk-pts--fal${Number(n) >= 4 ? ' is-warn' : ''}` : 'tk-pts';
    return `<span class="tk-body" style="--team-color:${t?.color ?? '#5b6070'}">${foto}<span class="tk-text">${esc(texto)}</span>${n ? `<span class="${cls}">${n} ${que}</span>` : ''}</span>`;
  }
  const when = [accion.periodoTexto, accion.quedan].filter(Boolean).join(' · ');
  let media = '';
  if (t && accion.tipo === 'TIEMPO-MUERTO-SOLICITADO') media = crest(t, 'tk-crest');
  else if (t && accion.deJugadora && t.fotos?.[accion.dorsal]) media = `<span class="tk-photo">${img(t.fotos[accion.dorsal])}</span>`;
  const equipo = t && (accion.deJugadora || accion.tipo === 'TIEMPO-MUERTO-SOLICITADO') ? ` <span class="tk-team">(${esc(t.corto)})</span>` : '';
  return `
    <span class="tk-when">${esc(when)}</span>
    <span class="tk-body" style="--team-color:${t?.color ?? '#5b6070'}">
      ${media}<span class="tk-text">${esc(accion.texto)}${equipo}</span>
    </span>`;
}

// ── Plantillas (antes del salto) ────────────────────────────────────────────
export function plantillasHtml({ teams, roster, categoria }) {
  // Sitio para 12 inscritas como mínimo (lo normal): foto CUADRADA del mismo tamaño en los dos
  // equipos, calculada con el alto de la lista entre las filas (Luismi, 09-11).
  const filas = Math.max(12, roster.local.length, roster.visitante.length);
  const col = (side) => {
    const t = teams[side];
    const rows = roster[side].map((p, i) => `
      <li style="animation-delay:${150 + i * 40}ms">
        ${photo(t, p)}<span class="dorsal">${esc(p.dorsal)}</span>
        <span class="who">${fullName(p)}</span><span class="tag">${p.capitana ? 'CAP.' : ''}</span>
      </li>`).join('');
    return `
      <section class="card" style="--team-color:${t.color};--team-ink:${t.ink}">
        <header class="card__head">${crest(t)}<span class="card__name">${esc(t.nombre)}</span></header>
        <ul class="list list--roster" style="--rows:${filas}">${rows || '<li class="empty">Plantilla todavía sin publicar.</li>'}</ul>
        ${t.entrenador ? `<footer class="coach"><span class="tag">ENTRENADOR</span><b>${esc(t.entrenador)}</b></footer>` : ''}
      </section>`;
  };
  return `<div class="title">PLANTILLAS${categoria ? ` <span>·</span> ${esc(categoria)}` : ''}</div>
    <div class="cols">${col('local')}${col('visitante')}</div>`;
}

// ── Las 10 en pista: al empezar un cuarto, en un tiempo muerto y entre cuartos ──
// Con el partido empezado, cada una con sus puntos y faltas (y rebotes si la liga los apunta);
// en el salto inicial, sin números: serían todo ceros (Luismi, 09-11).
export function enPistaHtml({ teams, enPista, titulo, stats = true, detalle = false }) {
  const cols = detalle ? 3 : 2;
  const col = (side) => {
    const t = teams[side];
    const heads = stats ? `<span class="heads heads--${cols}"><span>PTS</span>${detalle ? '<span>REB</span>' : ''}<span>FAL</span></span>` : '';
    return `
      <section class="card" style="--team-color:${t.color};--team-ink:${t.ink}">
        <header class="card__head">${crest(t)}<span class="card__name">${esc(t.corto)}</span>${heads}</header>
        <ul class="list list--five">${enPista[side].map((p) => `
          <li${stats ? ' class="with-stats"' : ''}>${photo(t, p)}<span class="dorsal">${esc(p.dorsal)}</span><span class="who">${fullName(p)}</span>${stats
            ? `<span class="nums nums--${cols}"><span>${p.pts}</span>${detalle ? `<span>${p.reb}</span>` : ''}<span class="${p.fal >= 4 ? 'warn' : ''}">${p.fal}</span></span>`
            : ''}</li>`).join('')}
        </ul>
      </section>`;
  };
  return `<div class="title">${titulo}</div><div class="cols">${col('local')}${col('visitante')}</div>`;
}

// ── Estadísticas de las dos plantillas ──────────────────────────────────────
export function estadisticasHtml({ teams, jugadoras, detalle, momento }) {
  const col = (side) => {
    const t = teams[side];
    const head = detalle
      ? '<span>PTS</span><span>T2</span><span>T3</span><span>TL</span><span>REB</span><span>AST</span><span>FAL</span>'
      : '<span>PTS</span><span>T2</span><span>T3</span><span>TL</span><span>FAL</span>';
    const rows = jugadoras[side].map((p) => {
      const cells = detalle
        ? [p.pts, ma(p.t2), ma(p.t3), ma(p.t1), p.reb, p.ast, p.fal]
        : [p.pts, p.t2[0], p.t3[0], ma(p.t1), p.fal];
      return `<li class="stat-row"><span class="dorsal">${esc(p.dorsal)}</span><span class="who">${fullName(p)}</span>
        <span class="nums nums--${detalle ? 7 : 5}">${cells.map((c) => `<span>${esc(c)}</span>`).join('')}</span></li>`;
    }).join('');
    return `
      <section class="card" style="--team-color:${t.color};--team-ink:${t.ink}">
        <header class="card__head">${crest(t)}<span class="card__name">${esc(t.corto)}</span>
          <span class="heads heads--${detalle ? 7 : 5}">${head}</span></header>
        <ul class="list list--dense">${rows}</ul>
      </section>`;
  };
  return `<div class="title">ESTADÍSTICAS <span>·</span> ${esc(momento)}</div><div class="cols">${col('local')}${col('visitante')}</div>`;
}

// ── Comparativa de los equipos ──────────────────────────────────────────────
export function comparativaHtml({ teams, team, detalle, momento, score }) {
  const L = team.local;
  const V = team.visitante;
  const rows = [
    ['Puntos', score.local, score.visitante],
    ...(detalle
      ? [
        ['Tiros de 2', `${ma(L.t2)} · ${pct(L.t2)}`, `${ma(V.t2)} · ${pct(V.t2)}`, L.t2[0], V.t2[0]],
        ['Triples', `${ma(L.t3)} · ${pct(L.t3)}`, `${ma(V.t3)} · ${pct(V.t3)}`, L.t3[0], V.t3[0]],
        ['Tiros libres', `${ma(L.t1)} · ${pct(L.t1)}`, `${ma(V.t1)} · ${pct(V.t1)}`, L.t1[0], V.t1[0]],
        ['Rebotes', `${L.reb} (${L.ro} of.)`, `${V.reb} (${V.ro} of.)`, L.reb, V.reb],
        ['Asistencias', L.ast, V.ast],
        ['Pérdidas', L.perd, V.perd],
        ['Recuperaciones', L.rec, V.rec],
        ['Tapones', L.tap, V.tap],
      ]
      // Liga sin fallos de campo ni rebotes: canastas (no hay intentos) y libres (esos sí).
      : [
        ['Canastas de 2', L.t2[0], V.t2[0]],
        ['Triples', L.t3[0], V.t3[0]],
        ['Tiros libres', `${ma(L.t1)} · ${pct(L.t1)}`, `${ma(V.t1)} · ${pct(V.t1)}`, L.t1[0], V.t1[0]],
      ]),
    ['Faltas', L.fal, V.fal],
  ];
  const body = rows.map(([label, a, b, na = a, nb = b]) => {
    const total = (Number(na) || 0) + (Number(nb) || 0);
    const wa = total ? Math.round(((Number(na) || 0) / total) * 100) : 50;
    return `<li class="cmp-row">
      <span class="cmp-val">${esc(a)}</span>
      <span class="cmp-mid"><span class="cmp-label">${esc(label)}</span>
        <span class="cmp-bar"><span style="width:${wa}%;background:${teams.local.color}"></span><span style="width:${100 - wa}%;background:${teams.visitante.color}"></span></span></span>
      <span class="cmp-val">${esc(b)}</span></li>`;
  }).join('');
  return `<div class="title">COMPARATIVA <span>·</span> ${esc(momento)}</div>
    <section class="card card--wide">
      <header class="cmp-head">
        <span class="cmp-team">${crest(teams.local)}<span>${esc(teams.local.corto)}</span></span>
        <span class="cmp-team cmp-team--right"><span>${esc(teams.visitante.corto)}</span>${crest(teams.visitante)}</span>
      </header>
      <ul class="list">${body}</ul>
    </section>`;
}

// ── Líderes de cada equipo ──────────────────────────────────────────────────
export function lideresHtml({ teams, lideres, momento }) {
  const cats = [['puntos', 'PUNTOS'], ['rebotes', 'REBOTES'], ['asistencias', 'ASISTENCIAS'], ['recuperaciones', 'RECUPERACIONES']];
  const col = (side) => {
    const t = teams[side];
    const cards = cats.map(([k, label]) => {
      const p = lideres[side][k];
      return `<li class="leader">${p ? `${photo(t, p, 'photo photo--big')}<span class="who"><span class="tag">${label}</span>${fullName(p)}</span><span class="leader__val">${p.valor}</span>`
        : `<span class="photo photo--big">–</span><span class="who"><span class="tag">${label}</span><span>Nadie todavía</span></span><span class="leader__val">0</span>`}</li>`;
    }).join('');
    return `<section class="card" style="--team-color:${t.color};--team-ink:${t.ink}">
      <header class="card__head">${crest(t)}<span class="card__name">${esc(t.corto)}</span></header>
      <ul class="list list--four">${cards}</ul></section>`;
  };
  return `<div class="title">LÍDERES <span>·</span> ${esc(momento)}</div><div class="cols">${col('local')}${col('visitante')}</div>`;
}
