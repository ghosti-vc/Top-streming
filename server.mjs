#!/usr/bin/env node
// A tiny stand-in for a home media server (the shape a Jellyfin/Emby/NAS-style API takes), so
// plugin.js has something real to talk to. No dependencies -- just node:http and node:fs.
//
//   node server.mjs [--port 8096] [--user ana] [--password s3cr3t] [--live-agent VLC]
//
// Then, from this folder, using your computer's own LAN address (Kino refuses a loopback address
// even from the kit -- see README.md, "Why not 127.0.0.1"):
//   node sdk/run.mjs . --config server=http://192.168.1.10:8096 \
//   --config user=ana --config password=s3cr3t home
//
// The catalog exercises every feature of the plugin SDK (README.md, "What each title shows"):
//   - movies that stream a progressive mp4 (so they can be downloaded), one of them with TMDB and
//     IMDb ids, so Kino asks this server about it from ANY source: its intro and credits (segments),
//     its subtitles, its logo, ratings and cast (meta), and it is told when it is watched (tracking);
//   - a movie with a separate audio file (a "dub" the player merges into the video), its own subtitle
//     and its own intro/credits marks (Stream.skip);
//   - a movie with three labelled copies, one of them found only when it is asked for (apiVersion 6);
//   - a video whose every playlist and segment request must carry a fresh signature (signing);
//   - an 18+ entry, shown by Kino only while the person's 18+ code is unlocked;
//   - a series whose two seasons are separate titles (the plugin answers `seasons`);
//   - ten live channels, each an endless HLS playlist looping three bundled 2-second segments of
//     its own (media/live/canal-N/), listed for Kino's En vivo tab in the three shapes a plugin can
//     give (/channels, /lista.m3u + /guia.xml.gz, and /lista-token.m3u whose links need the token;
//     README.md, "Channels");
//   - four entries named after the error they trigger when opened, the same kino.error() codes the
//     guide documents -- open "Error: limitado" and you get rate_limited, and so on.
//
// Search is deliberately naive: it matches ANY word of the query (3+ letters), the way many real
// backends do, so the plugin has something for kino.rank to clean up.
//
// Tokens: issued on a correct login and kept until this process exits or DELETE /session revokes
// one -- this server never expires one, so changing only the password in Kino's Configurar screen
// does NOT by itself force a new login; the still-cached token keeps working (see README.md, "About
// the bundled token"). Media URLs (/stream/*, /live/*, /img/*, /subs/*) need no token: the player
// fetches them without one. The channel lists and their guide (/lista.m3u, /lista-token.m3u,
// /guia.xml.gz) do: Kino downloads them itself, with the headers the plugin declares next to them.
//
// Artwork: every title gets its own poster (2:3) and backdrop (16:9), each episode a still, the
// title with ids a clear-logo, each cast member a photo: drawn on request by artwork.mjs -- a colour
// per id with its name on it, so the cards fill in.

import { createServer } from "node:http";
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { artwork, SHAPES } from "./artwork.mjs";

const argv = process.argv.slice(2);
const args = Object.fromEntries(
  argv.flatMap((a, i) => (a.startsWith("--") ? [[a.slice(2), argv[i + 1]]] : [])),
);
const PORT = Number(args.port) || 8096;
const USER = args.user || "ana";
const PASSWORD = args.password || "s3cr3t";
// With --live-agent <text>, the live channels only answer a player whose User-Agent contains <text> (a 403 for any
// other): the way to see what the "User-Agent de los canales" setting is for.
const LIVE_AGENT = args["live-agent"] || "";

export const SERVER_VERSION = "1.5.0";

const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => join(here, "media", name);

// Progressive files served with Range support: what the player streams and what a download saves.
const FILES = {
  v1: { path: media("video1.mp4"), mime: "video/mp4" },
  // 45 s, long enough to open the audio menu by hand: a steady low tone as its own audio...
  doblaje: { path: media("doblaje.mp4"), mime: "video/mp4" },
  // ...and the "dub", 45 s of a fast high beep, so switching tracks is unmistakable.
  "audio-es": { path: media("audio-es.m4a"), mime: "audio/mp4" },
};

// The live channels: each loops its own three 2-second MPEG-TS segments (media/live/canal-N/seg0.ts
// .. seg2.ts, made by media/make-live.mjs: the channel's card, a moving bar and a tone of its own).
export const LIVE_SEGMENTS = 3;
export const LIVE_SEGMENT_SECONDS = 2;
const LIVE_WINDOW = 5;

