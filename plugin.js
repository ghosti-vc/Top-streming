// Top Streaming: lo más visto de las plataformas de streaming, por país.
// Los datos salen de TMDB a través de kino.tmdb (sin ninguna llave en el código):
// se ordena por popularidad (vistas en TMDB) entre los títulos que cada plataforma ofrece en tu país.

const IMG = "https://image.tmdb.org/t/p/w500";
const BACKDROP = "https://image.tmdb.org/t/p/w780";
const STILL = "https://image.tmdb.org/t/p/w300";

const CACHE_MS = 60 * 1000; // el ranking se vuelve a pedir si pasó más de un minuto
const PROVIDERS_MS = 24 * 60 * 60 * 1000; // los ids de plataforma casi no cambian
const PER_ROW = 15;
const MAX_SEASONS = 10;

// Cada plataforma se reconoce por el nombre que le da TMDB en tu país.
const PLATFORMS = [
  { id: "netflix", name: "Netflix", match: /^netflix$/i },
  { id: "hbo", name: "HBO Max", match: /^(hbo )?max$/i },
  { id: "disney", name: "Disney+", match: /^disney\s?(\+|plus)$/i },
  { id: "prime", name: "Prime Video", match: /^(amazon )?prime video( with ads)?$/i },
  { id: "apple", name: "Apple TV+", match: /^apple tv\s?(\+|plus)?$/i },
  { id: "paramount", name: "Paramount+", match: /^paramount\s?(\+|plus)$/i },
  { id: "hulu", name: "Hulu", match: /^hulu$/i },
];

const english = () => kino.lang === "en-US";
const tmdbLang = () => (english() ? "en-US" : "es-MX");
const region = () => String(kino.config.get("region") || "MX").trim().toUpperCase();

// Diagnóstico temporal: guarda los errores para mostrarlos como una fila al final del inicio.
const DEBUG = [];
function dbg(tag, e) {
  const msg = e ? tag + ": " + ((e && e.code) || "error") + " " + String((e && e.message) || "").slice(0, 110) : tag;
  if (!DEBUG.includes(msg) && DEBUG.length < 6) DEBUG.push(msg);
}

async function tmdb(path, params) {
  await null; // primero await, luego validar (Kino 0.9.49 y anteriores)
  if (typeof kino.tmdb !== "function") {
    throw kino.error("unavailable", "kino.tmdb no existe", {
      userMessage: "Actualiza la aplicación para usar este plugin.",
    });
  }
  return kino.tmdb(path, params || {});
}

