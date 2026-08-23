export type Track = {
  id: string;
  title: string;
  artists: string;
  album: string;
  durationMs: number;
  art: string | null;
};

export type Playlist = {
  id: string;
  name: string;
  owner: string;
  art: string | null;
  tracks: Track[];
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/** Spotify separates artist names with non-breaking spaces; those wreck search queries. */
const tidy = (s: string | undefined) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export function parsePlaylistId(input: string | null): string | null {
  const raw = (input || '').trim();
  for (const re of [/playlist[/:]([A-Za-z0-9]{22})/, /^([A-Za-z0-9]{22})$/]) {
    const hit = raw.match(re);
    if (hit) return hit[1];
  }
  return null;
}

/* Spotify's Web API now returns 403 "Active premium subscription required for the
   owner of the app" on every endpoint unless the app owner holds Premium. The
   public embed page needs no credentials and carries the whole tracklist, so it
   is the primary source. */
export async function fetchPlaylist(id: string): Promise<Playlist> {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    cache: 'no-store',
  });

  if (res.status === 404) throw new HttpError(404, 'No such playlist — check the link.');
  if (!res.ok) throw new HttpError(502, `Spotify returned ${res.status}`);

  const html = await res.text();
  const blob = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!blob) {
    throw new HttpError(502, 'Could not read the playlist page — Spotify may have changed its markup.');
  }

  const entity = JSON.parse(blob[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) {
    throw new HttpError(404, 'That playlist is private or empty. It must be public to load.');
  }

  const sources = entity.coverArt?.sources ?? [];
  const cover: string | null = sources.at(-1)?.url ?? sources[0]?.url ?? null;

  const tracks: Track[] = entity.trackList
    .filter((t: any) => typeof t.uri === 'string' && t.uri.startsWith('spotify:track:'))
    .map((t: any) => ({
      id: t.uri.split(':').pop() as string,
      title: tidy(t.title),
      artists: tidy(t.subtitle),
      album: '',
      durationMs: t.duration ?? 0,
      art: cover,
    }));

  return {
    id,
    name: tidy(entity.name) || 'Playlist',
    owner: tidy(entity.subtitle),
    art: cover,
    tracks,
  };
}