// canal-1 keeps the id the single test channel had, so recents saved by plugin 1.1 still play.
// 1-3 and 4-6 are listed by /channels (the plugin gives them with a `ref` and with an inline
// `stream`), 7-9 by /lista.m3u (a playlist Kino downloads and parses itself), 10 by /lista-token.m3u
// (a playlist whose link needs this server's token, so Kino plays it through the plugin's resolve()).
export const LIVE_CHANNELS = [
  "Noticias 1", "Noticias 2", "Noticias 3",
  "Deportes 1", "Deportes 2", "Deportes 3",
  "Lista 1", "Lista 2", "Lista 3",
  "Lista 4",
].map((title, i) => ({ id: `canal-${i + 1}`, title }));

// The signed video: three 2-second segments of its own (media/protegido/), drawn by make-live.mjs too.
export const SIGNED_VIDEO = { id: "protegido", title: "Video protegido", label: "Firma por peticion" };

// The categories /channels lists, and a few programmes per category for /channels/guide.
const CHANNEL_CATEGORIES = [
  { id: "noticias", title: "Noticias", genre: "noticias", channels: ["canal-1", "canal-2", "canal-3"], shows: ["Noticiero", "Magazín", "Resumen del día"] },
  { id: "deportes", title: "Deportes", genre: "deportes", channels: ["canal-4", "canal-5", "canal-6"], shows: ["Fútbol en vivo", "Análisis", "Goles de la fecha"] },
];

// One show, two seasons -- each season its own title, the way many servers keep them.
const SHOWS = {
  serie: { title: "Serie de prueba", overview: "Una serie de prueba con dos temporadas." },
};

// The genres /genres lists (Kino's Categorías tiles); `adult` ones only show with the 18+ code unlocked.
const GENRES = [
  { id: "pruebas", title: "Pruebas", art: "v1" },
  { id: "animacion", title: "Animación", art: "bbb" },
  { id: "drama", title: "Drama", art: "serie-t1" },
  { id: "adultos", title: "Adultos", art: "adulto", adult: true },
];

// People of the reference server's own metadata (meta's `cast`): made up, and named so.
const PEOPLE = [
  { id: "ana-prueba", name: "Ana Prueba", character: "Big Buck Bunny (voz)" },
  { id: "luis-ensayo", name: "Luis Ensayo", character: "Frank (voz)" },
];