// Lee y convierte a JSON lo guardado; si algo sale mal devuelve null (nunca rompe).
async function readJSON(key) {
  try {
    const v = await kino.storage.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

// Ids de cada plataforma en el país elegido (guardados un día).
async function providerIds() {
  const key = "providers:" + region();
  const saved = await readJSON(key);
  if (saved) return saved;
  const q = { watch_region: region(), language: tmdbLang() };
  const [movies, shows] = await Promise.all([
    tmdb("/watch/providers/movie", q),
    tmdb("/watch/providers/tv", q),
  ]);
  const all = [].concat(movies.results || [], shows.results || []);
  const found = {};
  for (const p of PLATFORMS) {
    const ids = [];
    for (const x of all) {
      if (p.match.test(String(x.provider_name || "").trim()) && !ids.includes(x.provider_id)) ids.push(x.provider_id);
    }
    if (ids.length) found[p.id] = ids;
  }
  if (Object.keys(found).length) kino.storage.set(key, JSON.stringify(found), { ttlMs: PROVIDERS_MS });
  return found;
}

function item(m, type, rank) {
  const tv = type === "tv";
  const title = String(m.title || m.name || "").trim();
  if (!m.id || !title) return null;
  const year = String((tv ? m.first_air_date : m.release_date) || "").slice(0, 4);
  const out = {
    id: (tv ? "t-" : "m-") + m.id,
    ref: JSON.stringify({ kind: tv ? "tv" : "movie", id: m.id }),
    title,
    kind: tv ? "series" : "movie",
    ids: { tmdb: m.id },
  };
  if (/^\d{4}$/.test(year)) out.year = year;
  if (m.poster_path) out.poster = IMG + m.poster_path;
  if (m.backdrop_path) out.backdrop = BACKDROP + m.backdrop_path;
  if (m.overview) out.overview = String(m.overview);
  if (m.vote_average > 0) out.rating = Math.round(m.vote_average * 10) / 10;
  if (rank) out.badges = ["#" + rank];
  return out;
}

function toItems(results, typeOf) {
  const items = [];
  for (const m of results || []) {
    const type = typeOf(m);
    if (type !== "movie" && type !== "tv") continue;
    const it = item(m, type, items.length + 1);
    if (it) items.push(it);
    if (items.length >= PER_ROW) break;
  }
  return items;
}

// Nombres (de la lista PLATFORMS) que aparecen en una lista "flatrate" de TMDB.
function matchNames(flat) {
  const names = [];
  for (const x of flat || []) {
    const p = PLATFORMS.find((pl) => pl.match.test(String(x.provider_name || "").trim()));
    if (p && !names.includes(p.name)) names.push(p.name);
  }
  return names;
}

// En qué plataformas está un título. Primero en tu país; si TMDB no tiene datos de tu país,
// se busca en otros países y se anota el país entre paréntesis, por ejemplo "Netflix (US)".
async function platformsOf(type, id) {
  const key = "wp2:" + region() + ":" + type + ":" + id;
  const saved = await readJSON(key);
  if (saved) return saved;
  let res = null;
  try {
    const r = await tmdb("/" + type + "/" + id + "/watch/providers", {});
    res = (r && r.results) || {};
  } catch (e) {
    try {
      // ruta alterna: pedir las plataformas junto con los datos del título
      const r = await tmdb("/" + type + "/" + id, { append_to_response: "watch/providers", language: tmdbLang() });
      res = (r && r["watch/providers"] && r["watch/providers"].results) || {};
    } catch (e2) {
      kino.log("top-streaming: sin plataformas", (e2 && e2.code) || "error");
      dbg("plataformas", e2);
      return []; // si falla, no se guarda y el título sale sin plataforma
    }
  }
  let names = matchNames((res[region()] || {}).flatrate);
  if (!names.length) {
    const order = ["US", "MX", "ES", "AR", "GB"].concat(Object.keys(res));
    for (const code of order) {
      if (code === region() || !res[code]) continue;
      const alt = matchNames(res[code].flatrate).map((n) => n + " (" + code + ")");
      if (alt.length) {
        names = alt.slice(0, 2);
        break;
      }
    }
  }
  kino.storage.set(key, JSON.stringify(names), { ttlMs: PROVIDERS_MS });
  return names;
}

// Pone la plataforma al inicio de la descripción de cada título.
async function tagRow(row) {
  await Promise.all(
    row.items.map(async (it) => {
      const type = it.kind === "series" ? "tv" : "movie";
      const names = await platformsOf(type, it.ids.tmdb);
      let label;
      if (!names.length) {
        label = english() ? "No streaming info for your country." : "Sin información de streaming en tu país.";
      } else if (names.every((n) => /\([A-Z]{2}\)$/.test(n))) {
        label = (english() ? "Not streaming in your country. Available in: " : "No está en streaming en tu país. Disponible en: ") + names.join(", ");
      } else {
        label = (english() ? "Streaming on: " : "Disponible en: ") + names.join(", ");
      }
      it.overview = label + (it.overview ? "\n\n" + it.overview : "");
    })
  );
  return row;
}

// Top 10 de K-dramas (series surcoreanas). Si "discover" no está disponible, se filtran las tendencias.
async function kdramaRow() {
  const language = tmdbLang();
  let results = [];
  // Solo K-dramas que están en las plataformas de tu país (suelen traer doblaje latino).
  const ids = await providerIds().catch(() => ({}));
  const all = [].concat(...Object.values(ids));
  try {
    const r = await tmdb("/discover/tv", {
      with_original_language: "ko",
      with_origin_country: "KR",
      with_genres: "18",
      ...(all.length
        ? { watch_region: region(), with_watch_providers: all.join("|"), with_watch_monetization_types: "flatrate" }
        : {}),
      sort_by: "popularity.desc",
      include_adult: "false",
      language,
      page: "1",
    });
    results = r.results || [];
  } catch (e) {
    kino.log("top-streaming: discover de K-dramas falló", (e && e.code) || "error");
  }
  if (!results.length) {
    const pages = await Promise.all(
      ["1", "2", "3", "4", "5"].map((page) => tmdb("/trending/all/day", { language, page }).catch(() => null))
    );
    for (const r of pages) {
      for (const m of (r && r.results) || []) {
        if (m.media_type === "tv" && m.original_language === "ko") results.push(m);
      }
    }
  }
  const row = {
    id: "kdramas",
    title: "Top " + PER_ROW + " K-dramas",
    items: toItems(results, () => "tv"),
  };
  if (!row.items.length) throw kino.error("unavailable", "no hay K-dramas");
  return tagRow(row);
}

// Estrenos: películas que están en cines ahora en tu país (si falla, las más populares de los últimos 45 días).
async function estrenosRow() {
  const language = tmdbLang();
  const today = new Date().toISOString().slice(0, 10);
  let results = [];
  try {
    const r = await tmdb("/movie/now_playing", { language, region: region(), page: "1" });
    results = (r.results || []).filter((m) => !m.release_date || m.release_date <= today);
  } catch (e) {
    kino.log("top-streaming: now_playing falló", (e && e.code) || "error");
  }
  if (!results.length) {
    const from = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r = await tmdb("/discover/movie", {
      "primary_release_date.gte": from,
      "primary_release_date.lte": today,
      sort_by: "popularity.desc",
      include_adult: "false",
      language,
      page: "1",
    });
    results = r.results || [];
  }
  results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const row = {
    id: "estrenos",
    title: english() ? "New releases" : "Estrenos",
    items: toItems(results, () => "movie"),
  };
  if (!row.items.length) throw kino.error("unavailable", "no hay estrenos");
  return tagRow(row);
}

// Estrenos solo de Netflix (dos filas: películas y series) de los últimos 60 días que están en Netflix en tu país.
const NETFLIX_ID = "8"; // id de Netflix en TMDB (no cambia)
async function netflixNewRow() {
  const language = tmdbLang();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 60 * day).toISOString().slice(0, 10);
  const base = {
    watch_region: region(),
    with_watch_providers: NETFLIX_ID,
    with_watch_monetization_types: "flatrate",
    sort_by: "popularity.desc",
    include_adult: "false",
    language,
    page: "1",
  };
  const [movies, shows] = await Promise.all([
    tmdb("/discover/movie", Object.assign({}, base, { "primary_release_date.gte": from, "primary_release_date.lte": today })).catch(() => null),
    tmdb("/discover/tv", Object.assign({}, base, { "first_air_date.gte": from, "first_air_date.lte": today })).catch(() => null),
  ]);
  const label = (english() ? "Streaming on: " : "Disponible en: ") + "Netflix";
  const make = (list, type, id, title) => {
    const sorted = (list || []).slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    const items = toItems(sorted, () => type);
    for (const it of items) it.overview = label + (it.overview ? "\n\n" + it.overview : "");
    return { id, title, items };
  };
  const rows = [
    make(movies && movies.results, "movie", "netflix-estrenos-movie", english() ? "New on Netflix · Movies" : "Estrenos en Netflix · Películas"),
    make(shows && shows.results, "tv", "netflix-estrenos-tv", english() ? "New on Netflix · Series" : "Estrenos en Netflix · Series"),
  ].filter((r) => r.items.length);
  if (!rows.length) throw kino.error("unavailable", "no hay estrenos de Netflix");
  return rows;
}

// Estrenos (últimos 60 días) de HBO, Prime Video, Disney y Apple TV: dos filas por plataforma (películas y series).
const NEW_ON = ["hbo", "prime", "disney", "apple"];
async function newRows(p, ids) {
  const language = tmdbLang();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 60 * day).toISOString().slice(0, 10);
  const base = {
    watch_region: region(),
    with_watch_providers: ids.join("|"),
    with_watch_monetization_types: "flatrate",
    sort_by: "popularity.desc",
    include_adult: "false",
    language,
    page: "1",
  };
  const [movies, shows] = await Promise.all([
    tmdb("/discover/movie", Object.assign({}, base, { "primary_release_date.gte": from, "primary_release_date.lte": today })).catch(() => null),
    tmdb("/discover/tv", Object.assign({}, base, { "first_air_date.gte": from, "first_air_date.lte": today })).catch(() => null),
  ]);
  const label = (english() ? "Streaming on: " : "Disponible en: ") + p.name;
  const make = (list, type, id, title) => {
    const sorted = (list || []).slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    const items = toItems(sorted, () => type);
    for (const it of items) it.overview = label + (it.overview ? "\n\n" + it.overview : "");
    return { id, title, items };
  };
  const rows = [
    make(movies && movies.results, "movie", p.id + "-estrenos-movie", english() ? "New on " + p.name + " · Movies" : "Estrenos en " + p.name + " · Películas"),
    make(shows && shows.results, "tv", p.id + "-estrenos-tv", english() ? "New on " + p.name + " · Series" : "Estrenos en " + p.name + " · Series"),
  ].filter((r) => r.items.length);
  if (!rows.length) throw kino.error("unavailable", "no hay estrenos de " + p.name);
  return rows;
}

