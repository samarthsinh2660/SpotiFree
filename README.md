# Spotifree

Paste a public Spotify playlist link and play it. Tracks are matched to YouTube
once, then cached forever — so the API quota is only ever spent on songs you have
never played before.

- **No Spotify account or credentials needed**
- **Auto-advance** through the playlist, in order or shuffled
- **Saved playlists** — load once, then pick from cards
- Runs as a **Docker container** or a plain Node app

---

## 1. Get a YouTube API key

This is the only credential required.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (name it anything, e.g. `spotifree`)
3. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**
4. **APIs & Services → Credentials** → **Create credentials → API key**
5. Copy the key

Optional but recommended: **Restrict key → API restrictions → YouTube Data API v3**.
Do *not* add an HTTP-referrer restriction — the key is used server-side, and a
referrer restriction will reject every request (`ipRefererBlocked`).

> **Why Spotify needs no key:** Spotify's Web API now returns
> `403 "Active premium subscription required for the owner of the app"` on every
> endpoint unless the app owner has Premium. Playlists are therefore read from the
> public embed page, which requires no authentication at all.

---

## 2. Run it

### With Docker (recommended)

```bash
git clone https://github.com/samarthsinh2660/SpotiFree
cd SpotiFree

echo "YOUTUBE_API_KEY=your_key_here" > .env

docker compose up -d --build
docker compose logs -f          # ctrl-C once it says "Ready"
```

Open **http://localhost:3001**.

The image pins Node 24 internally, so the host does not need Node installed.

### Without Docker

Requires **Node ≥ 22.5** (for the built-in `node:sqlite`).

```bash
npm install
echo "YOUTUBE_API_KEY=your_key_here" > .env
npm run dev                     # http://localhost:3000
```

Production: `npm run build && npm start`.

---

## 3. Configuration

| Variable          | Required | Default              | Purpose                                   |
| ----------------- | -------- | -------------------- | ----------------------------------------- |
| `YOUTUBE_API_KEY` | yes      | —                    | YouTube Data API v3 key                   |
| `PORT`            | no       | `3000`               | Port the server listens on                |
| `DB_PATH`         | no       | `./data/cache.db`    | SQLite file (set to a mounted volume path)|

---

## 4. Using it

Paste a **public** playlist link (`https://open.spotify.com/playlist/…`) and press
Load. Click any track to start.

| Control        | What it does                                              |
| -------------- | --------------------------------------------------------- |
| **Flow**       | Play in playlist order                                     |
| **Random**     | Shuffle. Switching mid-song keeps the current track playing |
| Saved cards    | Click to load and play instantly; `×` forgets one          |
| `space`        | Play / pause                                               |
| `n` / `p`      | Next / previous                                            |
| `←` / `→`      | Seek 5 seconds                                             |

When a track ends the next starts automatically, and the queue wraps at the end,
so a playlist plays indefinitely.

---

## 5. Quota, and the errors you may see

The free YouTube allowance is **10,000 units/day**. Each new track costs 101
(100 for the search, 1 for a duration lookup), so roughly **99 new tracks per
day**. Playback itself costs **nothing** — only first-time matching does, and
every match is cached permanently.

The header shows how many new tracks you can still resolve today.

| Message | Meaning | Fix |
| --- | --- | --- |
| *Daily YouTube quota is used up…* | 99 new tracks already resolved today | Cached songs keep playing. New ones resolve after the reset at **midnight Pacific**. Playback stops advancing rather than firing a doomed request per track. |
| *YouTube is rate-limiting requests…* | Too many requests too quickly | Wait a moment, then retry |
| *YouTube Data API v3 is not enabled…* | Key's project lacks the API | Enable it in Google Cloud (step 1.3) |
| *The YouTube API key is invalid or restricted* | Wrong or malformed key | Check `.env`, restart the container |
| *This API key is restricted and does not allow requests from this server* | HTTP-referrer restriction set | Remove it — the key is used server-side |
| *Spotify is rate-limiting this server…* | Too many playlist loads | Wait a minute |
| *That playlist is private or empty* | Not publicly visible | Make it public. Editorial playlists (Discover Weekly, Release Radar) can never be read |
| *Cannot play "…" (YouTube error 150)* | Uploader disabled embedding | Auto-skips to the next track |

---

## 6. Deploying

See **[deploy/DEPLOY.md](deploy/DEPLOY.md)** for the full walkthrough: subdomain
DNS, Docker, nginx reverse proxy, free SSL via certbot, and a password gate.

> **Put a password on any public deployment.** Anyone who opens the URL spends
> *your* quota — ~99 new tracks/day shared across every visitor. The nginx config
> in `deploy/` includes basic auth for exactly this reason.

### Data persistence

The SQLite database holds the track cache **and** your saved playlists. In Docker
it lives in the named volume `spotifree-data`, which survives rebuilds and
`docker compose down`. Back it up:

```bash
docker run --rm -v spotifree-data:/d -v $(pwd):/b alpine \
  tar czf /b/spotifree-backup.tar.gz -C /d .
```

Losing it is not fatal — it only means tracks get re-resolved, spending quota
again.

---

## 7. How it works

```
playlist link → open.spotify.com/embed/playlist/<id>       (no credentials)
             → __NEXT_DATA__ JSON → titles, artists, durations, track IDs
             → per track: YouTube search.list (100 units) + videos.list (1 unit)
             → candidates scored, best one cached in SQLite permanently
             → played through a YouTube IFrame parked off-screen
```

### Matching

Plain search is not good enough — it happily returns karaoke tracks, unplugged
sessions and lyric reuploads. Each search pulls 8 candidates, one `videos.list`
call fetches their durations for 1 unit, and they are scored on:

- **title overlap** with the song name, ignoring parenthetical film context
- **duration** within 3s of Spotify's — a strong signal for the same recording
- **channel** — `- Topic` auto-uploads and official labels (T-Series, YRF, Sony,
  Zee, Saregama…) score high
- **disqualifiers** — karaoke, instrumental, reaction, trailer: never the song
- **variants** — unplugged, cover, remix, lofi, slowed: penalised, not banned

Only the **lead artist** goes into the query. Spotify credits film music with
composers and lyricists first, and including them drags results toward covers.

### Re-tuning without spending quota

`tools/candidates.json` holds raw search results captured once. Edit the scoring
in `tools/tune.py`, run `npm run tune`, and compare rankings — no API calls, no
quota. Port what works into `scoreCandidate()` in `lib/youtube.ts`.

---

## 8. Project layout

```
app/            page.tsx (player UI), api/{playlist,resolve,quota,library}
lib/            spotify.ts (embed reader), youtube.ts (search + scoring), cache.ts
tools/          offline matching-tuner
deploy/         nginx config + deployment guide
legacy/         the original Express version — safe to delete
```

---

## 9. Limits

- Playlists must be **public**
- **No screen-off playback on mobile** — browsers suspend media in backgrounded
  pages, and YouTube blocks background embed playback by design. Desktop is fine.
- Some uploads have embedding disabled; those auto-skip
- The quota counter tracks only calls made through this server
