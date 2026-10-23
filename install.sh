#!/usr/bin/env bash
# =====================================================================
#  AVM Panel installer - KVM + LXC (Incus) and Docker machine panel
#  Works on a dedicated server / KVM VPS (KVM + LXC + Docker) and also
#  inside an LXC / OpenVZ container VPS (Docker containers, plus LXC if
#  the host allows nesting).
#
#  Usage:  sudo bash install.sh              panel + local node
#          sudo bash install.sh --node-only  extra host (node daemon only)
#  Non-interactive: ENGINES=all|docker|incus  (default: all on servers,
#                   docker inside LXC / OpenVZ)
# =====================================================================
set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/adityazdomainzz-code/AVM.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/avm}"
NODE_PORT="${NODE_PORT:-8090}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /nonexistent)"
NODE_ONLY=0; [[ "${1:-}" == "--node-only" ]] && NODE_ONLY=1

C=$'\e[38;5;45m'; W=$'\e[97m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
step() { echo; echo "${C}${B}❄ $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo; echo "  ${R}✘ $*${N}"; exit 1; }
HAS_TTY=0; { : </dev/tty; } 2>/dev/null && HAS_TTY=1
ask()  { local q="$1" def="${2:-}" v=""; if [ "$HAS_TTY" = 1 ]; then read -rp "  ${W}${q}${N}${def:+ [$def]}: " v </dev/tty || true; fi; echo "${v:-$def}"; }
asks() { local q="$1" v=""; if [ "$HAS_TTY" = 1 ]; then read -rsp "  ${W}${q}${N}: " v </dev/tty || true; echo >&2; fi; echo "$v"; }
# log in /var/log (a leftover /tmp file from a non-root run cannot be written by root: fs.protected_regular)
LOG=/var/log/avm-install.log; { : > "$LOG"; } 2>/dev/null || LOG="$(mktemp /tmp/avm-install.XXXXXX.log)"
apt_i() { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >>"$LOG" 2>&1 || { dpkg --configure -a >>"$LOG" 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >>"$LOG" 2>&1; }; }

cat <<EOF
${C}
     █████╗ ██╗   ██╗███╗   ███╗
    ██╔══██╗██║   ██║████╗ ████║   ${W}Virtual Machine Panel${C}
    ███████║██║   ██║██╔████╔██║   ${W}KVM  ·  LXC  ·  Docker${C}
    ██╔══██║╚██╗ ██╔╝██║╚██╔╝██║
    ██║  ██║ ╚████╔╝ ██║ ╚═╝ ██║
    ╚═╝  ╚═╝  ╚═══╝  ╚═╝     ╚═╝${N}
EOF

[ "$(id -u)" -eq 0 ] || die "Run as root:  sudo bash install.sh"
command -v apt-get >/dev/null || die "AVM supports Debian 12/13 and Ubuntu 22.04/24.04 (apt based)"

# ---------------------------------------------------------------- host checks
step "[1/8] Checking this machine"
# "systemd-detect-virt -c" prints "none" AND exits 1 on non-containers, so only keep its first line
VIRT="$(systemd-detect-virt -c 2>/dev/null | head -n1)"; VIRT="${VIRT:-none}"
IN_CT=0; IN_DOCKER=0
CODESPACE="${CODESPACE_NAME:-}"
if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "$CODESPACE" ]; then
  # inside Docker / Podman (GitHub Codespaces, Gitpod, a Docker VPS ...): Docker-only mode, no Incus, no systemd
  IN_DOCKER=1; IN_CT=1; VIRT=docker; ENGINES=docker
  ok "Running inside a Docker container${CODESPACE:+ (GitHub Codespace $CODESPACE)} - Docker-only mode"
  warn "Docker VPS, Discord bots and Minecraft work here. Websites (ports 80/443) and LXC/KVM do not."
elif grep -qa 'container=' /proc/1/environ 2>/dev/null || { [ -d /proc/vz ] && [ ! -d /proc/bc ]; } || [ "$VIRT" != none ]; then
  IN_CT=1; [ "$VIRT" = none ] && { [ -d /proc/vz ] && VIRT=openvz || VIRT=lxc; }
  ok "Running inside a container VPS (${VIRT}) - Docker mode available"
else
  HV="$(systemd-detect-virt 2>/dev/null | head -n1)"; [ -z "$HV" ] || [ "$HV" = none ] && HV=bare-metal
  ok "Not a container ($HV)"