async function platformRow(p, type, ids) {
  const r = await tmdb("/discover/" + type, {
    watch_region: region(),
    with_watch_providers: ids.join("|"),
    with_watch_monetization_types: "flatrate",
    sort_by: "popularity.desc",
    include_adult: "false",
    language: tmdbLang(),
    page: "1",
  });
  const label = type === "movie" ? (english() ? "movies" : "películas") : "series";
  const items = toItems(r.results, () => type);
  for (const it of items) {
    it.badges = [p.name].concat(it.badges || []);
    const label = (english() ? "Streaming on: " : "Disponible en: ") + p.name;
    it.overview = label + (it.overview ? "\n\n" + it.overview : "");
  }
  return {
    id: p.id + "-" + type,
    title: p.name + " · Top " + PER_ROW + " " + label,
    items,
  };
}

// Usa la misma ruta que ya funcionaba (/trending/all/day) y la separa en dos filas.
async function trendingRows() {
  const pages = await Promise.all(
    ["1", "2", "3"].map((page) =>
      tmdb("/trending/all/day", { language: tmdbLang(), page }).catch(() => null)
    )
  );
  const results = [];
  for (const r of pages) if (r && r.results) results.push(...r.results);
  if (!results.length) throw kino.error("unavailable", "TMDB no devolvió tendencias");
  const rows = [
    {
      id: "tendencias-movie",
      title: english() ? "Most watched movies today" : "Películas más vistas hoy",
      items: toItems(results, (m) => (m.media_type === "movie" ? "movie" : null)),
    },
    {
      id: "tendencias-tv",
      title: english() ? "Most watched series today" : "Series más vistas hoy",
      items: toItems(results, (m) => (m.media_type === "tv" ? "tv" : null)),
    },
  ];
  await Promise.all(rows.map(tagRow));
  return rows;
}

