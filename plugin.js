// Top Streaming - V4 Anti-Cuelgue WINIA
const IMG = "https://image.tmdb.org/t/p/w500";
const BACKDROP = "https://image.tmdb.org/t/p/w780";
const STILL = "https://image.tmdb.org/t/p/w300";
const CACHE_MS = 5 * 60 * 1000;
const PER_ROW = 15;

function safeRegionSync() {
  try {
    // Intento sync rápido, si es Promise lo ignoramos
    const v = kino.config.get("region");
    if (typeof v === "string" && v.length) return v.toUpperCase();
  } catch {}
  return "MX";
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
  const title = String(m.title || m.name || "").trim();
  if (!m.id || !title) return null;
  return {
    id: (type === "tv" ? "t-" : "m-") + m.id,
    ref: JSON.stringify({ kind: type === "tv" ? "tv" : "movie", id: m.id }),
    title, kind: type === "tv" ? "series" : "movie",
    ids: { tmdb: m.id },
    poster: m.poster_path ? IMG + m.poster_path : undefined,
    backdrop: m.backdrop_path ? BACKDROP + m.backdrop_path : undefined,
    overview: m.overview ? String(m.overview) : undefined,
    rating: m.vote_average > 0 ? Math.round(m.vote_average * 10) / 10 : undefined,
    badges: rank ? ["#" + rank] : undefined,
  };
}
function toItems(results, type) {
  const items = [];
  for (const m of results || []) {
    const it = item(m, type, items.length + 1);
    if (it) items.push(it);
    if (items.length >= PER_ROW) break;
  }
  return items;
}
function timeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-" + label)), ms))
  ]);
}

async function buildUltraFast() {
  const region = safeRegionSync();
  const lang = tmdbLang();
  try {
    // UNA SOLA LLAMADA, 3 segundos máximo
    const r = await timeout(tmdb("/trending/all/day", { language: lang, page: "1" }), 3000, "trending");
    const res = r.results || [];
    const movies = res.filter(x => x.media_type === "movie");
    const tv = res.filter(x => x.media_type === "tv");
    return [
      { id: "tend-movie", title: english() ? "Most watched movies today" : "Películas más vistas hoy", items: toItems(movies, "movie") },
      { id: "tend-tv", title: english() ? "Most watched series today" : "Series más vistas hoy", items: toItems(tv, "tv") },
    ].filter(x => x.items.length);
  } catch (e) {
    kino.log("top-streaming fast fail: " + String(e));
    return [];
  }
}

function fallbackRows() {
  return [
    {
      id: "offline-movie",
      title: english() ? "Most watched movies today" : "Películas más vistas hoy (offline)",
      items: [
        { id: "m-1", ref: JSON.stringify({ kind: "movie", id: 550 }), title: "Cargando...", kind: "movie", ids: { tmdb: 550 }, overview: "Reintentando conexión con TMDB..." }
      ]
    }
  ];
}

export async function home() {
  await null;
  const region = safeRegionSync();
  const scope = region + ":" + (kino.lang || "es-MX");

  try {
    const cached = await timeout(readJSON("home:" + scope), 800, "cache");
    if (cached && Array.isArray(cached) && cached.length) {
      // refresco silencioso en background, sin esperar
      buildUltraFast().then(async rows => {
        if (rows.length) await kino.storage.set("home:" + scope, JSON.stringify(rows), { ttlMs: CACHE_MS }).catch(()=>{});
      }).catch(()=>{});
      return cached;
    }
  } catch {}

  try {
    const rows = await timeout(buildUltraFast(), 4000, "build");
    if (rows.length) {
      kino.storage.set("home:" + scope, JSON.stringify(rows), { ttlMs: CACHE_MS }).catch(()=>{});
      kino.storage.set("last:" + scope, JSON.stringify(rows)).catch(()=>{});
      return rows;
    }
  } catch (e) {
    kino.log("home final fail " + String(e));
  }

  // ÚLTIMO RECURSO: nunca dejes que Kino vea error, devuelve algo
  try {
    const last = await readJSON("last:" + scope);
    if (last && last.length) return last;
  } catch {}
  
  return fallbackRows();
}

export async function episodes(ref) {
  await null;
  let r = null;
  try { r = JSON.parse(ref); } catch { r = null; }
  if (!r || r.kind !== "tv" || !r.id) throw kino.error("not_found", "ref inválido");
  const show = await tmdb("/tv/" + r.id, { language: tmdbLang() });
  const seasons = (show.seasons || []).filter(s => s.season_number > 0).slice(0, 10);
  const full = await Promise.all(seasons.map(s => tmdb("/tv/" + r.id + "/season/" + s.season_number, { language: tmdbLang() }).catch(() => null)));
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
      });
    }
  }
  return { series: { title: show.name, ids: { tmdb: r.id } }, episodes: out };
}

export async function resolve(ref) {
  await null;
  throw kino.error("not_found", "catálogo sin video", { userMessage: "Busca el título en tus otras fuentes." });
}