/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);

const clock = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function say(message, kind = 'error') {
  const el = $('notice');
  el.textContent = message;
  el.className = `notice ${kind}`;
}
const clearSay = () => { $('notice').className = 'notice'; };

/* ------------------------------------------------------------------ state */

const state = {
  tracks: [],
  order: [],          // indices into tracks — playback sequence
  cursor: -1,         // position within order
  shuffle: false,
  ready: false,
  volume: 80,
  failed: new Set(),
};

let player = null;
let ticker = null;
const resolving = new Map();   // spotifyId -> Promise<videoId>

const currentTrack = () =>
  state.cursor >= 0 ? state.tracks[state.order[state.cursor]] : null;

/* --------------------------------------------------------------- resolving */

async function resolveTrack(track, { retry = false } = {}) {
  if (!retry && resolving.has(track.id)) return resolving.get(track.id);

  // The server builds the search query itself so the matching logic lives in one place.
  const params = new URLSearchParams({
    id: track.id,
    title: track.title,
    artists: track.artists,
    dur: track.durationMs,
    ...(retry ? { retry: '1' } : {}),
  });

  const job = fetch(`/api/resolve?${params}`)
    .then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'resolve failed');
      return body.videoId;
    })
    .catch((err) => {
      resolving.delete(track.id);   // let it be retried later
      throw err;
    });

  resolving.set(track.id, job);
  return job;
}

/** Warm the cache for the next track so playback does not stall at the gap. */
function prefetchNext() {
  const nextTrack = state.tracks[state.order[state.cursor + 1]];
  if (nextTrack) resolveTrack(nextTrack).catch(() => {});
}

/* -------------------------------------------------------------- rendering */

function renderTracks(playlist) {
  $('plName').textContent = playlist.name;
  $('listing').hidden = false;

  const rows = $('rows');
  rows.replaceChildren();

  playlist.tracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.index = i;
    row.innerHTML = `
      <div class="idx">${i + 1}</div>
      <div>
        <div class="name"></div>
        <div class="artist"></div>
      </div>
      <div class="len">${clock(track.durationMs / 1000)}</div>`;
    row.querySelector('.name').textContent = track.title;
    row.querySelector('.artist').textContent = track.artists;
    row.addEventListener('click', () => playAt(i));
    rows.appendChild(row);
  });

  markActive();
}

function markActive() {
  const active = state.cursor >= 0 ? state.order[state.cursor] : -1;
  for (const row of $('rows').children) {
    row.classList.toggle('active', Number(row.dataset.index) === active);
  }
}

function paintNowPlaying(track) {
  $('nowTitle').textContent = track.title;
  $('nowArtist').textContent = track.artists;
  $('nowArt').style.backgroundImage = track.art ? `url("${track.art}")` : '';
  $('total').textContent = clock(track.durationMs / 1000);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists,
      album: track.album,
      artwork: track.art ? [{ src: track.art, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
  }
}

async function refreshQuota() {
  try {
    const q = await (await fetch('/api/quota')).json();
    $('quota').textContent = `${q.searchesLeft} new tracks resolvable today`;
  } catch { /* cosmetic only */ }
}

/* --------------------------------------------------------------- playback */

function buildOrder(startIndex = null) {
  const indices = state.tracks.map((_, i) => i);

  if (!state.shuffle) {
    state.order = indices;
    state.cursor = startIndex === null ? 0 : startIndex;
    return;
  }

  // Fisher-Yates, with the chosen track pulled to the front.
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  if (startIndex !== null) {
    const at = indices.indexOf(startIndex);
    [indices[0], indices[at]] = [indices[at], indices[0]];
  }
  state.order = indices;
  state.cursor = 0;
}

async function playAt(trackIndex) {
  if (!state.ready) { say('Player still loading — one moment.'); return; }

  buildOrder(trackIndex);
  await playCursor();
}

async function playCursor() {
  const track = currentTrack();
  if (!track) return;

  markActive();
  paintNowPlaying(track);
  clearSay();

  try {
    const videoId = await resolveTrack(track);
    player.loadVideoById(videoId);
    prefetchNext();
    refreshQuota();
  } catch (err) {
    say(`${track.title} — ${err.message}`);
    state.failed.add(track.id);
    if (state.failed.size < state.tracks.length) setTimeout(skip, 1200);
  }
}

function skip(step = 1) {
  const next = state.cursor + step;
  if (next < 0 || next >= state.order.length) {
    if (step > 0) { state.cursor = 0; playCursor(); }   // wrap to start
    return;
  }
  state.cursor = next;
  playCursor();
}

function togglePlay() {
  if (!player || state.cursor < 0) {
    if (state.tracks.length) playAt(0);
    return;
  }
  const s = player.getPlayerState();
  if (s === YT.PlayerState.PLAYING) player.pauseVideo();
  else player.playVideo();
}

function setPlayIcon(isPlaying) {
  $('playIcon').innerHTML = isPlaying
    ? '<path d="M2.7 1h3.6v14H2.7zM9.7 1h3.6v14H9.7z"/>'
    : '<path d="M3 1.7v12.6L14 8z"/>';
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!player?.getDuration) return;
    const at = player.getCurrentTime() || 0;
    const len = player.getDuration() || 0;
    $('elapsed').textContent = clock(at);
    if (len) {
      $('total').textContent = clock(len);
      $('fill').style.width = `${(at / len) * 100}%`;
    }
  }, 400);
}
const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = null; };