const CATALOG = [
  {
    id: "v1", kind: "movie", title: "Video de prueba 1", year: 2024, stream: "v1", genres: ["Pruebas"], runtime: 1,
    overview: "Tres segundos de imagen de prueba: se reproduce y se descarga.", badges: ["HD"], quality: "1080p", lang: "es",
  },
  {
    // The title with ids: Kino matches it with TMDB, and asks this server about it from any source
    // (segments, subtitles, meta) and tells it when the person watches it (tracking).
    id: "bbb", kind: "movie", title: "Big Buck Bunny", year: 2008, tmdb: 10378, imdb: "tt1254207", stream: "doblaje",
    genres: ["Animación", "Comedia"], rating: 6.4, runtime: 10, quality: "1080p", lang: "en",
    overview: "Un conejo enorme y tranquilo contra tres roedores que no lo dejan en paz.",
    durationMs: 45000,
    // Where its intro and credits are, for GET /segments (the server knows them by id, for any copy of 45 s).
    segments: [{ type: "intro", startMs: 2000, endMs: 9000 }, { type: "credits", startMs: 38000, endMs: 45000 }],
    subtitles: [
      // Timed for the very file this server streams: /subtitles gives its OpenSubtitles hash.
      { lang: "es", label: "Big.Buck.Bunny.2008.1080p", release: "Big.Buck.Bunny.2008.1080p.mp4", forFile: true },
      { lang: "en", label: "Big.Buck.Bunny.2008.720p", release: "Big.Buck.Bunny.2008.720p.mkv" },
      { lang: "pt", label: "Traducción automática", release: "", translated: true },
    ],
    meta: {
      ratings: [{ source: "imdb", value: "6.4" }, { source: "letterboxd", value: "3.4/5" }],
      cast: ["ana-prueba", "luis-ensayo"],
    },
  },
  {
    id: "doblaje", kind: "movie", title: "Película con doblaje", year: 2025, stream: "doblaje", genres: ["Pruebas"], runtime: 1,
    overview: "Un tono grave propio y un doblaje aparte, un pitido agudo, para elegir en el menú de audio.",
    audio: [{ lang: "es-419", label: "Español (doblaje de prueba)", file: "audio-es" }],
    // This file's own opening and ending, sent with the stream (Stream.skip).
    durationMs: 45000, skip: { openingStartMs: 1000, openingEndMs: 8000, endingStartMs: 37000 },
    subtitles: [{ lang: "es", label: "Español", release: "doblaje.mp4" }],
  },
  {
    // Three copies of the same clip, the way a source with several servers has them (labelled copies,
    // apiVersion 6). `lazy` ones are not in the title's answer: their stream is only found by asking
    // /items/<id>/copies/<copy>, the way a real source needs a page of its own per server.
    id: "copias", kind: "movie", title: "Película con copias", year: 2025, stream: "v1", genres: ["Pruebas"],
    copies: [
      { id: "a", lang: "Latino", name: "Servidor A", stream: "v1" },
      { id: "b", lang: "Original", name: "Servidor B", stream: "doblaje" },
      { id: "c", lang: "Subtitulado", name: "Servidor C", stream: "doblaje", lazy: true },
    ],
  },
  // HLS whose every playlist and segment request must be signed with the session's key (GET /secure/...).
  { id: "protegido", kind: "movie", title: "Video protegido", year: 2026, secure: true, genres: ["Pruebas"], overview: "Seis segundos en HLS: cada petición lleva una firma que vence en segundos." },
  // An 18+ entry: the same test clip, marked adult so Kino shows it only with the 18+ code unlocked.
  { id: "adulto", kind: "movie", title: "Contenido 18+ (prueba)", year: 2026, stream: "v1", genres: ["Adultos"], adult: true },
  {
    id: "serie-t1", kind: "series", title: "Serie de prueba", year: 2025, show: "serie", season: 1, genres: ["Drama"],
    episodes: ["El comienzo", "La prueba", "El final de temporada"],
  },
  {
    id: "serie-t2", kind: "series", title: "Serie de prueba (Temporada 2)", year: 2026, show: "serie", season: 2, genres: ["Drama"],
    episodes: ["El regreso", "Hasta la próxima"],
  },
  ...LIVE_CHANNELS.map(({ id, title }) => ({ id, kind: "live", title })),
  { id: "err-404", kind: "movie", title: "Error: no encontrado", errorStatus: 404 },
  { id: "err-429", kind: "movie", title: "Error: limitado", errorStatus: 429 },
  { id: "err-451", kind: "movie", title: "Error: región", errorStatus: 451 },
  { id: "err-503", kind: "movie", title: "Error: no disponible", errorStatus: 503 },
];

// Every episode, by id ("serie-t1-e2"): playable like a movie.
const EPISODES = new Map(
  CATALOG.filter((x) => x.kind === "series").flatMap((s) =>
    s.episodes.map((title, i) => [
      `${s.id}-e${i + 1}`,
      {
        id: `${s.id}-e${i + 1}`, kind: "episode", title, season: s.season, number: i + 1, stream: "v1",
        airDate: `${s.year}-0${s.season}-${String(i + 1).padStart(2, "0")}`, runtime: 1,
      },
    ]),
  ),
);

// Ids this server gave its titles before (a library rebuilt on a real server changes them; an older
// client may have saved them): GET /moved, which plugin.js's migrate() reads once and keeps.
const MOVED = {
  titles: { "video-de-prueba-1": { id: "v1", kind: "movie" }, "big-buck-bunny-2008": { id: "bbb", kind: "movie" }, "serie-de-prueba-t1": { id: "serie-t1", kind: "series" } },
  episodes: { "serie-de-prueba-1x2": { id: "serie-t1-e2", season: 1, number: 2 } },
  channels: { "noticias-uno": "canal-1" },
};

const tokens = new Set();
const HOUR = 3600 * 1000;

// What the person played, as plugin.js's track() told it (POST /playing), newest last; by event id,
// so a repeated delivery of the same event is recorded once.
const played = [];
const seenEvents = new Set();

// Sessions of the signed video: id -> key. A real server would expire them; this one keeps them.
const sessions = new Map();

function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length, ...headers });
  res.end(buf);
}

function authed(req) {
  return tokens.has(req.headers["x-token"]);
}

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

// Any shared word is a hit: noisy on purpose (see the header comment).
function matches(item, q) {
  const title = new Set(words(item.title));
  return words(q).some((w) => title.has(w));
}

