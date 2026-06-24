# RO-IPTV — Deployment & Network Security

Companion to [`Security.md`](../Security.md). It covers **§3 Network and exposure
controls** — the parts that live **outside** the container image (reverse proxy,
host firewall, Docker networking, orchestrator) and therefore can't be "shipped"
in the repo, only configured by whoever deploys it.

> What's already enforced **in-repo** (so you don't have to): the image runs
> non-root, read-only root FS, all Linux capabilities dropped, `no-new-privileges`,
> resource/PID limits, npm removed, OS packages patched on build (§2); the app
> sends a tuned CSP + **HSTS** + `Permissions-Policy`, rate-limits its
> upstream/write endpoints, and sanitizes uploads (§4); `make scan` gates the
> image on CVEs (§5). This document is the operator's side of the contract.

RO-IPTV's topology is deliberately simple: **one container, one port (56892)**,
serving both the API and the PWA. That makes the network surface easy to reason
about — there is exactly one thing to put behind a front door.

---

## 1. Port exposure — publish only what you need

Security.md §3: *"Only publish the ports you actually need; avoid mapping
privileged ports and double-check `-p`/`--publish`."*

The compose file publishes a single, **unprivileged** port:

```yaml
ports:
  - "56892:56892"
```

Decide who needs to reach it and tighten accordingly:

| Access pattern | Recommended publish line | Effect |
|---|---|---|
| **Reverse proxy only** (e.g. `tv.example.com`) | `"127.0.0.1:56892:56892"` | Port reachable only from the host loopback; the proxy connects locally, nothing on the LAN/Internet hits the app directly. **Most secure.** |
| **Reverse proxy + direct LAN** (current setup) | `"56892:56892"` | Reachable on every host interface. Pair with a host firewall (below) to scope it to the LAN. |
| Single host, no LAN access | `"127.0.0.1:56892:56892"` | Loopback only. |

> ⚠️ Changing to `127.0.0.1:56892:56892` will **break direct `http://<LAN-IP>:56892`
> access** — only use it if every client goes through the reverse proxy.

**Host firewall** (defence in depth — do this even with a reverse proxy). Example
with `ufw`, allowing the LAN subnet and the proxy host only:

```bash
# Allow the reverse proxy / local host
sudo ufw allow from 127.0.0.1 to any port 56892 proto tcp
# Allow a trusted LAN subnet (adjust to yours)
sudo ufw allow from 192.168.0.0/24 to any port 56892 proto tcp
# Everything else to 56892 is denied by ufw's default-deny
```

Never map RO-IPTV to a privileged port (<1024); terminate 80/443 at the proxy and
let it forward to 56892.

---

## 2. A reverse proxy / API gateway as the front door

Security.md §3: *"Use API gateways as a front door, with TLS termination, rate
limiting, and request filtering."*

Put RO-IPTV behind a reverse proxy that does **TLS termination, HTTP→HTTPS
redirect, edge rate limiting, and request filtering**. The app already trusts
`X-Forwarded-*` (`app.set('trust proxy', true)`) and emits **HSTS itself**, so the
proxy does not need to add HSTS (avoid emitting it twice with conflicting values).

Two key streaming concerns specific to this app:

- **Disable response buffering** for `/api/proxy` (HLS segments) and
  `/api/recordings/*/file` (range/seek + downloads) — buffering breaks live
  playback and seeking.
- **Generous timeouts** — live streams and recording downloads are long-lived.

### Caddy (automatic HTTPS, modern TLS by default)

```caddyfile
tv.example.com {
    encode zstd gzip

    # Edge rate limit (optional plugin) — complements the app's in-process limiter.
    # @api path /api/*
    # rate_limit @api { zone api { key {remote_host} events 600 window 1m } }

    reverse_proxy 127.0.0.1:56892 {
        flush_interval -1          # stream responses, no buffering (HLS/recordings)
        transport http {
            response_header_timeout 120s
            read_timeout 0          # allow long-lived streams
        }
    }
}
```

Caddy negotiates TLS 1.2/1.3 with a modern cipher suite and auto-renews
Let's Encrypt certs — no extra config needed.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name tv.example.com;

    ssl_certificate     /etc/letsencrypt/live/tv.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tv.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers off;
    ssl_stapling on;
    ssl_stapling_verify on;

    # Edge rate limit (defined in http{}: limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;)
    location /api/ {
        limit_req zone=api burst=40 nodelay;
        proxy_pass http://127.0.0.1:56892;
        include /etc/nginx/proxy_params;
        proxy_buffering off;            # stream HLS / recordings, don't buffer
        proxy_read_timeout 1h;          # long-lived streams
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host               $host;
    }

    location / {
        proxy_pass http://127.0.0.1:56892;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
    }
}

