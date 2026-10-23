# ❄ AVM Panel — KVM, LXC & Docker Machine Panel

Glacier-blue panel for running **KVM virtual machines**, **LXC containers** (both via [Incus](https://linuxcontainers.org/incus/)) and **Docker containers** — all managed the same way: console, files, ports, usage, sshx.

| Where you install it | What you can create |
|---|---|
| Dedicated server / KVM VPS with `/dev/kvm` | **KVM + LXC + Docker** |
| KVM VPS without nested virtualization | **LXC + Docker** |
| **LXC / OpenVZ container VPS** | **Docker** (and LXC too if the host enabled nesting) |

## Install
1. Push these files to the root of your GitHub repo (`install.sh`, `panel/`, `node/`, `docker/`, `README.md`, `.gitignore`).
2. Set `REPO_URL` at the top of `install.sh` to your repo.
3. On the server (Debian 12/13 or Ubuntu 22.04/24.04, as root):
   ```bash
   git clone https://github.com/<you>/<repo>.git && cd <repo>
   sudo bash install.sh
   ```
The installer checks the host and asks which machine types to enable:

```
1) KVM + LXC + Docker   (Incus + Docker)   <- default on servers / KVM VPS
2) Docker only                              <- default inside LXC / OpenVZ
3) KVM + LXC only       (Incus)
```
Non-interactive: `ENGINES=all|docker|incus sudo -E bash install.sh`.
It then installs Incus and/or Docker, Node.js and pm2, sets up the **local node**, and starts **node daemon → panel**. Choose **1) Public IP** or **2) Cloudflare Tunnel**.

### Installing inside an LXC container VPS
- Docker inside LXC needs the host to allow **nesting** (+ **keyctl** for unprivileged containers). On Proxmox: *Container → Options → Features → nesting, keyctl*. Most LXC VPS providers already enable this for Docker.
- Port forwarding needs working `iptables` inside the container (the installer checks and warns).
- If Incus fails inside the container the installer keeps going in Docker-only mode.

## Features
**Users** — machine list · per-machine sidebar: **Console** (web terminal), **File manager**, **Ports** (expose with ufw), **System usage** (CPU / RAM / disk / network of the machine itself) and **Settings** (root password) · top bar **Start / Stop / Restart / sshx**.
**sshx** — runs `curl -sSf https://sshx.io/get | sh -s run` inside the machine and shows the share link.
**Admin area** — Overview · **Nodes** (local + remote, IP pool, shows which engines each node has) · **Create VM** (owner, node, **KVM / LXC / Docker**, image, CPU/RAM/disk, dedicated IP) · **Virtual machines** · **Ports** · **User management** · **Settings**.

### Creating Docker machines
Pick **Docker** as the type in *Create VM*, then:
- **Image** — presets (Ubuntu, Debian, Alpine, Rocky, Alma, Fedora, Arch, Node.js, Python, Nginx, Apache, Redis), images already downloaded on the node (*On this node*), or **Custom** — any Docker Hub / registry image such as `mariadb:11` or `ghcr.io/user/app:1.0`.
- **Keep running with a shell** — on for OS images (`ubuntu`, `debian`…), which would otherwise exit immediately; off for app images (`nginx`, `redis`…) so their own command runs. Presets set this for you.
- **Environment variables** — optional, one `KEY=value` per line.
- CPU and RAM are hard limits. The disk limit only applies where Docker's storage driver supports quotas (overlay2 on XFS with `pquota`, btrfs, zfs); otherwise the container is created without it and usage is still shown.
- Docker machines restart automatically after a reboot (`--restart unless-stopped`) unless you stopped them.

## Web hosting (static HTML + PHP, auto SSL)
Admin → **Create website**: owner, node, **Static HTML** or **PHP** (8.1–8.4), domain + subdomain (**@** = main domain, or e.g. `blog`), optional `www`, and limits: disk, **bandwidth per month**, and for PHP vCPU, RAM and number of databases.

Each website gets its own page with **File manager** (`public_html`), **System usage** (CPU/RAM for PHP, disk, monthly bandwidth, requests), **Databases** (PHP only: create DB + user, passwords, **phpMyAdmin**), **Logs** (access log + error log) and **Settings & domain** (DNS records to add, live DNS/SSL check, change domain).

**Domain flow (like CloudPanel):** add an **A record** — Name `@` (or your subdomain) → the node's IP. As soon as DNS points to the server, a free Let's Encrypt certificate is issued automatically and HTTP redirects to HTTPS. With Cloudflare, use *DNS only* (grey cloud) until SSL is active, or keep the orange cloud with SSL mode **Full**.

How it runs (all on the node's Docker):
- `avm-caddy` — web server on ports **80/443** (host network), automatic HTTPS, serves static sites directly. Needs 80 + 443 free and open (ufw is opened automatically).
- `avm-web-xxxxxxxx` — one PHP/Apache container per PHP site (`avm-php:<version>` is built once per version: mysqli, pdo_mysql, gd, zip, intl, opcache…; `.htaccess` works).
- `avm-mariadb` — shared MariaDB; apps connect to host **`avm-mariadb`**, port 3306.
- `avm-pma` — phpMyAdmin, opened through the panel at `/pma/<node>/` (only logged-in owners of a PHP site on that node, and admins).
- Files live in `/var/lib/avm-web/sites/<site>/public_html` on the node. Bandwidth is counted from the access log; when the monthly limit is reached visitors get a "Bandwidth limit exceeded" page until the next month.

## Networking
- **NAT (default):** each machine gets a private IP — on `incusbr0` for KVM/LXC, on the `avm-docker` network (`10.89.0.0/24`, set `dockerSubnet` in `node/config.json` to change) for Docker. Ports are forwarded from the node IP (range 20000-30000, configurable per node) with iptables + ufw. When Docker is installed, AVM also adds its rules to Docker's `DOCKER-USER` chain so forwards (and the Incus bridge) keep working.
- **Dedicated IP:** add extra IPv4s to a node's IP pool (Nodes → Edit). Assign one to a machine at creation or later (1:1 NAT). Works for all three types.

## GitHub / Discord login
Admin → Settings: paste Client ID + Secret, copy the shown **callback URL** into the GitHub OAuth app / Discord application (OAuth2 → Redirects), then switch it on.

## Docker deployment of the panel itself (experimental)
Runs Incus + node + panel in one **privileged** container; Docker machines are created on the host's Docker through the mounted socket. Only on a server where you control Docker (not Railway / shared container hosts).
```bash
git clone https://github.com/adityazdomainzz-code/AVM.git && cd AVM
docker compose -f docker/docker-compose.yml up -d --build
docker logs -f avm          # shows the admin password on first start
```
Uses host networking (panel on `8000`, machine ports `20000-30000`). Data lives in the `avm-data` and `avm-incus` volumes.

## Extra host
`sudo bash install.sh --node-only` on the new server → copy the printed URL + token into Admin → Nodes → Add node. The new node can be a different kind of host (e.g. a Docker-only LXC VPS).

## Commands
```bash
pm2 logs avm-panel | pm2 logs avm-node
pm2 restart avm-panel avm-node
cd /opt/avm/panel && node src/cli.js admin NewPass123 && pm2 restart avm-panel   # reset admin
docker ps --filter label=avm=1                                                  # AVM Docker machines
```
Ports: panel `8000`, node daemon `8090` (local only), machine forwards `20000-30000`.
