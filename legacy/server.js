import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, YOUTUBE_API_KEY } = process.env;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ---------------------------------------------------------------- storage */

const db = new DatabaseSync(join(__dirname, 'data', 'cache.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS track_map (
    spotify_id  TEXT PRIMARY KEY,
    video_id    TEXT NOT NULL,
    label       TEXT,
    resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS quota (
    day   TEXT PRIMARY KEY,
    units INTEGER NOT NULL DEFAULT 0
  );
`);

const getMapping = db.prepare('SELECT video_id FROM track_map WHERE spotify_id = ?');
const putMapping = db.prepare(
  'INSERT OR REPLACE INTO track_map (spotify_id, video_id, label, resolved_at) VALUES (?, ?, ?, ?)'
);
const dropMapping = db.prepare('DELETE FROM track_map WHERE spotify_id = ?');
const bumpQuota = db.prepare(
  'INSERT INTO quota (day, units) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units'
);
const readQuota = db.prepare('SELECT units FROM quota WHERE day = ?');

const today = () => new Date().toISOString().slice(0, 10);
const spendQuota = (units) => bumpQuota.run(today(), units);
const quotaUsed = () => readQuota.get(today())?.units ?? 0;

/* ---------------------------------------------------------------- spotify */

/* Spotify's Web API now 403s every endpoint unless the app owner holds an active
   Premium subscription, so the public embed page is the primary source: it needs
   no credentials and carries the full tracklist. The API stays as a fallback for
   anyone whose account can still use it (it has richer per-track artwork). */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/** Spotify separates artist names with non-breaking spaces; those wreck search queries. */
const tidy = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchPlaylistViaEmbed(id) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  });
  if (res.status === 404) throw httpError(404, 'No such playlist — check the link.');
  if (!res.ok) throw httpError(502, `Spotify embed returned ${res.status}`);

  const html = await res.text();
  const blob = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!blob) throw httpError(502, 'Could not read the playlist page — Spotify may have changed its markup.');

  const entity = JSON.parse(blob[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) throw httpError(404, 'That playlist is private or empty. It must be public to load.');

  const cover = entity.coverArt?.sources?.at(-1)?.url ?? entity.coverArt?.sources?.[0]?.url ?? null;

  const tracks = entity.trackList
    .filter((t) => t.uri?.startsWith('spotify:track:'))
    .map((t) => ({
      id: t.uri.split(':').pop(),
      title: tidy(t.title),
      artists: tidy(t.subtitle),
      album: '',
      durationMs: t.duration ?? 0,
      art: cover,
    }));

  return { name: tidy(entity.name) || 'Playlist', owner: tidy(entity.subtitle), art: cover, tracks };
}

let tokenCache = { value: null, expiresAt: 0 };

async function spotifyToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) throw httpError(500, 'no Spotify credentials configured');

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw httpError(502, `Spotify auth failed (${res.status})`);

  const json = await res.json();
  tokenCache = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return tokenCache.value;
}

async function spotifyGet(path) {
  const token = await spotifyToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw httpError(res.status, `Spotify API ${res.status}`);
  return res.json();
}

async function fetchPlaylistViaApi(id) {
  const meta = await spotifyGet(`/playlists/${id}?fields=name,owner(display_name),images`);
  const tracks = [];
  let offset = 0;

  while (true) {
    const page = await spotifyGet(
      `/playlists/${id}/tracks?limit=100&offset=${offset}` +
      '&fields=next,items(track(id,name,duration_ms,artists(name),album(name,images)))'
    );
    for (const item of page.items ?? []) {
      const t = item.track;
      if (!t?.id) continue;
      tracks.push({
        id: t.id,
        title: t.name,
        artists: t.artists.map((a) => a.name).join(', '),
        album: t.album?.name ?? '',
        durationMs: t.duration_ms,
        art: t.album?.images?.at(-1)?.url ?? null,
      });
    }
    if (!page.next) break;
    offset += 100;
  }

  return { name: meta.name, owner: meta.owner?.display_name ?? '', art: meta.images?.[0]?.url ?? null, tracks };
}

function parsePlaylistId(input) {
  const raw = (input || '').trim();
  for (const re of [/playlist[/:]([A-Za-z0-9]{22})/, /^([A-Za-z0-9]{22})$/]) {
    const hit = raw.match(re);
    if (hit) return hit[1];
  }
  return null;
}

/* ---------------------------------------------------------------- matching */

/* Tuned against tools/candidates.json — see tools/tune.py to re-tune offline
   without spending quota. */

const LABELS = ['t-series', 'sony music', 'zee music', 'saregama', 'tips', 'yrf',
  'speed records', 'vevo', 'times music', 'eros now', 'venus', 'shemaroo'];

// Not the song at all — never acceptable as a match.
const DISQUALIFY = ['karaoke', 'instrumental', 'reaction', 'tutorial', 'ringtone', 'status',
  'how to', 'making of', 'behind the scene', 'trailer', 'teaser'];

// A real performance of the song, just not the recording we asked for.
const VARIANT = ['unplugged', 'cover', 'remix', 'sped up', 'slowed', 'reverb', 'lofi', 'lo-fi',
  'mashup', 'medley', 'live', '8d', 'dance', 'choreography', 'revisited', 'recreated'];

const ENTITIES = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'" };
const unescapeHtml = (s) =>
  (s || '').replace(/&(#\d+|[a-z]+);/gi, (m, code) =>
    ENTITIES[code.toLowerCase()] ?? (code[0] === '#' ? String.fromCharCode(+code.slice(1)) : m));

const norm = (s) => unescapeHtml(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
const toks = (s) => norm(s).split(/\s+/).filter((t) => t.length > 1);

/** Separate the song name from parenthetical context like (From "Some Film"). */
function splitTitle(title) {
  const core = title.replace(/[([].*?[)\]]/g, ' ');
  const extra = [...title.matchAll(/[([](.*?)[)\]]/g)].map((m) => m[1]).join(' ').replace(/\bfrom\b/gi, ' ');
  return { core, extra };
}

function scoreCandidate(candidate, track) {
  const { core, extra } = splitTitle(track.title);
  const ctitle = norm(candidate.title);
  const cchan = (candidate.channelTitle || '').toLowerCase();
  let score = 0;

  const coreToks = toks(core);
  if (coreToks.length) {
    const hit = coreToks.filter((t) => ctitle.includes(t)).length / coreToks.length;
    score += 120 * hit;
    if (hit < 0.5) score -= 120;              // probably a different song entirely
  }

  if (extra && toks(extra).some((t) => ctitle.includes(t))) score += 25;   // film name corroborates

  if (toks(track.artists).filter((t) => t.length > 3).some((t) => ctitle.includes(t) || cchan.includes(t))) {
    score += 20;
  }

  if (cchan.endsWith('- topic')) score += 55;                 // label-uploaded clean audio
  else if (LABELS.some((l) => cchan.includes(l))) score += 45;
  if (ctitle.includes('official')) score += 15;

  const want = Math.round((track.durationMs || 0) / 1000);
  if (candidate.seconds && want) {
    const drift = Math.abs(candidate.seconds - want);
    if (drift <= 3) score += 50;
    else if (drift <= 10) score += 25;
    if (drift > 45) score -= 70;
  }

  const asked = norm(`${track.title} ${track.artists}`);
  for (const bad of DISQUALIFY) if (ctitle.includes(bad) && !asked.includes(bad)) score -= 200;
  for (const bad of VARIANT)    if (ctitle.includes(bad) && !asked.includes(bad)) score -= 40;

  return score;
}

function isoDurationToSeconds(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
}

async function youtubeSearch(track) {
  if (!YOUTUBE_API_KEY) throw httpError(500, 'YOUTUBE_API_KEY missing from .env');

  // Only the lead artist: Spotify credits film music with composers and lyricists
  // first, and feeding those in drags the search toward covers and unplugged sets.
  const leadArtist = track.artists.split(',')[0].trim();
  const query = `${leadArtist} ${track.title}`;

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.search = new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true',
    maxResults: '8', q: query, key: YOUTUBE_API_KEY,
  });

  const res = await fetch(searchUrl);
  spendQuota(100);                 // charged whether it succeeds or not
  if (res.status === 403) {
    throw httpError(429, 'YouTube quota exhausted for today (~99 new tracks). Cached tracks still play fine.');
  }
  if (!res.ok) throw httpError(502, `YouTube search failed (${res.status})`);

  const items = (await res.json()).items ?? [];
  if (!items.length) return null;

  const candidates = items.map((item) => ({
    videoId: item.id.videoId,
    title: unescapeHtml(item.snippet.title),
    channelTitle: item.snippet.channelTitle,
    seconds: 0,
  }));

  // videos.list costs 1 unit and gives durations — the cheapest way to reject wrong cuts.
  const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailUrl.search = new URLSearchParams({
    part: 'contentDetails', id: candidates.map((c) => c.videoId).join(','), key: YOUTUBE_API_KEY,
  });

  const detailRes = await fetch(detailUrl);
  spendQuota(1);
  if (detailRes.ok) {
    const byId = new Map(
      ((await detailRes.json()).items ?? [])
        .map((v) => [v.id, isoDurationToSeconds(v.contentDetails.duration)])
    );
    for (const c of candidates) c.seconds = byId.get(c.videoId) ?? 0;
  }

  candidates.sort((a, b) => scoreCandidate(b, track) - scoreCandidate(a, track));
  return candidates[0];
}

/* ------------------------------------------------------------------ routes */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/playlist', wrap(async (req, res) => {
  const id = parsePlaylistId(req.query.url);
  if (!id) throw httpError(400, 'That does not look like a Spotify playlist link.');

  let playlist;
  try {
    playlist = await fetchPlaylistViaEmbed(id);
  } catch (embedErr) {
    if (!SPOTIFY_CLIENT_ID) throw embedErr;
    try {
      playlist = await fetchPlaylistViaApi(id);
    } catch {
      throw embedErr;              // the embed message is the more useful of the two
    }
  }

  playlist.id = id;
  playlist.cachedCount = playlist.tracks.filter((t) => getMapping.get(t.id)).length;
  res.json(playlist);
}));

app.get('/api/resolve', wrap(async (req, res) => {
  const { id, title, artists, dur, retry } = req.query;
  if (!id || !title) throw httpError(400, 'id and title are required');

  if (retry === '1') dropMapping.run(id);      // user rejected the cached match
  else {
    const hit = getMapping.get(id);
    if (hit) return res.json({ videoId: hit.video_id, cached: true });
  }

  const track = { title, artists: artists || '', durationMs: +dur || 0 };
  const best = await youtubeSearch(track);
  if (!best) throw httpError(404, `No YouTube match found for "${title}"`);

  putMapping.run(id, best.videoId, best.title, Date.now());
  res.json({ videoId: best.videoId, cached: false, label: best.title, channel: best.channelTitle });
}));

app.get('/api/quota', (req, res) => {
  const used = quotaUsed();
  const remaining = Math.max(0, 10000 - used);
  res.json({ used, remaining, searchesLeft: Math.floor(remaining / 101) });
});

app.use(express.static(join(__dirname, 'public')));

app.use((err, req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

app.listen(PORT, () => console.log(`\n  ♫  Spotifree running at http://localhost:${PORT}\n`));