/* ------------------------------------------------------------- yt bridge */

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('host', {
    height: '138',
    width: '246',
    playerVars: {
      controls: 0,
      disablekb: 1,
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      enablejsapi: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        state.ready = true;
        player.setVolume(state.volume);
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) { setPlayIcon(true); startTicker(); }
        if (e.data === YT.PlayerState.PAUSED)  { setPlayIcon(false); stopTicker(); }
        if (e.data === YT.PlayerState.ENDED)   { setPlayIcon(false); stopTicker(); skip(1); }
      },
      onError: (e) => {
        // 100/101/150: removed, private, or embedding disabled by the uploader.
        const track = currentTrack();
        say(`Cannot play "${track?.title ?? 'track'}" (YouTube error ${e.data}) — skipping.`);
        if (track) state.failed.add(track.id);
        setTimeout(() => skip(1), 1200);
      },
    },
  });
};

(function loadYouTubeApi() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
})();

/* ------------------------------------------------------------------ wiring */

$('loader').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('url').value.trim();
  if (!url) return;

  $('load').disabled = true;
  $('load').textContent = 'Loading…';
  clearSay();

  try {
    const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    state.tracks = data.tracks;
    state.failed.clear();
    buildOrder(0);
    state.cursor = -1;
    renderTracks(data);
    refreshQuota();

    if (!data.tracks.length) say('That playlist came back empty.');
    else say(`${data.tracks.length} tracks loaded · ${data.cachedCount} already cached. Click any track to play.`, 'info');
  } catch (err) {
    say(err.message || 'Could not load that playlist.');
  } finally {
    $('load').disabled = false;
    $('load').textContent = 'Load';
  }
});

$('play').addEventListener('click', togglePlay);
$('next').addEventListener('click', () => skip(1));
$('prev').addEventListener('click', () => {
  // Restart the track first, like every other player.
  if (player?.getCurrentTime && player.getCurrentTime() > 3) player.seekTo(0);
  else skip(-1);
});

$('shuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  $('shuffle').classList.toggle('on', state.shuffle);
  const playing = currentTrack();
  if (playing) {
    buildOrder(state.tracks.indexOf(playing));   // keep current track, reshuffle the rest
    markActive();
  }
});

$('video').addEventListener('click', () => {
  const shown = $('stage').classList.toggle('show');
  $('video').classList.toggle('on', shown);
});

$('bar').addEventListener('click', (e) => {
  if (!player?.getDuration) return;
  const box = e.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  player.seekTo(player.getDuration() * ratio, true);
});

$('vol').addEventListener('input', (e) => {
  state.volume = Number(e.target.value);
  player?.setVolume?.(state.volume);
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.key === 'n') skip(1);
  if (e.key === 'p') skip(-1);
  if (e.key === 's') $('shuffle').click();
  if (e.key === 'ArrowRight' && player?.getCurrentTime) player.seekTo(player.getCurrentTime() + 5, true);
  if (e.key === 'ArrowLeft' && player?.getCurrentTime) player.seekTo(Math.max(0, player.getCurrentTime() - 5), true);
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => player?.playVideo());
  navigator.mediaSession.setActionHandler('pause', () => player?.pauseVideo());
  navigator.mediaSession.setActionHandler('nexttrack', () => skip(1));
  navigator.mediaSession.setActionHandler('previoustrack', () => skip(-1));
}