fi
KVM=0
if [ -e /dev/kvm ] || grep -Eq '(vmx|svm)' /proc/cpuinfo; then
  [ "$IN_CT" = 0 ] && { modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true; }
  [ -e /dev/kvm ] && KVM=1
fi
. /etc/os-release
ok "OS: $PRETTY_NAME"

# which engines: Incus (KVM + LXC) and/or Docker
ENGINES="${ENGINES:-}"
if [ -z "$ENGINES" ]; then
  DEF=1; [ "$IN_CT" = 1 ] && DEF=2
  [ -f "$INSTALL_DIR/.install.env" ] && grep -q '^ENGINES=' "$INSTALL_DIR/.install.env" && ENGINES="$(. "$INSTALL_DIR/.install.env"; echo "${ENGINES:-}")"
  if [ -z "$ENGINES" ]; then
    echo; echo "  ${B}Which machine types should this node run?${N}"
    echo "    ${C}1)${N} KVM + LXC + Docker   (Incus + Docker)$([ "$IN_CT" = 0 ] && echo '   <- recommended')"
    echo "    ${C}2)${N} Docker only$([ "$IN_CT" = 1 ] && echo '                          <- recommended inside LXC / OpenVZ')"
    echo "    ${C}3)${N} KVM + LXC only       (Incus)"
    case "$(ask 'Choose 1, 2 or 3' "$DEF")" in 2) ENGINES=docker;; 3) ENGINES=incus;; *) ENGINES=all;; esac
  fi
fi
case "$ENGINES" in all|docker|incus) ;; *) die "ENGINES must be all, docker or incus";; esac
WANT_INCUS=0; WANT_DOCKER=0
[ "$ENGINES" != docker ] && WANT_INCUS=1
[ "$ENGINES" != incus ] && WANT_DOCKER=1
if [ "$WANT_INCUS" = 1 ]; then
  if [ "$IN_CT" = 1 ]; then warn "Incus inside a container needs nesting enabled by your host (Proxmox: Options -> Features -> nesting + keyctl)"
  elif [ "$KVM" = 1 ]; then ok "KVM available - KVM VMs + LXC containers"
  else warn "No /dev/kvm (nested virtualization off?) - LXC containers only, no KVM VMs"; fi
fi
[ "$WANT_DOCKER" = 1 ] && ok "Docker containers enabled"

# ---------------------------------------------------------------- packages
step "[2/8] Base packages"
apt-get update -qq >>"$LOG" 2>&1 || warn "apt-get update had errors (continuing)"
apt_i git curl ca-certificates openssl tar gnupg iptables iproute2 || die "Package install failed - see $LOG"
ok "git, curl, iptables ready"

# ---------------------------------------------------------------- clone + verify
step "[3/8] Cloning $REPO_URL"
TMP="$(mktemp -d)"; SRC="$TMP/repo"
git clone -q --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$SRC" 2>>"$LOG" || git clone -q --depth 1 "$REPO_URL" "$SRC" 2>>"$LOG" || { warn "Could not clone the repo"; mkdir -p "$SRC"; }
REQUIRED=(panel/package.json panel/src/server.js panel/src/db.js panel/src/cf.js panel/src/cli.js panel/public/index.html panel/public/css/style.css panel/public/js/app.js panel/public/js/ice.js node/package.json node/src/daemon.js node/src/incus.js node/src/docker.js node/src/net.js node/src/web.js node/src/bots.js node/src/files.js node/src/mc.js panel/src/mc.js panel/src/mcdl.js panel/public/js/mc.js panel/public/js/web.js panel/public/js/bots.js)
BASE=""; found="$(find "$SRC" -maxdepth 4 -path '*/node/src/incus.js' -not -path '*/node_modules/*' 2>/dev/null | head -n1)"; [ -n "$found" ] && BASE="${found%/node/src/incus.js}"
MISSING=0
for f in "${REQUIRED[@]}"; do if [ -n "$BASE" ] && [ -f "$BASE/$f" ]; then echo "    ${G}✔${N} $f"; else echo "    ${R}✘${N} $f"; MISSING=$((MISSING+1)); fi; done
if [ "$MISSING" -gt 0 ]; then
  ALL=1; for f in "${REQUIRED[@]}"; do [ -f "$SCRIPT_DIR/$f" ] || ALL=0; done
  [ "$ALL" = 1 ] || die "$MISSING file(s) missing. Push the AVM zip contents (panel/, node/, install.sh) to the repo root."
  warn "Repo incomplete - using the files next to install.sh"; BASE="$SCRIPT_DIR"