async function build() {
  // Si fallan los ids de plataforma, igual se muestra la fila de tendencias.
  DEBUG.length = 0;
  const ids = await providerIds().catch((e) => {
    kino.log("top-streaming: providerIds falló", (e && e.code) || String(e));
    return {};
  });
  const jobs = [trendingRows(), estrenosRow(), netflixNewRow(), kdramaRow()];
  for (const p of PLATFORMS) {
    if (!ids[p.id]) continue; // esa plataforma no existe en este país
    jobs.push(platformRow(p, "movie", ids[p.id]));
    jobs.push(platformRow(p, "tv", ids[p.id]));
  }
  let firstError = null;
  const rows = await Promise.all(
    jobs.map((job) =>
      job.catch((e) => {
        if (!firstError) firstError = e;
        kino.log("top-streaming: una fila falló", (e && e.code) || "error");
        dbg("fila", e);
        return null;
      })
    )
  );
  // Estrenos de HBO, Prime Video, Disney y Apple TV: se piden después de lo principal y con límite de tiempo.
  // Si tardan o fallan, se omiten y el resto del Inicio carga igual.
  const timeout = (ms) =>
    typeof setTimeout === "function"
      ? new Promise((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), ms))
      : new Promise(() => {});
  const more = await Promise.all(
    PLATFORMS.filter((p) => NEW_ON.includes(p.id) && ids[p.id]).map((p) =>
      Promise.race([newRows(p, ids[p.id]), timeout(10000)]).catch((e) => {
        kino.log("top-streaming: estrenos falló", p.id, (e && e.code) || "error");
        dbg("estrenos " + p.id, e);
        return null;
      })
    )
  );
  // Orden: tendencias, estrenos, Netflix nuevo, K-dramas, estrenos de las otras plataformas y luego los Top de cada una.
  const ordered = rows.slice(0, 4).concat(more, rows.slice(4));
  const good = [].concat(...ordered.map((r) => (Array.isArray(r) ? r : [r]))).filter((r) => r && r.items && r.items.length);
  if (!good.length && firstError) throw firstError;
  return good;
}