server {                                 # redirect HTTP → HTTPS
    listen 80;
    server_name tv.example.com;
    return 301 https://$host$request_uri;
}
```

**Request filtering at the edge** (optional, recommended if Internet-exposed):
block or challenge requests to `/api/proxy` and `/api/epg` from unknown clients,
add a WAF/Cloudflare in front, and keep the app's `CORS_ALLOWED_ORIGINS` set to
your real hostnames (already done via `.env`).

---

## 3. Inter-container communication & segmentation

Security.md §3: *"Disable inter-container communication by default and use
explicit network policies or segmentation."*

RO-IPTV ships on the **default compose network** for simplicity. To segment it
from unrelated containers on the same host:

**Option A — loopback only (simplest).** Publish `127.0.0.1:56892:56892` (see §1)
and have the reverse proxy connect over the host loopback. The app then shares no
Docker network with anything; nothing container-to-container can reach it.

**Option B — a dedicated proxy network.** Put only the reverse proxy and RO-IPTV
on one user-defined bridge, and don't attach other services to it:

```yaml
services:
  ro-iptv:
    networks: [edge]
    # drop the public "ports:" mapping if the proxy is on this network
networks:
  edge:
    driver: bridge
    # internal: true   # uncomment if the app needs NO outbound… (NOT for RO-IPTV:
    #                   # it must fetch upstream playlists/EPG/streams, so leave it routable)
```

> RO-IPTV **needs outbound** access to fetch playlists, EPG and streams, so do
> **not** mark its network `internal: true`. Segmentation here is about limiting
> *who can reach it*, not cutting its egress.

**Disable ICC on the default bridge** (host-wide hardening) in
`/etc/docker/daemon.json`, then give each stack its own explicit network:

```json
{ "icc": false, "userland-proxy": false, "no-new-privileges": true,
  "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

---

## 4. TLS strength & certificate validation

Security.md §3: *"Encrypt all external traffic with strong TLS and up-to-date
ciphers; pin or validate certificates between internal services where practical."*

- **External:** TLS 1.2+ (prefer 1.3), managed certs (Let's Encrypt). The app
  already sends HSTS (`max-age` configurable via `HSTS_MAX_AGE`), so once you've
  confirmed HTTPS works everywhere you may add `includeSubDomains`/`preload` at
  the proxy or bump the app's HSTS — only after you're sure all subdomains are
  HTTPS. Verify with [SSL Labs](https://www.ssllabs.com/ssltest/) or
  `testssl.sh`.
- **Upstream fetches (EPG/playlists/streams):** Node's `fetch` (undici) validates
  TLS certificates **by default**. Do **not** set `NODE_TLS_REJECT_UNAUTHORIZED=0`
  — it would disable that validation globally. Some public IPTV/EPG sources are
  HTTP-only; those are proxied as-is and simply aren't encrypted end-to-end (an
  inherent property of the source, not the app).
- **Internal service-to-service:** N/A — RO-IPTV is a single container with no
  internal service mesh.

---

## 5. If you run an orchestrator (Swarm / Kubernetes)

Security.md §3: *"encrypt overlay networks and segregate management plane from
data plane."* Only relevant if you move off plain `docker compose`:

- **Docker Swarm:** create overlay networks with `--opt encrypted`; store
  `CORS_ALLOWED_ORIGINS` etc. as Swarm **secrets/configs** rather than env where
  sensitive; keep manager nodes off the data path.
- **Kubernetes:** default-deny `NetworkPolicy`, then allow only ingress-controller
  → RO-IPTV on 56892 and egress to the Internet (for upstream fetches); run with
  the same `securityContext` the compose file already encodes (non-root,
  read-only rootfs, drop all caps, `allowPrivilegeEscalation: false`, seccomp
  `RuntimeDefault`); mount `/data` as a PVC and `/tmp` as `emptyDir`.

---

## Operator checklist (§3)

- [ ] Port published only as needed (`127.0.0.1:` for proxy-only, or firewalled LAN).
- [ ] Host firewall scopes 56892 to the proxy/LAN; default-deny elsewhere.
- [ ] Reverse proxy terminates TLS (1.2/1.3, modern ciphers, auto-renew).
- [ ] HTTP→HTTPS redirect in place; HTTPS confirmed before tightening HSTS.
- [ ] Proxy buffering **off** + long timeouts for `/api/proxy` and recordings.
- [ ] `CORS_ALLOWED_ORIGINS` set to your real hostnames (in `.env`).
- [ ] Edge rate limiting / WAF if Internet-exposed (complements the app limiter).
- [ ] App segmented from unrelated containers (loopback publish or dedicated network).
- [ ] `NODE_TLS_REJECT_UNAUTHORIZED` is **not** set to `0`.
- [ ] `make scan` clean before each deploy (§5).

---

*See also: [`Security.md`](../Security.md) (full checklist), the in-repo
hardening in [`../Dockerfile`](../Dockerfile) and
[`../docker-compose.yml`](../docker-compose.yml), and the `make scan` target in
[`../Makefile`](../Makefile).*