// What a listing shows of an entry.
const summary = ({ id, kind, title, year, tmdb, imdb, overview, genres, rating, runtime, badges, quality, lang, adult }) =>
  ({ id, kind, title, year, tmdb, imdb, overview, genres, rating, runtime, badges, quality, lang, adult });

// What opening an entry shows: streams as server paths, a season with its episodes and siblings.
function detail(x, url) {
  if (x.secure) {
    // A fresh session when asked (?fresh=1, the plugin's retry), else the last one: what the plugin signs with.
    let session = [...sessions.entries()].pop();
    if (!session || url.searchParams.get("fresh") === "1") {
      session = [randomBytes(8).toString("hex"), randomBytes(32).toString("hex")];
      sessions.set(session[0], session[1]);
    }
    return { id: x.id, kind: "movie", title: x.title, hls: "/secure/" + x.id + "/index.m3u8", session: { id: session[0], key: session[1] } };
  }
  if (x.kind === "movie" || x.kind === "episode") {
    return {
      id: x.id, kind: x.kind, title: x.title, stream: "/stream/" + x.stream,
      durationMs: x.durationMs, skip: x.skip,
      audio: (x.audio || []).map((a) => ({ lang: a.lang, label: a.label, stream: "/stream/" + a.file })),
      subtitles: (x.subtitles || []).filter((s) => !s.translated).map((s) => ({ lang: s.lang, label: s.label, file: `/subs/${x.id}.${s.lang}.vtt`, format: "vtt" })),
      // A lazy copy lists no stream here: /items/<id>/copies/<copy> gives it.
      ...(x.copies && {
        copies: x.copies.map((c) => ({ id: c.id, lang: c.lang, name: c.name, stream: c.lazy ? undefined : "/stream/" + c.stream })),
      }),
    };
  }
  if (x.kind === "live") return { id: x.id, kind: "live", title: x.title, stream: "/live/" + x.id + ".m3u8" };
  const show = SHOWS[x.show];
  return {
    id: x.id, kind: "series", show: { id: x.show, ...show }, season: x.season, year: x.year, genres: x.genres,
    episodes: x.episodes.map((title, i) => {
      const e = EPISODES.get(`${x.id}-e${i + 1}`);
      return { id: e.id, number: i + 1, title, airDate: e.airDate, runtime: e.runtime, overview: `Capítulo ${i + 1} de la temporada ${x.season}.` };
    }),
    seasons: CATALOG.filter((s) => s.show === x.show).map((s) => ({ id: s.id, number: s.season })),
  };
}

// The small label on top of a title's artwork.
function artLabel(x) {
  if (x.kind === "series") return "Serie - Temporada " + x.season;
  if (x.kind === "episode") return `T${x.season} - Episodio ${x.number}`;
  if (x.kind === "live") return "En vivo";
  if (x.kind === "person") return "Reparto";
  return "Pelicula";
}

// Drawn once per shape and id, then kept: the same URL always answers the same bytes.
const images = new Map();
function image(shape, id) {
  const key = shape + "/" + id;
  if (!images.has(key)) {
    const person = PEOPLE.find((p) => p.id === id);
    const x = CATALOG.find((c) => c.id === id) || EPISODES.get(id) || (person && { kind: "person", title: person.name });
    if (!x) return null;
    images.set(key, artwork({ id, title: x.title, label: artLabel(x), shape }));
  }
  return images.get(key);
}

// The title a tracking event or a segments/subtitles/meta query is about, by any of its ids.
function byIds({ imdb, tmdb } = {}) {
  return CATALOG.find((x) => (imdb && x.imdb === imdb) || (tmdb && x.tmdb === Number(tmdb)));
}

// The OpenSubtitles hash of a file, the one Kino 0.9.51 sends subtitles() as `file.hash`: its size plus every
// little-endian 64-bit word of its first and last 64 KB, kept to 64 bits, as 16 hex digits.
const hashes = new Map();
function osHash(path) {
  if (hashes.has(path)) return hashes.get(path);
  const size = statSync(path).size;
  const chunk = Math.min(65536, size);
  const fd = openSync(path, "r");
  let h = BigInt(size);
  try {
    for (const at of [0, Math.max(0, size - chunk)]) {
      const buf = Buffer.alloc(chunk);
      readSync(fd, buf, 0, chunk, at);
      for (let i = 0; i + 8 <= chunk; i += 8) h = (h + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
  } finally {
    closeSync(fd);
  }
  const hex = h.toString(16).padStart(16, "0");
  hashes.set(path, hex);
  return hex;
}

// A subtitle file of a title, drawn from its name: three cues over its first 30 seconds.
function subtitleFile(x, lang) {
  const line = { es: "Subtítulo de prueba", en: "Test subtitle", pt: "Legenda de teste" }[lang] || "Subtitle";
  const cue = (n, a, b) => `${n}\n00:00:${String(a).padStart(2, "0")}.000 --> 00:00:${String(b).padStart(2, "0")}.000\n${line} ${n}: ${x.title}\n`;
  return "WEBVTT\n\n" + [cue(1, 1, 5), cue(2, 10, 15), cue(3, 20, 30)].join("\n");
}

function streamFile(req, res, { path, mime }) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return json(res, 500, { error: path + " is missing -- see README.md" });
  }
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "Content-Type": mime, "Content-Length": size, "Accept-Ranges": "bytes" });
    if (req.method === "HEAD") return res.end();
    return createReadStream(path).pipe(res);
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    "Content-Type": mime,
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(path, { start, end }).pipe(res);
}

