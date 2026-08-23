'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Track = {
  id: string;
  title: string;
  artists: string;
  album: string;
  durationMs: number;
  art: string | null;
};

type Notice = { text: string; kind: 'error' | 'info' } | null;

type SavedPlaylist = {
  id: string;
  name: string;
  url: string;
  art: string | null;
  trackCount: number;
  lastPlayedAt: number;
};

/** flow = playlist order, random = shuffled. */
type Mode = 'flow' | 'random';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

export default function Page() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const [playlistName, setPlaylistName] = useState('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);   // index into `tracks`
  const [nowPlaying, setNowPlaying] = useState<Track | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [mode, setMode] = useState<Mode>('flow');
  const [library, setLibrary] = useState<SavedPlaylist[]>([]);
  const [currentId, setCurrentId] = useState('');
  const [showVideo, setShowVideo] = useState(false);
  const [quota, setQuota] = useState('');

  /* Playback state lives in refs: the YouTube player fires callbacks from outside
     React, and closures over state would go stale between renders. */
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const tracksRef = useRef<Track[]>([]);
  const orderRef = useRef<number[]>([]);
  const cursorRef = useRef(-1);
  const resolvingRef = useRef(new Map<string, Promise<string>>());
  const failedRef = useRef(new Set<string>());
  const modeRef = useRef<Mode>('flow');
  modeRef.current = mode;

  const currentTrack = useCallback(() => {
    const i = orderRef.current[cursorRef.current];
    return i === undefined ? null : tracksRef.current[i] ?? null;
  }, []);

  const refreshQuota = useCallback(async () => {
    try {
      const q = await (await fetch('/api/quota')).json();
      setQuota(`${q.searchesLeft} new tracks resolvable today`);
    } catch {
      /* cosmetic only */
    }
  }, []);

  const resolveTrack = useCallback((track: Track, retry = false): Promise<string> => {
    if (!retry && resolvingRef.current.has(track.id)) {
      return resolvingRef.current.get(track.id)!;
    }

    // The server builds the search query itself so matching logic lives in one place.
    const params = new URLSearchParams({
      id: track.id,
      title: track.title,
      artists: track.artists,
      dur: String(track.durationMs),
      ...(retry ? { retry: '1' } : {}),
    });

    const job = fetch(`/api/resolve?${params}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'resolve failed');
        return body.videoId as string;
      })
      .catch((err) => {
        resolvingRef.current.delete(track.id);    // allow a later retry
        throw err;
      });

    resolvingRef.current.set(track.id, job);
    return job;
  }, []);

  const playCursor = useCallback(async () => {
    const track = currentTrack();
    if (!track) return;

    setActiveIndex(orderRef.current[cursorRef.current]);
    setNowPlaying(track);
    setDuration(track.durationMs / 1000);
    setNotice(null);

    try {
      const videoId = await resolveTrack(track);
      playerRef.current?.loadVideoById(videoId);

      // Warm the next track so playback does not stall at the gap.
      const next = tracksRef.current[orderRef.current[cursorRef.current + 1]];
      if (next) resolveTrack(next).catch(() => {});
      refreshQuota();
    } catch (err) {
      setNotice({ text: `${track.title} — ${(err as Error).message}`, kind: 'error' });
      failedRef.current.add(track.id);
      if (failedRef.current.size < tracksRef.current.length) {
        setTimeout(() => skip(1), 1200);
      }
    }
  }, [currentTrack, resolveTrack, refreshQuota]);

  const skip = useCallback(
    (step: number) => {
      const next = cursorRef.current + step;
      if (next < 0 || next >= orderRef.current.length) {
        if (step > 0) {
          cursorRef.current = 0;      // wrap to the start
          playCursor();
        }
        return;
      }
      cursorRef.current = next;
      playCursor();
    },
    [playCursor]
  );

  const buildOrder = useCallback((startIndex: number, wanted: Mode = modeRef.current) => {
    const indices = tracksRef.current.map((_, i) => i);

    if (wanted === 'flow') {
      orderRef.current = indices;
      cursorRef.current = startIndex;
      return;
    }

    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const at = indices.indexOf(startIndex);     // keep the chosen track first
    [indices[0], indices[at]] = [indices[at], indices[0]];
    orderRef.current = indices;
    cursorRef.current = 0;
  }, []);

  const playAt = useCallback(
    (trackIndex: number) => {
      if (!readyRef.current) {
        setNotice({ text: 'Player still loading — one moment.', kind: 'error' });
        return;
      }
      buildOrder(trackIndex);
      playCursor();
    },
    [buildOrder, playCursor]
  );

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p || cursorRef.current < 0) {
      if (tracksRef.current.length) playAt(0);
      return;
    }
    if (p.getPlayerState() === window.YT.PlayerState.PLAYING) p.pauseVideo();
    else p.playVideo();
  }, [playAt]);

  /* The YT player is created once; its handlers reach current logic through this ref. */
  const handlers = useRef({ skip, currentTrack });
  handlers.current = { skip, currentTrack };

  useEffect(() => {
    const boot = () => {
      playerRef.current = new window.YT.Player('yt-host', {
        height: '138',
        width: '246',
        playerVars: {
          controls: 0, disablekb: 1, playsinline: 1, rel: 0,
          modestbranding: 1, enablejsapi: 1, origin: window.location.origin,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            playerRef.current.setVolume(80);
          },
          onStateChange: (e: any) => {
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) setIsPlaying(true);
            if (e.data === S.PAUSED) setIsPlaying(false);
            if (e.data === S.ENDED) {
              setIsPlaying(false);
              handlers.current.skip(1);
            }
          },
          onError: (e: any) => {
            // 100/101/150: removed, private, or embedding disabled by the uploader.
            const t = handlers.current.currentTrack();
            setNotice({
              text: `Cannot play "${t?.title ?? 'track'}" (YouTube error ${e.data}) — skipping.`,
              kind: 'error',
            });
            if (t) failedRef.current.add(t.id);
            setTimeout(() => handlers.current.skip(1), 1200);
          },
        },
      });
    };

    if (window.YT?.Player) {
      boot();
    } else {
      window.onYouTubeIframeAPIReady = boot;
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  }, []);

  // Progress ticker, only while actually playing.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p?.getDuration) return;
      setElapsed(p.getCurrentTime() || 0);
      const d = p.getDuration() || 0;
      if (d) setDuration(d);
    }, 400);
    return () => clearInterval(id);
  }, [isPlaying]);

  useEffect(() => {
    if (!nowPlaying || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: nowPlaying.artists,
      album: nowPlaying.album,
      artwork: nowPlaying.art ? [{ src: nowPlaying.art, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => playerRef.current?.playVideo());
    navigator.mediaSession.setActionHandler('pause', () => playerRef.current?.pauseVideo());
    navigator.mediaSession.setActionHandler('nexttrack', () => skip(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => skip(-1));
  }, [nowPlaying, skip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches('input')) return;
      const p = playerRef.current;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'n') skip(1);
      if (e.key === 'p') skip(-1);
      if (e.key === 'ArrowRight' && p?.getCurrentTime) p.seekTo(p.getCurrentTime() + 5, true);
      if (e.key === 'ArrowLeft' && p?.getCurrentTime) p.seekTo(Math.max(0, p.getCurrentTime() - 5), true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, skip]);

  const refreshLibrary = useCallback(async () => {
    try {
      const data = await (await fetch('/api/library')).json();
      setLibrary(data.playlists ?? []);
    } catch {
      /* library is a convenience, not critical */
    }
  }, []);

  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  const loadPlaylist = useCallback(
    async (rawUrl: string, autoPlay = false) => {
      const target = rawUrl.trim();
      if (!target) return;

      setLoading(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/playlist?url=${encodeURIComponent(target)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        tracksRef.current = data.tracks;
        failedRef.current.clear();
        resolvingRef.current.clear();
        cursorRef.current = -1;
        orderRef.current = [];
        setTracks(data.tracks);
        setPlaylistName(data.name);
        setCurrentId(data.id);
        setActiveIndex(-1);
        refreshQuota();

        // Remember it so it never has to be pasted again.
        fetch('/api/library', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: data.id,
            name: data.name,
            url: target,
            art: data.art,
            trackCount: data.tracks.length,
          }),
        })
          .then((r) => r.json())
          .then((d) => setLibrary(d.playlists ?? []))
          .catch(() => {});

        if (!data.tracks.length) {
          setNotice({ text: 'That playlist came back empty.', kind: 'error' });
        } else if (autoPlay) {
          buildOrder(0);
          playCursor();
        } else {
          setNotice({
            text: `${data.tracks.length} tracks loaded · ${data.cachedCount} already cached. Click any track to play.`,
            kind: 'info',
          });
        }
      } catch (err) {
        setNotice({ text: (err as Error).message || 'Could not load that playlist.', kind: 'error' });
      } finally {
        setLoading(false);
      }
    },
    [refreshQuota, buildOrder, playCursor]
  );

  async function forgetPlaylist(e: React.MouseEvent, id: string) {
    e.stopPropagation();                  // don't also select the card
    try {
      const data = await (await fetch(`/api/library?id=${id}`, { method: 'DELETE' })).json();
      setLibrary(data.playlists ?? []);
    } catch {
      /* ignore */
    }
  }

  function onScrub(e: React.MouseEvent<HTMLDivElement>) {
    const p = playerRef.current;
    if (!p?.getDuration) return;
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    p.seekTo(p.getDuration() * ratio, true);
  }

  /** Switching mode keeps whatever is playing and only re-orders what follows. */
  function chooseMode(next: Mode) {
    setMode(next);
    modeRef.current = next;
    const playing = currentTrack();
    if (playing) buildOrder(tracksRef.current.indexOf(playing), next);
  }

  return (
    <>
      <div className="shell">
        <header className="hero">
          <div className="brand">
            <svg viewBox="0 0 24 24"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.5 17.3a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.11-10.56-1.15a.75.75 0 1 1-.33-1.46c4.58-1.05 8.51-.6 11.67 1.33.35.22.46.68.25 1.03zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.56-11.97-1.4a.94.94 0 1 1-.54-1.8c4.36-1.32 9.78-.68 13.49 1.6.44.27.58.85.31 1.29zm.13-3.4C15.23 8.33 8.9 8.12 5.2 9.24a1.12 1.12 0 1 1-.65-2.15c4.24-1.29 11.23-1.04 15.66 1.59a1.12 1.12 0 0 1-1.15 1.93z" /></svg>
            Spotifree
          </div>
          <h1>Your playlists, without the ads.</h1>
          <p className="sub">Paste a public Spotify playlist link. Tracks are matched to YouTube once, then cached forever.</p>

          <form
            className="loader"
            onSubmit={(e) => {
              e.preventDefault();
              loadPlaylist(url);
            }}
          >
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://open.spotify.com/playlist/…"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="primary" type="submit" disabled={loading}>
              {loading ? 'Loading…' : 'Load'}
            </button>
          </form>
        </header>

        {library.length > 0 && (
          <section className="library">
            <h3>Saved playlists</h3>
            <div className="cards">
              {library.map((p) => (
                <div
                  key={p.id}
                  className={`card${p.id === currentId ? ' current' : ''}`}
                  onClick={() => loadPlaylist(p.url, true)}
                  title={`Play ${p.name}`}
                >
                  <div className="cover" style={p.art ? { backgroundImage: `url("${p.art}")` } : undefined} />
                  <div className="info">
                    <div className="cname">{p.name}</div>
                    <div className="ccount">{p.trackCount} tracks</div>
                  </div>
                  <button className="forget" onClick={(e) => forgetPlaylist(e, p.id)} title="Remove">×</button>
                </div>
              ))}
            </div>
          </section>
        )}

        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        {tracks.length > 0 && (
          <section className="listing">
            <div className="listing-head">
              <h2>{playlistName}</h2>
              <div className="head-right">
                <div className="modes">
                  <button
                    className={mode === 'flow' ? 'on' : ''}
                    onClick={() => chooseMode('flow')}
                    title="Play in playlist order"
                  >
                    Flow
                  </button>
                  <button
                    className={mode === 'random' ? 'on' : ''}
                    onClick={() => chooseMode('random')}
                    title="Shuffle the playlist"
                  >
                    Random
                  </button>
                </div>
                <span className="quota">{quota}</span>
              </div>
            </div>
            <div>
              {tracks.map((track, i) => (
                <div
                  key={`${track.id}-${i}`}
                  className={`row${i === activeIndex ? ' active' : ''}`}
                  onClick={() => playAt(i)}
                >
                  <div className="idx">{i + 1}</div>
                  <div>
                    <div className="name">{track.title}</div>
                    <div className="artist">{track.artists}</div>
                  </div>
                  <div className="len">{clock(track.durationMs / 1000)}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <div id="stage" className={showVideo ? 'show' : ''}>
        <div id="yt-host" />
      </div>

      <footer className="dock">
        <div className="now">
          <div
            className="art"
            style={nowPlaying?.art ? { backgroundImage: `url("${nowPlaying.art}")` } : undefined}
          />
          <div className="meta">
            <div className="t">{nowPlaying?.title ?? 'Nothing playing'}</div>
            <div className="a">{nowPlaying?.artists ?? '—'}</div>
          </div>
        </div>

        <div className="controls">
          <div className="buttons">
            <button
              className={`ctl${mode === 'random' ? ' on' : ''}`}
              onClick={() => chooseMode(mode === 'random' ? 'flow' : 'random')}
              title={mode === 'random' ? 'Random — click for Flow' : 'Flow — click for Random'}
            >
              <svg viewBox="0 0 16 16"><path d="M13.15 2.35a.5.5 0 0 0-.7.7L13.29 4H12c-1.7 0-2.7.9-3.5 2l-.4.6.6.9.6-.9C10.1 5.5 10.8 5 12 5h1.29l-.84.85a.5.5 0 0 0 .7.7l1.71-1.7a.5.5 0 0 0 0-.71l-1.71-1.7zM2 4h1.5c1.2 0 1.9.5 2.6 1.6l3 4.5C9.9 11.3 10.9 12 12.5 12h.79l-.84.85a.5.5 0 0 0 .7.7l1.71-1.7a.5.5 0 0 0 0-.71l-1.71-1.7a.5.5 0 0 0-.7.7l.84.86h-.79c-1.2 0-1.9-.5-2.6-1.6l-3-4.5C6.1 3.7 5.1 3 3.5 3H2v1zm0 7h1.5c1 0 1.6-.35 2.2-1.1l.5-.75-.6-.9-.6.9C4.6 9.7 4.2 10 3.5 10H2v1z" /></svg>
            </button>
            <button className="ctl" onClick={() => {
              const p = playerRef.current;
              if (p?.getCurrentTime && p.getCurrentTime() > 3) p.seekTo(0);
              else skip(-1);
            }} title="Previous">
              <svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM13 2v12L5.5 8z" /></svg>
            </button>
            <button className="ctl play" onClick={togglePlay} title="Play / pause">
              <svg viewBox="0 0 16 16">
                {isPlaying
                  ? <path d="M2.7 1h3.6v14H2.7zM9.7 1h3.6v14H9.7z" />
                  : <path d="M3 1.7v12.6L14 8z" />}
              </svg>
            </button>
            <button className="ctl" onClick={() => skip(1)} title="Next">
              <svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM3 2v12L10.5 8z" /></svg>
            </button>
            <button className={`ctl${showVideo ? ' on' : ''}`} onClick={() => setShowVideo((v) => !v)} title="Show video">
              <svg viewBox="0 0 16 16"><path d="M1 3h11v10H1zM13 6l2-1.5v7L13 10z" /></svg>
            </button>
          </div>

          <div className="scrub">
            <span className="time">{clock(elapsed)}</span>
            <div className="track" onClick={onScrub}>
              <div className="fill" style={{ width: duration ? `${(elapsed / duration) * 100}%` : '0%' }} />
            </div>
            <span className="time">{clock(duration)}</span>
          </div>
        </div>

        <div className="right">
          <input
            className="vol"
            type="range"
            min={0}
            max={100}
            defaultValue={80}
            onChange={(e) => playerRef.current?.setVolume?.(Number(e.target.value))}
            title="Volume"
          />
        </div>
      </footer>
    </>
  );
}
