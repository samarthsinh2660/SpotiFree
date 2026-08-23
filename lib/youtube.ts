import { HttpError } from './spotify';
import { spendQuota } from './cache';

/* Tuned against tools/candidates.json — run `npm run tune` to re-tune the scoring
   offline against captured results, without spending any quota. */

const LABELS = ['t-series', 'sony music', 'zee music', 'saregama', 'tips', 'yrf',
  'speed records', 'vevo', 'times music', 'eros now', 'venus', 'shemaroo'];

// Not the song at all — never acceptable as a match.
const DISQUALIFY = ['karaoke', 'instrumental', 'reaction', 'tutorial', 'ringtone', 'status',
  'how to', 'making of', 'behind the scene', 'trailer', 'teaser'];

// A real performance of the song, just not the recording we asked for.
const VARIANT = ['unplugged', 'cover', 'remix', 'sped up', 'slowed', 'reverb', 'lofi', 'lo-fi',
  'mashup', 'medley', 'live', '8d', 'dance', 'choreography', 'revisited', 'recreated'];

const ENTITIES: Record<string, string> = {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'",
};

export const unescapeHtml = (s: string) =>
  (s || '').replace(/&(#\d+|[a-z]+);/gi, (m, code: string) =>
    ENTITIES[code.toLowerCase()] ?? (code[0] === '#' ? String.fromCharCode(+code.slice(1)) : m));

const norm = (s: string) => unescapeHtml(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
const toks = (s: string) => norm(s).split(/\s+/).filter((t) => t.length > 1);

/** Separate the song name from parenthetical context like (From "Some Film"). */
function splitTitle(title: string) {
  const core = title.replace(/[([].*?[)\]]/g, ' ');
  const extra = [...title.matchAll(/[([](.*?)[)\]]/g)]
    .map((m) => m[1]).join(' ').replace(/\bfrom\b/gi, ' ');
  return { core, extra };
}

type Candidate = { videoId: string; title: string; channelTitle: string; seconds: number };
type Wanted = { title: string; artists: string; durationMs: number };

export function scoreCandidate(c: Candidate, track: Wanted): number {
  const { core, extra } = splitTitle(track.title);
  const ctitle = norm(c.title);
  const cchan = (c.channelTitle || '').toLowerCase();
  let score = 0;

  const coreToks = toks(core);
  if (coreToks.length) {
    const hit = coreToks.filter((t) => ctitle.includes(t)).length / coreToks.length;
    score += 120 * hit;
    if (hit < 0.5) score -= 120;               // probably a different song entirely
  }

  if (extra && toks(extra).some((t) => ctitle.includes(t))) score += 25;   // film name corroborates

  if (toks(track.artists).filter((t) => t.length > 3).some((t) => ctitle.includes(t) || cchan.includes(t))) {
    score += 20;
  }

  if (cchan.endsWith('- topic')) score += 55;                  // label-uploaded clean audio
  else if (LABELS.some((l) => cchan.includes(l))) score += 45;
  if (ctitle.includes('official')) score += 15;

  const want = Math.round((track.durationMs || 0) / 1000);
  if (c.seconds && want) {
    const drift = Math.abs(c.seconds - want);
    if (drift <= 3) score += 50;
    else if (drift <= 10) score += 25;
    if (drift > 45) score -= 70;
  }

  const asked = norm(`${track.title} ${track.artists}`);
  for (const bad of DISQUALIFY) if (ctitle.includes(bad) && !asked.includes(bad)) score -= 200;
  for (const bad of VARIANT) if (ctitle.includes(bad) && !asked.includes(bad)) score -= 40;

  return score;
}

function isoDurationToSeconds(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0) : 0;
}

export async function findBestMatch(track: Wanted): Promise<Candidate | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new HttpError(500, 'YOUTUBE_API_KEY is not set');

  // Only the lead artist: Spotify credits film music with composers and lyricists
  // first, and feeding those in drags the search toward covers and unplugged sets.
  const leadArtist = track.artists.split(',')[0].trim();
  const query = `${leadArtist} ${track.title}`;

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.search = new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true',
    maxResults: '8', q: query, key,
  }).toString();

  const res = await fetch(searchUrl, { cache: 'no-store' });
  spendQuota(100);                    // charged whether it succeeds or not
  if (res.status === 403) {
    throw new HttpError(429, 'YouTube quota is exhausted for today (~99 new tracks). Cached tracks still play.');
  }
  if (!res.ok) throw new HttpError(502, `YouTube search failed (${res.status})`);

  const items: any[] = (await res.json()).items ?? [];
  if (!items.length) return null;

  const candidates: Candidate[] = items.map((item) => ({
    videoId: item.id.videoId,
    title: unescapeHtml(item.snippet.title),
    channelTitle: item.snippet.channelTitle,
    seconds: 0,
  }));

  // videos.list costs 1 unit and gives durations — the cheapest way to reject wrong cuts.
  const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailUrl.search = new URLSearchParams({
    part: 'contentDetails', id: candidates.map((c) => c.videoId).join(','), key,
  }).toString();

  const detailRes = await fetch(detailUrl, { cache: 'no-store' });
  spendQuota(1);
  if (detailRes.ok) {
    const byId = new Map<string, number>(
      ((await detailRes.json()).items ?? []).map((v: any) => [
        v.id, isoDurationToSeconds(v.contentDetails.duration),
      ])
    );
    for (const c of candidates) c.seconds = byId.get(c.videoId) ?? 0;
  }

  candidates.sort((a, b) => scoreCandidate(b, track) - scoreCandidate(a, track));
  return candidates[0];
}