// A live HLS playlist computed from the clock: the newest LIVE_WINDOW segments, never an
// #EXT-X-ENDLIST, and an #EXT-X-DISCONTINUITY each time the loop starts over (the timestamps reset).
function livePlaylist(res, id) {
  const newest = Math.floor(Date.now() / 1000 / LIVE_SEGMENT_SECONDS);
  const first = newest - LIVE_WINDOW + 1;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${LIVE_SEGMENT_SECONDS}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / LIVE_SEGMENTS)}`,
  ];
  for (let seq = first; seq <= newest; seq++) {
    if (seq !== first && seq % LIVE_SEGMENTS === 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${LIVE_SEGMENT_SECONDS}.000,`, `${id}/${seq}.ts`);
  }
  const buf = Buffer.from(lines.join("\n") + "\n");
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": buf.length, "Cache-Control": "no-cache" });
  res.end(buf);
}

// The signed video's requests: `X-Session` (sent by the player as a Stream header), `X-Time` (unix
// seconds) and `X-Signature` = hex HMAC-SHA256 of "<time>:<path>" with the session's key, at most 30 s
// old -- what plugin.js's sign() computes for each request. Anything else is a 403.
function signedOk(req, pathname) {
  const key = sessions.get(String(req.headers["x-session"] || ""));
  const time = Number(req.headers["x-time"]);
  const sig = Buffer.from(String(req.headers["x-signature"] || ""), "hex");
  if (!key || !Number.isInteger(time) || Math.abs(Date.now() / 1000 - time) > 30) return false;
  const want = createHmac("sha256", key).update(`${time}:${pathname}`).digest();
  return sig.length === want.length && timingSafeEqual(sig, want);
}