else ok "All ${#REQUIRED[@]} files found"; fi
mkdir -p "$INSTALL_DIR"
tar -C "$BASE" --exclude=node_modules --exclude=panel/data --exclude=node/data --exclude=panel/config.json --exclude=node/config.json -cf - panel node | tar -C "$INSTALL_DIR" -xf - || die "Copy failed"
cp -f "$BASE/install.sh" "$INSTALL_DIR/install.sh" 2>/dev/null || true
ok "Installed to $INSTALL_DIR (data + config kept on re-install)"

# ---------------------------------------------------------------- engines
step "[4/8] Container engines"
INCUS_OK=0; DOCKER_OK=0
incus_fail() {
  if [ "$WANT_DOCKER" = 1 ]; then warn "$1"; warn "Continuing without Incus - this node will run Docker containers only"
  else die "$1"; fi
}
install_incus() {
  if ! command -v incus >/dev/null; then
    mkdir -p /etc/apt/keyrings
    if curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc 2>>"$LOG"; then
      cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOS
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${VERSION_CODENAME}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
EOS
      apt-get update -qq >>"$LOG" 2>&1
    fi
    apt_i incus || { warn "Zabbly repo failed - trying distro package"; rm -f /etc/apt/sources.list.d/zabbly-incus-stable.sources; apt-get update -qq >>"$LOG" 2>&1; apt_i incus qemu-system-x86 ovmf || { incus_fail "Could not install Incus - see $LOG"; return 1; }; }
  fi
  systemctl enable --now incus >>"$LOG" 2>&1 || true
  for _ in $(seq 1 20); do incus info >/dev/null 2>&1 && break; sleep 1; done
  incus info >/dev/null 2>&1 || { incus_fail "Incus is installed but not responding - see: journalctl -u incus"; return 1; }
  if [ -z "$(incus storage list --format csv 2>/dev/null)" ]; then
    incus admin init --auto >>"$LOG" 2>&1 || { incus_fail "incus admin init failed - see $LOG"; return 1; }
    ok "Incus initialised (storage pool + incusbr0 NAT bridge)"
  fi
  incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0 >>"$LOG" 2>&1
  ok "Incus $(incus version 2>/dev/null | tail -n1 | awk '{print $NF}') ready · bridge $(incus network get incusbr0 ipv4.address 2>/dev/null)"
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow in on incusbr0 >/dev/null; ufw route allow in on incusbr0 >/dev/null; ufw route allow out on incusbr0 >/dev/null
    ok "ufw active - bridge traffic allowed (port rules are added per VM)"
  fi
  INCUS_OK=1
}
install_docker() {
  if ! command -v docker >/dev/null; then
    GD="$(mktemp /tmp/get-docker.XXXXXX.sh)"; curl -fsSL https://get.docker.com -o "$GD" 2>>"$LOG" && sh "$GD" >>"$LOG" 2>&1 \
      || { warn "get.docker.com failed - trying the distro package"; apt_i docker.io; }
  fi
  command -v docker >/dev/null || { warn "Docker could not be installed - see $LOG"; return 1; }
  if ! docker info >/dev/null 2>&1; then
    systemctl enable --now docker >>"$LOG" 2>&1 || service docker start >>"$LOG" 2>&1 || true
    # no systemd (Docker container / Codespace): start dockerd ourselves
    if ! docker info >/dev/null 2>&1 && [ "$IN_DOCKER" = 1 ] && command -v dockerd >/dev/null; then
      [ -x /usr/local/share/docker-init.sh ] && /usr/local/share/docker-init.sh true >>"$LOG" 2>&1
      docker info >/dev/null 2>&1 || { nohup dockerd >/var/log/dockerd.log 2>&1 & }
    fi
  fi
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  if ! docker info >/dev/null 2>&1; then
    warn "Docker is installed but not running - see: journalctl -u docker"
    [ "$IN_DOCKER" = 1 ] && warn "Docker cannot run in this container. Codespaces: add the docker-in-docker feature to .devcontainer/devcontainer.json; other containers need --privileged (see /var/log/dockerd.log)"
    [ "$IN_CT" = 1 ] && [ "$IN_DOCKER" = 0 ] && warn "Inside LXC the host must allow nesting + keyctl (Proxmox: Options -> Features)"
    return 1
  fi
  DOCKER_OK=1
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) ready · network avm-docker 10.89.0.0/24"
}
[ "$WANT_INCUS" = 1 ] && { install_incus || true; }
[ "$WANT_DOCKER" = 1 ] && { install_docker || true; }
[ "$INCUS_OK" = 1 ] || [ "$DOCKER_OK" = 1 ] || die "Neither Incus nor Docker is working on this machine - see $LOG"
[ "$INCUS_OK" = 1 ] && [ -e /dev/kvm ] && KVM=1 || KVM=0
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-avm.conf 2>/dev/null || true
iptables -w -t nat -nL PREROUTING >/dev/null 2>&1 && ok "iptables usable (port forwarding)" || warn "iptables is not usable here - port forwarding will not work (container VPS without NET_ADMIN?)"

