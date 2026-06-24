# RO-IPTV

A self-hosted **M3U / IPTV player** as an installable **Progressive Web App** — Live TV, Radio, EPG and Recordings, packaged as a **single Docker image**.

Built with React + TailwindCSS + HLS.js on the front end and a Node/Express backend that handles M3U parsing, XMLTV EPG, a CORS-bypassing stream proxy, and JSON persistence.

![dark glassmorphism UI](https://img.shields.io/badge/theme-dark%20glassmorphism-8083ff) ![PWA](https://img.shields.io/badge/PWA-installable-c0c1ff)

---

## ✨ Features

- **Authentication** — optional username/password login (enable by setting `AUTH_PASSWORD`). A bootstrap `admin`/`admin` credential **forces a password change on first login**; the new password is stored salted + scrypt-hashed in the `/data` volume, retiring the default. HttpOnly signed-cookie sessions, "Remember Password", brute-force rate limiting, and a **Settings → Account** password change. See [Authentication](#-authentication).
- **Playlist management** — load M3U/M3U8 from URL or file upload; parses `group-title`, `tvg-logo`, `tvg-id`, `tvg-name`. Multi-playlist support with enable toggles, per-playlist Live/Radio routing, last-updated timestamps, configurable auto-refresh, and original-file download. Stored in `localStorage` **and** server-side JSON.
- **Channel browsing** — **browse by country** for large (5000+) lists, category chips with counts, real-time search, logo fallbacks, **Now/Next** EPG labels, favourites (red ★) and watch history. Set a default country for Live TV.
- **Player** — HLS.js for `.m3u8`, native `<video>`/`<audio>` for direct streams. A **draggable, resizable floating mini-player** (in-app PiP) keeps playback alive as you navigate, plus native Picture-in-Picture and **OS / lock-screen media controls** (Media Session with play/pause and previous/next). Remembers your last-watched channel; on mobile the player stays pinned while you scroll.
- **EPG** — XMLTV parsing (plain or gzipped, multi-source), a scrollable per-channel guide, Now/Next overlays and scheduled-recording markers.
- **Radio mode** — stations auto-detected (`group-title`, `radio`/`fm`/`am`), a genre grid and an animated player with background-safe playback.
- **Recordings** — **real server-side capture to disk with ffmpeg** (stream-copied to a fragmented MP4 so it's instantly seekable), with a per-recording duration cap, live file size, in-app playback and download, and persistence across restarts/rebuilds. Start a capture live or schedule one from the EPG.
- **PWA** — installable on mobile/desktop/TV, offline app shell, cache-first logos & EPG, background playlist refresh, offline fallback page, and an "Add to Home Screen" prompt.
- **Security** — hardened single image (non-root, read-only root FS, all caps dropped) plus CSP, HSTS, `Permissions-Policy`, API rate limiting, upload sanitization and a `make scan` CVE gate. See [Security](#-security).
- **Extras** — Open-Meteo weather widget (auto-location), clock/date, lazy loading for 1000+ channel lists, built-in CORS stream proxy.

---

## 🚀 Quick start (Docker)

**Pull the prebuilt image — no build needed.** It's a multi-arch image, so the
right build for your hardware (Intel/AMD `amd64` or ARM `arm64` — Synology, Pi,
mini-PC, server…) is selected automatically.

```bash
docker run -d --name ro-iptv -p 56892:56892 \
  -v ro-iptv-data:/data \
  -e TZ=Europe/London \
  -e AUTH_PASSWORD=admin \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/aiulian25/ro-iptv:latest
```

…or with Compose (create a `docker-compose.yml`):

```yaml
services:
  ro-iptv:
    image: ghcr.io/aiulian25/ro-iptv:latest
    container_name: ro-iptv
    restart: unless-stopped
    ports: ["56892:56892"]
    environment:
      - TZ=Europe/London
      - AUTH_PASSWORD=admin        # set to require login; empty = open
    volumes: ["data:/data"]
    read_only: true
    tmpfs: ["/tmp"]
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
volumes:
  data:
```

```bash
docker compose up -d
```

Then open **http://localhost:56892**

> 🔐 **First login:** if you set `AUTH_PASSWORD` (the sample `.env` ships `admin`/`admin`), sign in with those credentials — the app then **forces you to set a new password** before continuing, and the default stops working. Leave `AUTH_PASSWORD` empty to run without a login.

That's the whole thing — a **single image** where one Express process serves both the API and the built PWA on port **56892**. No separate Nginx container. Playlists, recordings (and their captured files), and the auth credential persist in the `data` Docker volume.

### Build from source (optional)

End users don't need this — pull the image above. To build it yourself:

```bash
docker compose up -d --build      # builds the local image and runs it
```

---

## 🧑‍💻 Local development

Requires Node.js 20+.

```bash
npm run install:all          # install client + server deps

# terminal 1 — backend on :56892
npm run dev:server

# terminal 2 — Vite dev server on :5173 (proxies /api to :56892)
npm run dev:client
```

Open http://localhost:5173. To preview the production build served by Express:

```bash
npm run build && npm start    # http://localhost:56892
```

---

## ⚙️ Configuration

| Variable                   | Default             | Description                                            |
| -------------------------- | ------------------- | ------------------------------------------------------ |
| `PORT`                     | `56892`             | Port the app (API + frontend) listens on.              |
| `TZ`                       | `Europe/London`     | Container timezone (clock / EPG times).                |
| `M3U_URL`                  | _empty_             | Optional playlist auto-loaded on first launch.         |
| `EPG_URL`                  | _empty_             | Optional XMLTV EPG URL for the guide & Now/Next.       |
| `REFRESH_INTERVAL_MINUTES` | `360`               | Active-playlist auto-refresh interval (`0` disables).  |
| `RECORDING_MAX_MINUTES`    | `180`               | Hard cap on a single recording's length.               |
| `DATA_DIR`                 | `/data`             | Where playlists, recordings & auth data are persisted. |

> Authentication and security-hardening variables are documented in their own
> sections below ([Authentication](#-authentication), [Security](#-security)).

All of these are also editable at runtime from the in-app **Settings** dialog.

---

## 🔐 Authentication

Authentication is **enabled when `AUTH_PASSWORD` is set** and disabled (open) when
it's empty — so a quick trial needs no login, while a real deployment is protected.

**Bootstrap → stored credential.** The env credentials act as a one-time bootstrap:
the first login forces a password change, and the new password is stored as a
salted **scrypt** hash in `/data/auth.json`. After that the env credentials no
longer work. Change it again anytime from **Settings → Account**.

| Variable             | Default | Description                                                        |
| -------------------- | ------- | ------------------------------------------------------------------ |
| `AUTH_USERNAME`      | `admin` | Login username.                                                    |
| `AUTH_PASSWORD`      | _empty_ | Bootstrap password. Set it to require login; empty = open.         |
| `AUTH_SESSION_DAYS`  | `30`    | How long a "Remember Password" session lasts.                      |
| `AUTH_SESSION_SECRET`| _empty_ | Pin the token-signing secret (else auto-generated in `/data`).     |
| `RL_LOGIN_MAX`       | `10`    | Max login attempts per IP per 15 min (brute-force protection).     |

Sessions use an HttpOnly, SameSite=Lax, signed cookie (`Secure` automatically on
HTTPS). **Lost the password?** Delete the `credential` entry from
`/data/auth.json` and restart — the app falls back to the bootstrap login.

---

## 🔒 Security

The image and app are hardened out of the box — non-root, read-only root
filesystem, all Linux capabilities dropped, `no-new-privileges`, resource/PID
limits, npm removed, OS packages patched on build, plus a tuned CSP, HSTS,
`Permissions-Policy`, API rate limiting and upload sanitization. See
[`docs/SECURITY-DEPLOYMENT.md`](docs/SECURITY-DEPLOYMENT.md) for **reverse-proxy,
TLS, firewall and Docker-network** hardening guidance.

Optional hardening variables (see [`.env.example`](.env.example)):

| Variable                | Default     | Description                                              |
| ----------------------- | ----------- | ------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS`  | _empty_     | Comma-separated hosts allowed cross-origin. Empty = any.|
| `HSTS_MAX_AGE`          | `15552000`  | HSTS max-age (seconds); only honored over HTTPS.        |
| `RATE_LIMIT_DISABLED`   | _empty_     | Set `1` to turn off API rate limiting entirely.         |
| `RL_UPSTREAM_MAX`       | `120`       | Max upstream-fetch requests/min/IP (playlist/EPG/parse).|
| `RL_WRITE_MAX`          | `120`       | Max write requests/min/IP (playlist/recording changes). |
| `MEM_LIMIT` / `CPU_LIMIT` / `PIDS_LIMIT` | `1024m` / `2` / `256` | Container resource ceilings (compose). |

Run the image vulnerability scan suite (Trivy, Grype, hadolint, syft SBOM) with
`make scan` after `make build`.

---

## 🔌 Backend API

| Method   | Endpoint                | Purpose                                       |
| -------- | ----------------------- | --------------------------------------------- |
| `GET`    | `/api/health`           | Health check (public).                         |
| `GET/POST` | `/api/auth/*`         | `status`, `login`, `logout`, `password` (public).|
| `GET`    | `/api/config`           | Server-provided defaults (M3U/EPG/refresh).   |
| `ALL`    | `/api/proxy?url=`       | CORS / range-aware stream + manifest proxy.   |
| `GET`    | `/api/playlist?url=`    | Fetch + parse an M3U into channels.           |
| `POST`   | `/api/parse`            | Parse raw M3U text (file uploads).            |
| `GET`    | `/api/epg?url=`         | Fetch + parse XMLTV EPG.                       |
| `GET/POST/DELETE` | `/api/playlists` | Playlist metadata + raw-file storage.      |
| `GET/POST/DELETE` | `/api/recordings`| Recordings: start/stop, schedule, file stream/download. |

When authentication is enabled, every `/api/*` route **except** `/api/health` and
`/api/auth/*` requires a valid session cookie (returns `401` otherwise). The
`/api/proxy` endpoint rewrites HLS manifests so nested playlists/segments also
flow through the proxy — letting you play streams from any origin regardless of
their CORS headers.

---

## 🗂️ Project structure

```
.
├── client/                 # React + Vite + Tailwind PWA
│   ├── src/
│   │   ├── components/      # TopNav, players, mini-player, login brand mark, etc.
│   │   ├── views/          # Home, Live, Radio, Recordings, Settings, Login, ChangePassword
│   │   ├── store/          # Zustand store (auth, playlists, favourites, history…)
│   │   ├── hooks/          # weather, clock, Media Session, floating PiP window
│   │   └── lib/            # api, m3u + epg parsing, country helpers
│   └── public/             # manifest icons, favicon, offline page
├── server/                 # Express API + static host
│   └── lib/                # auth, m3u, epg, ffmpeg recorder, json store
├── docs/
│   └── SECURITY-DEPLOYMENT.md   # reverse-proxy / TLS / network hardening (§3)
├── Dockerfile              # multi-stage: build client → hardened Express runtime
├── docker-compose.yml      # runtime hardening (read-only FS, dropped caps, limits)
├── Makefile                # build + `make scan` (Trivy/Grype/hadolint/SBOM)
└── .env.example
```

---

## 📺 Using it

1. If a login appears, sign in (first run: **`admin`/`admin`**, then set your own password).
2. Open the app → **Settings** (gear icon).
3. **Add Playlist** by URL or upload an `.m3u`/`.m3u8` file.
4. Optionally paste an **XMLTV EPG URL** to enable the guide and Now/Next labels.
5. Browse **Live TV / Radio**, star favourites, and record live or from the EPG.
6. On mobile/desktop, accept the **Install** prompt to add RO-IPTV to your home screen.

---

## 📝 Notes & limitations

- **Recordings** are captured to disk by `ffmpeg` (stream-copied, no re-encode) into a fragmented MP4 and stored in the `/data` volume. Each capture is bounded by `RECORDING_MAX_MINUTES` (default 180) so it can't run unbounded; captures interrupted by a restart are marked accordingly and keep whatever landed on disk.
- Some providers block datacenter IPs or require specific `User-Agent`/referrer headers; the proxy sends a browser-like UA but can't bypass provider auth.
- This project plays content **you are authorised to access**. Bring your own legal playlist.

---

## 📄 License

[MIT](LICENSE) © aiulian25