function readBody(req) {
  return new Promise((done) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => done(body));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  console.log(req.method, url.pathname + url.search);

  if (req.method === "POST" && url.pathname === "/auth") {
    let creds = {};
    try { creds = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
    if (creds.user !== USER || creds.password !== PASSWORD) return json(res, 401, { error: "bad credentials" });
    const token = randomBytes(16).toString("hex");
    tokens.add(token);
    return json(res, 200, { token });
  }

  // "Cerrar sesión" (plugin.js's action): the token stops working at once.
  if (req.method === "DELETE" && url.pathname === "/session") {
    tokens.delete(req.headers["x-token"]);
    res.writeHead(204);
    return res.end();
  }

  // What the person watches (plugin.js's track()), the way Jellyfin's "Playing" API takes it: a title of
  // this library is marked as started, in progress or watched. The event's id (also in Idempotency-Key)
  // makes a repeated delivery harmless. An event about a title this server does not have (Kino sends
  // what plays from ANY source) is of no use to it: answered `{ ignored: true }`, which the plugin turns
  // into Kino's `{ skipped: true }`.
  if (req.method === "POST" && url.pathname === "/playing") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    let e;
    try { e = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!e || typeof e.id !== "string" || !["start", "progress", "stop", "watched"].includes(e.type)) return json(res, 400, { error: "not an event" });
    const x = byIds(e.kind === "episode" ? e.show && e.show.ids : e.ids);
    if (!x) return json(res, 200, { ignored: true });
    if (!seenEvents.has(e.id)) {
      seenEvents.add(e.id);
      played.push({ type: e.type, at: e.at, title: x.title, positionMs: e.positionMs });
    }
    return json(res, 200, { ok: true });
  }

  const read = req.method === "GET" || req.method === "HEAD";

  // The server's own description, for the settings form's status line and its "Probar conexión".
  if (read && url.pathname === "/status") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return json(res, 200, { name: "Tu servidor (referencia)", version: SERVER_VERSION, titles: CATALOG.length, user: USER });
  }

  if (read && url.pathname === "/playing") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return json(res, 200, { count: played.length, last: played[played.length - 1] || null });
  }

  if (read && url.pathname === "/moved") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return json(res, 200, MOVED);
  }

  if (read && url.pathname === "/genres") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return json(res, 200, GENRES);
  }

  if (read && url.pathname === "/items") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const limit = Number(url.searchParams.get("limit")) || 10;
    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const q = url.searchParams.get("q") || "";
    const kind = url.searchParams.get("kind");
    const genre = GENRES.find((g) => g.id === url.searchParams.get("genre"));
    const pool = CATALOG.filter((x) => (!kind || x.kind === kind) && (!genre || (x.genres || []).includes(genre.title)) && (!q || matches(x, q)));
    const page = pool.slice(cursor, cursor + limit);
    const next = cursor + limit < pool.length ? String(cursor + limit) : undefined;
    return json(res, 200, { items: page.map(summary), next });
  }

  const itemMatch = /^\/items\/([^/]+)$/.exec(url.pathname);
  if (read && itemMatch) {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const id = decodeURIComponent(itemMatch[1]);
    const item = CATALOG.find((x) => x.id === id) || EPISODES.get(id);
    if (!item) return json(res, 404, { error: "not found" });
    // "Error: limitado" asks to wait a second: the plugin waits (kino.sleep) and asks once more.
    if (item.errorStatus) return json(res, item.errorStatus, { error: "demo error " + item.errorStatus }, item.errorStatus === 429 ? { "Retry-After": "1" } : {});
    return json(res, 200, detail(item, url));
  }

  const copyMatch = /^\/items\/([^/]+)\/copies\/([^/]+)$/.exec(url.pathname);
  if (read && copyMatch) {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const item = CATALOG.find((x) => x.id === decodeURIComponent(copyMatch[1]));
    const copy = item && (item.copies || []).find((c) => c.id === decodeURIComponent(copyMatch[2]));
    if (!copy) return json(res, 404, { error: "not found" });
    return json(res, 200, { id: copy.id, stream: "/stream/" + copy.stream });
  }

  // Where a title's intro and credits are, by its ids (an intro-skipper's database): for any copy of
  // the same length, give or take 5 s -- another cut has its intro somewhere else.
  if (read && url.pathname === "/segments") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const p = url.searchParams;
    const x = byIds({ imdb: p.get("imdb") || p.get("showImdb"), tmdb: p.get("tmdb") || p.get("showTmdb") });
    const duration = Number(p.get("duration")) || 0;
    if (!x || !x.segments || (duration && Math.abs(duration - x.durationMs) > 5000)) return json(res, 200, []);
    return json(res, 200, x.segments);
  }

  // The subtitle files this server keeps for a title, by its ids, with the release each one was timed for.
  if (read && url.pathname === "/subtitles") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const x = byIds({ imdb: url.searchParams.get("imdb"), tmdb: url.searchParams.get("tmdb") });
    if (!x) return json(res, 200, []);
    return json(res, 200, (x.subtitles || []).map((s) => ({
      lang: s.lang, label: s.label, release: s.release, translated: !!s.translated, file: `/subs/${x.id}.${s.lang}.vtt`, format: "vtt",
      hash: s.forFile ? osHash(FILES[x.stream].path) : undefined,
    })));
  }

  // What the server knows of a title beyond TMDB's: a clear-logo, other sites' ratings, its cast.
  if (read && url.pathname === "/meta") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const x = byIds({ imdb: url.searchParams.get("imdb"), tmdb: url.searchParams.get("tmdb") });
    if (!x || !x.meta) return json(res, 404, { error: "not in this library" });
    return json(res, 200, {
      id: x.id, title: x.title, year: x.year, overview: x.overview, genres: x.genres, runtime: x.runtime,
      ratings: x.meta.ratings,
      cast: x.meta.cast.map((id) => { const p = PEOPLE.find((q) => q.id === id); return { id, name: p.name, character: p.character }; }),
    });
  }

  const subMatch = /^\/subs\/([^/.]+)\.([a-z]{2})\.vtt$/.exec(url.pathname);
  if (read && subMatch) {
    const x = CATALOG.find((c) => c.id === subMatch[1]);
    if (!x || !(x.subtitles || []).some((s) => s.lang === subMatch[2])) return json(res, 404, { error: "no such subtitle" });
    const body = Buffer.from(subtitleFile(x, subMatch[2]));
    res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Content-Length": body.length });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  // /img/poster/<id>.png, /img/backdrop/<id>.png (also an episode's still), /img/logo/<id>.png (a
  // clear-logo) and /img/poster/<person>.png (a cast photo); /img/<id> is the poster, the URL plugin
  // 1.1.0 and earlier asked for.
  const imgMatch = /^\/img\/(?:([a-z]+)\/([^/]+)\.png|([^/]+))$/.exec(url.pathname);
  const shape = imgMatch && (imgMatch[1] || "poster");
  if (read && imgMatch && SHAPES[shape]) {
    const png = image(shape, decodeURIComponent(imgMatch[2] || imgMatch[3]));
    if (!png) return json(res, 404, { error: "no such title" });
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "max-age=86400" });
    return res.end(req.method === "HEAD" ? undefined : png);
  }

  const fileMatch = /^\/stream\/([^/]+)$/.exec(url.pathname);
  if (read && fileMatch && FILES[fileMatch[1]]) return streamFile(req, res, FILES[fileMatch[1]]);

  // The signed video: a 6-second HLS VOD of three segments, every request signed (see signedOk).
  const secureMatch = /^\/secure\/protegido\/(index\.m3u8|(\d)\.ts)$/.exec(url.pathname);
  if (read && secureMatch) {
    if (!signedOk(req, url.pathname)) return json(res, 403, { error: "bad or stale signature" });
    if (secureMatch[2] !== undefined) {
      const n = Number(secureMatch[2]);
      if (n >= LIVE_SEGMENTS) return json(res, 404, { error: "no such segment" });
      return streamFile(req, res, { path: media(`protegido/seg${n}.ts`), mime: "video/mp2t" });
    }
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${LIVE_SEGMENT_SECONDS}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
    for (let n = 0; n < LIVE_SEGMENTS; n++) lines.push(`#EXTINF:${LIVE_SEGMENT_SECONDS}.000,`, `${n}.ts`);
    lines.push("#EXT-X-ENDLIST");
    const buf = Buffer.from(lines.join("\n") + "\n");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": buf.length });
    return res.end(req.method === "HEAD" ? undefined : buf);
  }

  if (LIVE_AGENT && read && /^\/live\//.test(url.pathname) && !String(req.headers["user-agent"] || "").includes(LIVE_AGENT)) {
    return json(res, 403, { error: "this channel only answers a player whose User-Agent contains " + LIVE_AGENT });
  }

  const liveMatch = /^\/live\/(canal-(?:[1-9]|10))\.m3u8$/.exec(url.pathname);
  if (read && liveMatch) return livePlaylist(res, liveMatch[1]);

  const segMatch = /^\/live\/(canal-(?:[1-9]|10))\/(\d+)\.ts$/.exec(url.pathname);
  if (read && segMatch) {
    const file = media(`live/${segMatch[1]}/seg${Number(segMatch[2]) % LIVE_SEGMENTS}.ts`);
    return streamFile(req, res, { path: file, mime: "video/mp2t" });
  }

  // Channels for Kino's En vivo tab (plugin.js: liveCategories, liveChannels, liveSearch, guide).
  if (read && url.pathname === "/channels/categories") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return json(res, 200, CHANNEL_CATEGORIES.map(({ id, title, genre }) => ({ id, title, country: "CO", genre })));
  }
  const channel = (id, cat) => ({ id, title: CATALOG.find((x) => x.id === id).title, number: Number(id.slice(6)), categoryId: cat.id });
  // ?limit= pages the category (plugin.js asks two at a time), so Kino follows `next` like it would a big list.
  if (read && url.pathname === "/channels") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const cat = CHANNEL_CATEGORIES.find((c) => c.id === url.searchParams.get("category"));
    if (!cat) return json(res, 404, { error: "no such category" });
    const limit = Number(url.searchParams.get("limit")) || cat.channels.length;
    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const next = cursor + limit < cat.channels.length ? String(cursor + limit) : undefined;
    return json(res, 200, { items: cat.channels.slice(cursor, cursor + limit).map((id) => channel(id, cat)), next });
  }
  // Every listed channel whose name has the query in it (accents and case aside).
  if (read && url.pathname === "/channels/search") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const q = fold(url.searchParams.get("q") || "");
    return json(res, 200, { items: CHANNEL_CATEGORIES.flatMap((cat) => cat.channels.map((id) => channel(id, cat))).filter((c) => q && fold(c.title).includes(q)) });
  }
  // A channel of /lista-token.m3u: its stream, only with the token (the list's links need it).
  const playMatch = /^\/channels\/(canal-(?:[1-9]|10))\/play$/.exec(url.pathname);
  if (read && playMatch) {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return json(res, 200, { stream: "/live/" + playMatch[1] + ".m3u8" });
  }
  // One programme an hour over the asked window (at most 24), cycling through the category's shows.
  if (read && url.pathname === "/channels/guide") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
    const from = Number(url.searchParams.get("from")) || Date.now();
    const to = Number(url.searchParams.get("to")) || from + 3 * HOUR;
    const start = Math.floor(from / HOUR) * HOUR;
    const hours = Math.min(24, Math.max(1, Math.ceil((to - start) / HOUR)));
    return json(res, 200, ids.flatMap((id) => {
      const cat = CHANNEL_CATEGORIES.find((c) => c.channels.includes(id));
      if (!cat) return [];
      return Array.from({ length: hours }, (_, i) => {
        const title = cat.shows[(i + Number(id.slice(6))) % cat.shows.length];
        return { channelId: id, title, start: start + i * HOUR, end: start + (i + 1) * HOUR, description: `${title} de prueba` };
      });
    }));
  }

  // The third shape: an M3U list and its XMLTV guide, which Kino downloads and parses itself. Both
  // need the token, so the plugin's playlist `headers` are exercised. Two entries never show: one in
  // "Compras", a group the plugin hides with `hideGroups`, and one in "Adultos", a group Kino always
  // hides.
  const base = () => `http://${req.headers.host}`;
  const entry = (tvgId, chno, logoId, group, name, link) =>
    `#EXTINF:-1 tvg-id="${tvgId}" tvg-chno="${chno}" tvg-logo="${base()}/img/poster/${logoId}.png" group-title="${group}",${name}\n${link}\n`;
  const m3u = (body) => {
    res.writeHead(200, { "Content-Type": "audio/x-mpegurl", "Content-Length": Buffer.byteLength(body) });
    return res.end(req.method === "HEAD" ? undefined : body);
  };
  if (read && url.pathname === "/lista.m3u") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return m3u("#EXTM3U\n"
      + [7, 8, 9].map((n) => entry(`lista-${n}`, n, `canal-${n}`, "Lista de prueba", `Lista ${n - 6}`, `${base()}/live/canal-${n}.m3u8`)).join("")
      + entry("compras-1", 10, "canal-7", "Compras", "Televentas", `${base()}/live/canal-7.m3u8`)
      + entry("adultos-1", 11, "canal-8", "Adultos", "Canal para adultos", `${base()}/live/canal-8.m3u8`));
  }
  // A list whose links are this server's /channels/<id>/play: the player could not open them (they need
  // the token), so the plugin declares it with `resolve: true` and Kino plays each one through resolve().
  if (read && url.pathname === "/lista-token.m3u") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    return m3u("#EXTM3U\n" + entry("lista-10", 12, "canal-10", "Lista con enlace por canal", "Lista 4", `${base()}/channels/canal-10/play`));
  }
  if (read && url.pathname === "/guia.xml.gz") {
    if (!authed(req)) return json(res, 401, { error: "no token" });
    const start = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
    const t = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n` + [7, 8, 9].map((n) =>
      `<channel id="lista-${n}"><display-name>Lista ${n - 6}</display-name></channel>\n` +
      Array.from({ length: 6 }, (_, i) => `<programme start="${t(start + i * HOUR)}" stop="${t(start + (i + 1) * HOUR)}" channel="lista-${n}"><title>Programa ${i + 1}</title><desc>Programa ${i + 1} de Lista ${n - 6}</desc></programme>\n`).join("")).join("") + `</tv>\n`;
    const gz = gzipSync(Buffer.from(xml));
    res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": gz.length });
    return res.end(req.method === "HEAD" ? undefined : gz);
  }

  json(res, 404, { error: "no route" });
});

// The addresses a phone on the same network can type in Configurar (never 127.0.0.1).
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

// Only when run (`node server.mjs`), not when media/make-live.mjs imports the channel list.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(PORT, () => {
  console.log(`Tu servidor (reference) listening on port ${PORT} -- user "${USER}", password "${PASSWORD}"`);
  const lan = lanAddresses();
  if (lan.length) console.log("Type one of these in Kino's Configurar > Servidor: " + lan.map((a) => `http://${a}:${PORT}`).join("  "));
});
