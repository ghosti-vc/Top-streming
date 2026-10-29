// Top Streaming - Versión 3 FIX TIMEOUT
const IMG = "https://image.tmdb.org/t/p/w500";
const BACKDROP = "https://image.tmdb.org/t/p/w780";
const STILL = "https://image.tmdb.org/t/p/w300";
const CACHE_MS = 5 * 60 * 1000;
const PER_ROW = 15;
const MAX_SEASONS = 10;

const PLATFORMS = [
  { id: "netflix", name: "Netflix", match: /^netflix$/i },
  { id: "hbo", name: "HBO Max", match: /^(hbo )?max$/i },
  { id: "disney", name: "Disney+", match: /^disney\s?(\+|plus)$/i },
  { id: "prime", name: "Prime Video", match: /^(amazon )?prime video( with ads)?$/i },
  { id: "apple", name: "Apple TV+", match: /^apple tv\s?(\+|plus)?$/i },
  { id: "paramount", name: "Paramount+", match: /^paramount\s?(\+|plus)$/i },
  { id: "hulu", name: "Hulu", match: /^hulu$/i },
];

async function getRegion() {
  try {
    const r = await kino.config.get("region");
    return String(r || "MX").trim().toUpperCase() || "MX";
  } catch { return "MX"; }
}
const english = () => kino.lang === "en-US";
const tmdbLang = () => (english() ? "en-US" : "es-MX");

async function tmdb(path, params) {
  await null;
  if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "kino.tmdb no existe");
  return kino.tmdb(path, params || {});
}

async function readJSON(key) {
  try { const v = await kino.storage.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}

function item(m, type, rank) {
  const tv = type === "tv";
  const title = String(m.title || m.name || "").trim();
  if (!m.id || !title) return null;
  const year = String((tv ? m.first_air_date : m.release_date) || "").slice(0, 4);
  const out = {
    id: (tv ? "t-" : "m-") + m.id,
    ref: JSON.stringify({ kind: tv ? "tv" : "movie", id: m.id }),
    title, kind: tv ? "series" : "movie", ids: { tmdb: m.id },
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

// TIMEOUT HELPER - si TMDB tarda más de 3s, cancela esa fila
function withTimeout(p, ms = 3500) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

async function trendingRows() {
  const r = await withTimeout(tmdb("/trending/all/day", { language: tmdbLang(), page: "1" }));
  const results = r.results || [];
  return [
    { id: "tendencias-movie", title: english() ? "Most watched movies today" : "Películas más vistas hoy", items: toItems(results, (m) => (m.media_type === "movie" ? "movie" : null)) },
    { id: "tendencias-tv", title: english() ? "Most watched series today" : "Series más vistas hoy", items: toItems(results, (m) => (m.media_type === "tv" ? "tv" : null)) },
  ];
}

async function estrenosRow() {
  const region = await getRegion();
  try {
    const r = await withTimeout(tmdb("/movie/now_playing", { language: tmdbLang(), region, page: "1" }));
    return { id: "estrenos", title: english() ? "New releases" : "Estrenos", items: toItems(r.results || [], () => "movie") };
  } catch {
    return { id: "estrenos", title: english() ? "New releases" : "Estrenos", items: [] };
  }
}

async function buildFast() {
  // SOLO 2 LLAMADAS - para no pasar el timeout
  const jobs = [trendingRows(), estrenosRow()];
  const results = await Promise.all(jobs.map(p => p.catch(() => null)));
  const rows = [];
  for (const r of results) {
    if (!r) continue;
    if (Array.isArray(r)) rows.push(...r);
    else if (r.items && r.items.length) rows.push(r);
  }
  return rows;
}

export async function home() {
  await null;
  const region = await getRegion();
  const scope = region + ":" + kino.lang;
  
  // 1. Si hay cache, devuelvelo INSTANTANEO para no hacer timeout
  const cached = await readJSON("home:" + scope);
  if (cached && cached.length) {
    // refresca en background
    buildFast().then(async (rows) => {
      if (rows.length >= 2) {
        await kino.storage.set("home:" + scope, JSON.stringify(rows), { ttlMs: CACHE_MS });
        await kino.storage.set("last:" + scope, JSON.stringify(rows));
      }
    }).catch(()=>{});
    return cached;
  }

  try {
    const rows = await buildFast();
    if (!rows.length) throw kino.error("unavailable", "TMDB sin datos");
    const text = JSON.stringify(rows);
    await kino.storage.set("home:" + scope, text, { ttlMs: CACHE_MS });
    await kino.storage.set("last:" + scope, text);
    return rows;
  } catch (e) {
    const last = await readJSON("last:" + scope);
    if (last && last.length) return last;
    throw e;
  }
}

export async function episodes(ref) {
  await null;
  let r = null;
  try { r = JSON.parse(ref); } catch { r = null; }
  if (!r || r.kind !== "tv" || !r.id) throw kino.error("not_found", "ref inválido");
  const language = tmdbLang();
  const show = await tmdb("/tv/" + r.id, { language });
  const seasons = (show.seasons || []).filter((s) => s.season_number > 0).slice(0, MAX_SEASONS);
  const full = await Promise.all(seasons.map((s) => tmdb("/tv/" + r.id + "/season/" + s.season_number, { language }).catch(() => null)));
  const out = [];
  for (const season of full) {
    if (!season) continue;
    for (const e of season.episodes || []) {
      if (!(e.episode_number >= 1)) continue;
      out.push({
        season: e.season_number, number: e.episode_number,
        ref: JSON.stringify({ kind: "tv", id: r.id, s: e.season_number, e: e.episode_number }),
        title: e.name ? String(e.name) : undefined,
        overview: e.overview ? String(e.overview) : undefined,
        still: e.still_path ? STILL + e.still_path : undefined,
        airDate: /^\d{4}-\d{2}-\d{2}$/.test(e.air_date || "") ? e.air_date : undefined,
        runtimeMinutes: e.runtime >= 1 && e.runtime <= 1000 ? e.runtime : undefined,
      });
    }
  }
  return { series: { title: show.name, overview: show.overview || undefined, ids: { tmdb: r.id } }, episodes: out };
}

export async function resolve(ref) {
  await null;
  throw kino.error("not_found", "catálogo sin video", { userMessage: "Este catálogo no reproduce: busca el título en tus otras fuentes." });
}