# ---------------------------------------------------------------- node.js
step "[5/8] Node.js + pm2"
NODE_MAJOR=0; command -v node >/dev/null && NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >>"$LOG" 2>&1 && apt_i nodejs; fi
command -v node >/dev/null || die "Node.js install failed"
command -v pm2 >/dev/null || npm install -g pm2 --loglevel=error >>"$LOG" 2>&1 || { tail -n 15 "$LOG"; die "pm2 install failed"; }
ok "Node.js $(node -v) · pm2 $(pm2 -v 2>/dev/null | tail -n1)"

# ---------------------------------------------------------------- config
step "[6/8] Configuration"
port_free() { node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"0.0.0.0",()=>s.close(()=>process.exit(0)))' "$1" 2>/dev/null; }
next_free() { local p="$1"; for _ in $(seq 1 50); do port_free "$p" && { echo "$p"; return; }; p=$((p+1)); done; echo "$1"; }
PUBLIC_IP="$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
CS_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
NODE_CFG="$INSTALL_DIR/node/config.json"; PANEL_CFG="$INSTALL_DIR/panel/config.json"; ENV_FILE="$INSTALL_DIR/.install.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
if [ ! -f "$NODE_CFG" ]; then
  pm2 delete avm-node >/dev/null 2>&1 || true
  FREE="$(next_free "$NODE_PORT")"; [ "$FREE" != "$NODE_PORT" ] && warn "Port $NODE_PORT busy - node uses $FREE"; NODE_PORT="$FREE"
  NH=127.0.0.1; [ "$NODE_ONLY" = 1 ] && NH=0.0.0.0
  T="$(openssl rand -hex 32)" P="$NODE_PORT" H="$NH" CFG="$NODE_CFG" node -e 'const e=process.env;require("fs").writeFileSync(e.CFG,JSON.stringify({port:+e.P,host:e.H,token:e.T,bridge:"incusbr0",dockerNetwork:"avm-docker",dockerSubnet:"10.89.0.0/24"},null,2))'
  chmod 600 "$NODE_CFG"; ok "Node config created"
else ok "Keeping node config"; fi
NODE_TOKEN="$(node -e 'console.log(require(process.argv[1]).token)' "$NODE_CFG")"
NODE_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$NODE_CFG")"

