# Deploying to spotifree.billappreward.sbs (Docker)

The VPS already runs nginx plus an existing app in Docker on port 3000. Nothing
below touches that app: new subdomain, new port (3001), new container, new nginx
file.

Docker also removes the Node version problem entirely — the image pins Node 24
internally, so the host needs no Node at all.

## 1. DNS (free)

Hostinger hPanel → **Domains → DNS Zone Editor** for `billappreward.sbs`:

| Type | Name        | Points to         | TTL   |
| ---- | ----------- | ----------------- | ----- |
| A    | `spotifree` | `187.127.153.212` | 14400 |

Name is just `spotifree`, not the full domain. Verify:

```bash
dig +short spotifree.billappreward.sbs      # should print the IP
```

## 2. Ship the code

```bash
mkdir -p /opt/spotifree && cd /opt/spotifree
git clone <your-repo> .        # or scp the folder up
echo "YOUTUBE_API_KEY=your_key_here" > .env
```

`docker-compose.yml` reads `YOUTUBE_API_KEY` from that `.env`.

## 3. Build and run

```bash
docker compose up -d --build
docker compose logs -f          # ctrl-C once you see "Ready"
curl -s localhost:3001/api/quota
```

The container binds to **127.0.0.1:3001** only — not reachable from the internet
except through nginx, so the password gate cannot be bypassed by hitting the port.

`restart: unless-stopped` brings it back automatically after a reboot.

### Where the data lives

The named volume `spotifree-data` holds `/app/data/cache.db`: the YouTube track
cache **and** your saved playlists. It survives `docker compose down`, rebuilds,
and image updates — verified by destroying the container and recreating it.

Only `docker volume rm spotifree-data` deletes it. Back it up with:

```bash
docker run --rm -v spotifree-data:/d -v $(pwd):/b alpine \
  tar czf /b/spotifree-backup.tar.gz -C /d .
```

## 4. nginx + free SSL

```bash
sudo cp deploy/nginx-spotifree.conf /etc/nginx/sites-available/spotifree
sudo ln -s /etc/nginx/sites-available/spotifree /etc/nginx/sites-enabled/

# Password gate — protects your YouTube quota from strangers.
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd-spotifree yourname

sudo nginx -t                   # must say "syntax is ok" before reloading
sudo systemctl reload nginx

sudo certbot --nginx -d spotifree.billappreward.sbs
```

`nginx -t` is the safety check: if it fails, do **not** reload — the running app
on the root domain keeps serving on the old config until you fix the error.

certbot is free, auto-renews, and edits only the spotifree file. If missing:
`sudo apt install -y certbot python3-certbot-nginx`.

Then open **https://spotifree.billappreward.sbs**.

## Updating later

```bash
cd /opt/spotifree
git pull
docker compose up -d --build    # volume, and therefore all data, is untouched
```

## Why the password matters

Anyone who opens the URL spends *your* YouTube quota — about 99 new tracks per
day shared across all visitors. Cached tracks keep playing once it is gone, but
new songs stop resolving until it resets. Basic auth costs nothing and removes
the problem.
