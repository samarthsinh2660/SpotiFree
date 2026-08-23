# Spotifree

Paste a public Spotify playlist link, get a player. Next.js app. Tracks are matched
to YouTube once and cached in SQLite forever, so quota is only ever spent on songs
you have never played before.

## Run locally

```bash
npm install
echo "YOUTUBE_API_KEY=your_key_here" > .env
npm run dev          # http://localhost:3000
```

Get the key at https://console.cloud.google.com → new project → *APIs & Services*
→ enable **YouTube Data API v3** → *Credentials* → *API key*.

**Spotify credentials are not needed.** Spotify's Web API now returns
`403 "Active premium subscription required for the owner of the app"` on every
endpoint unless the app owner has Premium, so playlists are read from the public
embed page instead, which needs no auth at all.

## Deploying

Both Render and Hostinger run a **persistent Node process**, so the SQLite cache
works normally. (It would not survive on Vercel or other serverless hosts, where
the filesystem is ephemeral and the cache would reset on every cold start.)

### Render

`render.yaml` is included — point Render at the repo and it picks it up. Set
`YOUTUBE_API_KEY` in the dashboard, never in the file.

Two things that matter:

- **Node version.** `node:sqlite` needs Node ≥ 22.5. `NODE_VERSION=24` is set in
  the blueprint and `.nvmrc`; without it Render may pick an older default and the
  build will fail on the `node:sqlite` import.
- **The disk.** Render Disks require a *paid* instance. The blueprint mounts one at
  `/var/data` with `DB_PATH=/var/data/cache.db` so the cache survives redeploys.
  On the free tier there is no disk: the cache is wiped on every deploy and every
  spin-down, so tracks get re-resolved and quota is spent again. It still works —
  it just costs quota you did not need to spend.

### Hostinger

A **VPS** is the better home for this: full filesystem, so the cache persists with
no extra configuration.

```bash
npm install && npm run build
npx pm2 start "npm start" --name spotifree     # keeps it alive across reboots
```

Then reverse-proxy port 3000 with nginx. Hostinger's shared Node hosting also
works, provided you can select Node 22.5+.

### Before you expose it publicly

Anyone who opens the URL spends **your** YouTube quota — ~99 new tracks per day,
shared across every visitor. Keep the URL to yourself, or put a password in front
of it.

## Playback

- **Auto-advance.** When a track ends the next one starts automatically, and the
  queue wraps at the end, so a playlist plays forever without touching anything.
- **Flow / Random.** *Flow* plays in playlist order; *Random* shuffles. Switching
  mid-song keeps what is playing and only reorders what comes after it.
- **Saved playlists.** Every playlist you load is remembered and shown as a card.
  Click one to load and start playing — no pasting links again. The `×` on a card
  forgets it. Stored in the same SQLite database as the track cache, so the same
  persistence rules apply when deploying.

## How it works

```
playlist link → open.spotify.com/embed/playlist/<id>  (no credentials)
             → __NEXT_DATA__ JSON → titles, artists, durations, track IDs
             → per track: YouTube search.list (100 units) + videos.list (1 unit)
             → scored, best match cached in SQLite permanently
             → played through a YouTube IFrame parked off-screen
```

Playback costs **zero** quota — only first-time matching does.

## Matching

Search alone is not good enough: it happily returns karaoke tracks, unplugged
sessions and lyric reuploads. Each search pulls 8 candidates, one `videos.list`
call fetches their durations for 1 unit, and they are scored on:

- **title overlap** with the song name, ignoring parenthetical film context
- **duration** within 3s of Spotify's — a strong signal for "same recording"
- **channel**: `- Topic` auto-uploads and official labels (T-Series, YRF, Sony,
  Zee, Saregama…) score high
- **disqualifiers** (karaoke, instrumental, reaction, trailer…) — never the song
- **variants** (unplugged, cover, remix, lofi, slowed…) — penalised, not banned

Only the **lead artist** goes into the query. Spotify credits film music with
composers and lyricists first, and including them drags results toward covers.

### Re-tuning without spending quota

`tools/candidates.json` holds raw search results captured once. Edit the scoring
in `tools/tune.py`, run `npm run tune`, and compare rankings — no API calls, no
quota. Port what works into `scoreCandidate()` in `lib/youtube.ts`.

## Layout

```
app/            page.tsx (player UI), api/{playlist,resolve,quota}
lib/            spotify.ts (embed reader), youtube.ts (search + scoring), cache.ts
tools/          offline tuning harness
legacy/         the original Express version — safe to delete
```

## Keyboard

| key | action |
| --- | --- |
| `space` | play / pause |
| `n` / `p` | next / previous |
| `←` / `→` | seek 5s |

## Known limits

- Playlist must be public.
- **No screen-off playback on mobile.** Browsers suspend media in backgrounded
  pages and YouTube blocks background embed playback by design. Desktop is fine.
- Some uploads have embedding disabled — those auto-skip with a notice.