ACCESS_MODE="${ACCESS_MODE:-1}"
if [ "$NODE_ONLY" = 0 ]; then
  if [ ! -f "$PANEL_CFG" ]; then
    echo; echo "  ${B}How should people open the panel?${N}"
    echo "    ${C}1)${N} Public IP          http://${PUBLIC_IP}:PORT"
    echo "    ${C}2)${N} Cloudflare Tunnel  https://panel.yourdomain.com"
    ACCESS_MODE="$(ask 'Choose 1 or 2' 1)"; [[ "$ACCESS_MODE" =~ ^[12]$ ]] || ACCESS_MODE=1
    pm2 delete avm-panel >/dev/null 2>&1 || true
    DP="$(next_free 8000)"; PANEL_PORT="$(ask 'Panel port' "$DP")"
    PUBLIC_IP="$(ask 'Public IP of this server' "$PUBLIC_IP")"
    AU="$(ask 'Admin username' admin)"; AE="$(ask 'Admin email' admin@localhost)"; AP="$(asks 'Admin password (empty = generate)')"
    GEN=0; if [ "${#AP}" -lt 6 ]; then AP="$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)"; GEN=1; fi
    PH=0.0.0.0; [ "$ACCESS_MODE" = 2 ] && PH=127.0.0.1
    if [ "$ACCESS_MODE" = 2 ] && [ -z "${CF_TUNNEL_TOKEN:-}" ]; then
      echo "  Cloudflare → Zero Trust → Networks → Tunnels → create tunnel, add Public Hostname → ${B}http://localhost:${PANEL_PORT}${N}"
      CF_TUNNEL_TOKEN="$(ask 'Paste tunnel token' '')"; [ -n "$CF_TUNNEL_TOKEN" ] || { warn "No token - using Public IP mode"; ACCESS_MODE=1; PH=0.0.0.0; }
    fi
    P="$PANEL_PORT" H="$PH" AU="$AU" AE="$AE" AP="$AP" NT="$NODE_TOKEN" NP="$NODE_PORT" IP="$PUBLIC_IP" CFG="$PANEL_CFG" node -e '
      const e=process.env;require("fs").writeFileSync(e.CFG,JSON.stringify({port:+e.P,host:e.H,admin:{username:e.AU,email:e.AE,password:e.AP},localNode:{url:"http://127.0.0.1:"+e.NP,token:e.NT,publicIp:e.IP}},null,2))'
    chmod 600 "$PANEL_CFG"
    printf 'ACCESS_MODE=%q\nCF_TUNNEL_TOKEN=%q\nENGINES=%q\n' "$ACCESS_MODE" "${CF_TUNNEL_TOKEN:-}" "$ENGINES" > "$ENV_FILE"; chmod 600 "$ENV_FILE"
    ok "Panel config created"
  else ok "Keeping panel config"; fi
  PANEL_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$PANEL_CFG")"
fi

# ---------------------------------------------------------------- deps
step "[7/8] Installing dependencies"
npm_dir() { # npm install with the error shown; retries once with build tools (native modules)
  echo "== npm install in $1 (node $(node -v), npm $(npm -v))" >>"$LOG"
  ( cd "$1" && npm install --omit=dev --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 ) && return 0
  warn "npm install failed in $1 - installing build tools and trying again"
  apt_i build-essential python3 make g++
  ( cd "$1" && npm install --omit=dev --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 ) && return 0
  echo; tail -n 25 "$LOG" | sed 's/^/    /'; return 1
}
npm_dir "$INSTALL_DIR/node" || die "npm install failed (node) - full log: $LOG"
ok "node daemon (incl. web terminal)"
[ -d "$INSTALL_DIR/node/node_modules/@homebridge/node-pty-prebuilt-multiarch" ] || warn "Web terminal module (node-pty) not available for node $(node -v) - VPS console needs it, bots + Minecraft consoles work"
if [ "$NODE_ONLY" = 0 ]; then npm_dir "$INSTALL_DIR/panel" || die "npm install failed (panel) - full log: $LOG"; ok "panel"; fi

# ---------------------------------------------------------------- start
step "[8/8] Starting services one by one"
wait_http() { for _ in $(seq 1 30); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
pm2 delete avm-node >/dev/null 2>&1 || true
pm2 start "$INSTALL_DIR/node/src/daemon.js" --name avm-node --cwd "$INSTALL_DIR/node" >/dev/null || die "Could not start node"
wait_http "http://127.0.0.1:${NODE_PORT}/health" && ok "Node daemon online   :${NODE_PORT}" || die "Node did not start - pm2 logs avm-node"
if [ "$NODE_ONLY" = 0 ]; then
  pm2 delete avm-panel >/dev/null 2>&1 || true
  pm2 start "$INSTALL_DIR/panel/src/server.js" --name avm-panel --cwd "$INSTALL_DIR/panel" >/dev/null || die "Could not start panel"
  wait_http "http://127.0.0.1:${PANEL_PORT}/health" && ok "Panel online         :${PANEL_PORT}" || die "Panel did not start - pm2 logs avm-panel"
  if [ "${ACCESS_MODE:-1}" = 2 ] && [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    if ! command -v cloudflared >/dev/null; then
      case "$(uname -m)" in x86_64) CA=amd64;; aarch64|arm64) CA=arm64;; *) CA=amd64;; esac
      curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CA" && chmod +x /usr/local/bin/cloudflared
    fi
    pm2 delete avm-tunnel >/dev/null 2>&1 || true
    pm2 start "$(command -v cloudflared)" --name avm-tunnel -- tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >/dev/null && ok "Cloudflare tunnel started" || warn "Tunnel failed - pm2 logs avm-tunnel"
  fi
