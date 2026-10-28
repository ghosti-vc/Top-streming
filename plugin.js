// Top Streming: lo más visto de las plataformas de streaming, por país.
// Los datos salen de TMDB a través de kino.tmdb (sin ninguna llave en el código):
// se ordena por popularidad (vistas en TMDB) entre los títulos que cada plataforma ofrece en tu país.

const IMG = "https://image.tmdb.org/t/p/w500";
const BACKDROP = "https://image.tmdb.org/t/p/w780";
const STILL = "https://image.tmdb.org/t/p/w300";

const CACHE_MS = 60 * 1000; // el ranking se vuelve a pedir si pasó más de un minuto
const PROVIDERS_MS = 24 * 60 * 60 * 1000; // los ids de plataforma casi no cambian
const PER_ROW = 10;
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
const region = () => String(kino.config.get("region") || "CO");

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
  return {
    id: p.id + "-" + type,
    title: p.name + " · Top " + PER_ROW + " " + label,
    items: toItems(r.results, () => type),
  };
}

async function trendingRow(type) {
  const r = await tmdb("/trending/" + type + "/day", { language: tmdbLang() });
  const movie = type === "movie";
  return {
    id: "tendencias-" + type,
    title: movie
      ? (english() ? "Most watched movies" : "Películas más vistas")
      : (english() ? "Most watched series" : "Series más vistas"),
    items: toItems(r.results, () => type),
  };
}

async function build() {
  // Si fallan los ids de plataforma, igual se muestra la fila de tendencias.
  const ids = await providerIds().catch((e) => {
    kino.log("top-streming: providerIds falló", (e && e.code) || String(e));
    return {};
  });
  const jobs = [trendingRow("movie"), trendingRow("tv")];
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
        kino.log("top-streming: una fila falló", (e && e.code) || "error");
        return null;
      })
    )
  );
  const good = rows.filter((r) => r && r.items.length);
  if (!good.length && firstError) throw firstError;
  return good;
}

// Kino pide el Home al abrirse. Si pasó menos de un minuto desde la última vez, se devuelve lo guardado;
// si pasó más, se vuelve a pedir el ranking a TMDB. Si algo falla, se muestra la última copia buena.
export async function home() {
  await null;
  const scope = region() + ":" + kino.lang;
  const cached = await readJSON("home:" + scope);
  if (cached) return cached;
  try {
    const rows = await build();
    if (!rows.length) throw kino.error("unavailable", "TMDB no devolvió títulos");
    const text = JSON.stringify(rows);
    kino.storage.set("home:" + scope, text, { ttlMs: CACHE_MS });
    kino.storage.set("last:" + scope, text);
    return rows;
  } catch (e) {
    if (e && e.code === "no_tmdb_key") return [];
    kino.log("top-streming: home falló", (e && e.code) || String(e));
    const last = await readJSON("last:" + scope);
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