// Kino pide el Home al abrirse. Si pasó menos de un minuto desde la última vez, se devuelve lo guardado;
// si pasó más, se vuelve a pedir el ranking a TMDB. Si algo falla, se muestra la última copia buena.
export async function home() {
  await null;
  const scope = "v2:" + region() + ":" + kino.lang;
  const lastKey = "last:" + region() + ":" + kino.lang; // misma clave de antes: sirve de respaldo
  const cached = await readJSON("home:" + scope);
  if (cached) return cached;
  try {
    const rows = await build();
    if (!rows.length) throw kino.error("unavailable", "TMDB no devolvió títulos");
    const text = JSON.stringify(rows);
    kino.storage.set("home:" + scope, text, { ttlMs: CACHE_MS });
    kino.storage.set(lastKey, text);
    return rows;
  } catch (e) {
    if (e && e.code === "no_tmdb_key") return [];
    kino.log("top-streaming: home falló", (e && e.code) || String(e));
    const last = await readJSON(lastKey);
    if (last) return last;
    throw e;
  }
}

// Las series necesitan "episodes" para que Kino no las descarte; se arma con las temporadas de TMDB.
export async function episodes(ref) {
  await null;
  let r = null;
  try {
    r = JSON.parse(ref);
  } catch (e) {
    r = null;
  }
  if (!r || r.kind !== "tv" || !r.id) throw kino.error("not_found", "ref inválido");
  const language = tmdbLang();
  const show = await tmdb("/tv/" + r.id, { language });
  const seasons = (show.seasons || []).filter((s) => s.season_number > 0).slice(0, MAX_SEASONS);
  const full = await Promise.all(
    seasons.map((s) => tmdb("/tv/" + r.id + "/season/" + s.season_number, { language }).catch(() => null))
  );
  const out = [];
  for (const season of full) {
    if (!season) continue;
    for (const e of season.episodes || []) {
      if (!(e.episode_number >= 1)) continue;
      const ep = {
        season: e.season_number,
        number: e.episode_number,
        ref: JSON.stringify({ kind: "tv", id: r.id, s: e.season_number, e: e.episode_number }),
      };
      if (e.name) ep.title = String(e.name);
      if (e.overview) ep.overview = String(e.overview);
      if (e.still_path) ep.still = STILL + e.still_path;
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.air_date || "")) ep.airDate = e.air_date;
      if (e.runtime >= 1 && e.runtime <= 1000) ep.runtimeMinutes = e.runtime;
      out.push(ep);
    }
  }
  return {
    series: { title: show.name, overview: show.overview || undefined, ids: { tmdb: r.id } },
    episodes: out,
  };
}

// Solo lo llama un Kino 0.9.53 o anterior: de 0.9.54 en adelante "catalogOnly" manda al usuario a sus otras fuentes.
export async function resolve(ref) {
  await null;
  throw kino.error("not_found", "catálogo sin video", {
    userMessage: "Este catálogo no reproduce: busca el título en tus otras fuentes.",
  });
}
