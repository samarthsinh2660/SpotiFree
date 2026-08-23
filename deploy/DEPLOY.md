# Deploying to spotifree.billappreward.sbs

The VPS already runs nginx and an Express app on the root domain. Nothing below
touches that app: new subdomain, new port, new nginx file, new pm2 process.

## 1. DNS (free)

Hostinger hPanel → **Domains → DNS Zone Editor** for `billappreward.sbs`:

| Type | Name        | Points to         | TTL   |
| ---- | ----------- | ----------------- | ----- |
| A    | `spotifree` | `187.127.153.212` | 14400 |

Name is just `spotifree`, not the full domain. Propagation is usually minutes.
Verify: `dig +short spotifree.billappreward.sbs` should return the IP.

## 2. Check Node on the server

`node:sqlite` requires **Node ≥ 22.5**. The existing Express app may well be on an
older version — check before anything else:

```bash
node -v
```

If it is below 22.5, install a newer Node *without* disturbing the running app:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
nvm alias default 24
```

Restart the other app only if you deliberately want it on the new version.

## 3. Pick a free port

The root app is probably on 3000. Confirm what is taken:

```bash
ss -tlnp | grep -E ':(3000|3001|3002)'
```

These instructions use **3001**. If it is occupied, choose another and change it
in both the pm2 command and `deploy/nginx-spotifree.conf`.

## 4. Deploy the app

```bash
cd /var/www                     # or wherever you keep apps
git clone <your-repo> spotifree # or scp the folder up
cd spotifree

echo "YOUTUBE_API_KEY=your_key_here" > .env
echo "PORT=3001"                    >> .env

npm install
npm run build

npm i -g pm2
pm2 start "npm start" --name spotifree
pm2 save
pm2 startup                     # run the command it prints, to survive reboots
```

The SQLite file lives at `data/cache.db` inside the project. It persists across
restarts and deploys — just do not delete the folder, and exclude it from any
deploy script that wipes the directory.

## 5. nginx + free SSL

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

`certbot` is free, issues a Let's Encrypt certificate, edits the file to add TLS,
and auto-renews. If certbot is missing: `sudo apt install -y certbot python3-certbot-nginx`.

Then open **https://spotifree.billappreward.sbs**.

## Why the password matters

Anyone who opens the URL spends *your* YouTube quota — about 99 new tracks per
day, shared across every visitor. Cached tracks keep playing once it runs out,
but new songs stop resolving until midnight Pacific. The basic-auth line costs
nothing and removes the problem entirely.

## Updating later

```bash
cd /var/www/spotifree
git pull
npm install
npm run build
pm2 restart spotifree
```