fi
pm2 save >/dev/null 2>&1
if [ "$IN_DOCKER" = 1 ]; then
  # containers have no systemd: one command brings everything back after a restart
  cat > "$INSTALL_DIR/start.sh" <<'EOS'
#!/usr/bin/env bash
# AVM start inside a Docker container / Codespace (no systemd): dockerd + pm2 processes
docker info >/dev/null 2>&1 || { [ -x /usr/local/share/docker-init.sh ] && /usr/local/share/docker-init.sh true >/dev/null 2>&1; }
docker info >/dev/null 2>&1 || { nohup dockerd >/var/log/dockerd.log 2>&1 & for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; }
pm2 resurrect >/dev/null 2>&1 || true
pm2 ls
EOS
  chmod +x "$INSTALL_DIR/start.sh"
  ok "After a container / Codespace restart run:  sudo bash $INSTALL_DIR/start.sh"
else
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 && ok "Auto-start on boot enabled"
fi
rm -rf "$TMP"

echo; echo "${C}${B}  ❄ ═══════════════════════════════════════════════ ❄${N}"
if [ "$NODE_ONLY" = 1 ]; then
  echo "  ${G}${B}Node ready!${N} Add it in Admin area → Nodes:"
  echo "    Daemon URL : ${B}http://${PUBLIC_IP}:${NODE_PORT}${N}"
  echo "    Token      : ${B}${NODE_TOKEN}${N}"
  echo "    Public IP  : ${B}${PUBLIC_IP}${N}"
  echo "    Types      : $([ "$KVM" = 1 ] && echo 'KVM ')$([ "$INCUS_OK" = 1 ] && echo 'LXC ')$([ "$DOCKER_OK" = 1 ] && echo 'Docker')"
  echo "  Allow TCP ${NODE_PORT} from the panel server, and the VM port range (default 20000-30000)."
else
  echo "  ${G}${B}AVM Panel is ready!${N}"
  if [ "${ACCESS_MODE:-1}" = 2 ] && [ -n "${CF_TUNNEL_TOKEN:-}" ]; then echo "    Panel : ${B}https://<your tunnel hostname>${N}"
  elif [ -n "$CODESPACE" ]; then echo "    Panel : ${B}https://${CODESPACE}-${PANEL_PORT}.${CS_DOMAIN}${N}"
    echo "            (VS Code → Ports tab → port ${PANEL_PORT} → right click → Port Visibility → Public, so others can open it)"
  else echo "    Panel : ${B}http://${PUBLIC_IP}:${PANEL_PORT}${N}"; fi
  [ -n "${AU:-}" ] && echo "    Login : ${B}${AU}${N}"
  [ "${GEN:-0}" = 1 ] && echo "    Pass  : ${B}${AP}${N}   (generated - change it in Account)"
  echo "    Types : $([ "$KVM" = 1 ] && echo 'KVM ')$([ "$INCUS_OK" = 1 ] && echo 'LXC ')$([ "$DOCKER_OK" = 1 ] && echo 'Docker')"
  if [ "$IN_DOCKER" = 1 ]; then
    echo "    ${Y}Docker container mode:${N} Docker VPS, Discord bots and Minecraft work. Websites, LXC and KVM are off."
    [ -n "$CODESPACE" ] && echo "    Codespaces only forwards HTTP ports - VPS/Minecraft game ports are not reachable from the internet (use playit.gg / a tunnel), and the Codespace stops when idle."
  else
    echo "    Open the VM port range 20000-30000 (TCP/UDP) in your provider firewall."
    [ "$DOCKER_OK" = 1 ] && echo "    Websites: open ports 80 + 443 in your provider firewall (free SSL needs them)."
  fi
  echo "    Logs  : pm2 logs avm-panel | pm2 logs avm-node      Install log: $LOG"
fi
echo "${C}${B}  ❄ ═══════════════════════════════════════════════ ❄${N}"
