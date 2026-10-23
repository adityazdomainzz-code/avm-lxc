#!/usr/bin/env bash
# =====================================================================
#  AVM fix + update
#  Copies the latest panel/ + node/ from this repo to /opt/avm (config,
#  data and node_modules are kept), then repairs the common problems:
#    - broken pm2 "avm-tunnel" (invalid token / duplicate of systemd cloudflared)
#    - cloudflared QUIC timeouts  -> HTTP/2
#    - LXC inside an LXC VPS: idmap error ("missing" machines), no IP (ufw/DHCP)
#    - Docker FORWARD DROP breaking the Incus bridge
#    - ports 80/443 for website hosting
#  Usage:  git clone https://github.com/adityazdomainzz-code/avm-lxc.git && cd avm-lxc && sudo bash fix.sh
#  Safe to run again any time.
# =====================================================================
set -uo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/avm}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C=$'\e[38;5;45m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
step() { echo; echo "${C}${B}❄ $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo; echo "  ${R}✘ $*${N}"; exit 1; }
LOG=/tmp/avm-fix.log; : > "$LOG"

[ "$(id -u)" -eq 0 ] || die "Run as root:  sudo bash fix.sh"
[ -d "$INSTALL_DIR/panel" ] && [ -d "$INSTALL_DIR/node" ] || die "AVM is not installed in $INSTALL_DIR - run install.sh first"

# ---------------------------------------------------------------- 1. update files
step "[1/6] Updating AVM files"
if [ -d "$SRC/.git" ] && command -v git >/dev/null; then
  git -C "$SRC" pull -q --ff-only >>"$LOG" 2>&1 && ok "Repo pulled (git pull)" || warn "git pull failed - using the files as they are"
fi
REQUIRED=(panel/package.json panel/src/server.js panel/src/db.js panel/src/cli.js panel/public/index.html panel/public/css/style.css
  panel/public/js/app.js panel/public/js/web.js panel/public/js/ice.js node/package.json node/src/daemon.js node/src/incus.js
  node/src/docker.js node/src/net.js node/src/web.js)
MISSING=0; for f in "${REQUIRED[@]}"; do [ -f "$SRC/$f" ] || { echo "    ${R}✘${N} $f"; MISSING=$((MISSING+1)); }; done
[ "$MISSING" = 0 ] || die "$MISSING file(s) missing in $SRC - push all AVM files to the repo"
OLD_PKG="$(cat "$INSTALL_DIR/panel/package.json" "$INSTALL_DIR/node/package.json" 2>/dev/null | md5sum)"
tar -C "$SRC" --exclude=node_modules --exclude=panel/data --exclude=node/data --exclude=panel/config.json --exclude=node/config.json -cf - panel node \
  | tar -C "$INSTALL_DIR" -xf - || die "Copy failed"
cp -f "$SRC/install.sh" "$INSTALL_DIR/install.sh" 2>/dev/null; cp -f "$SRC/fix.sh" "$INSTALL_DIR/fix.sh" 2>/dev/null
ok "Copied panel/ + node/ to $INSTALL_DIR (config + data kept)"
NEW_PKG="$(cat "$INSTALL_DIR/panel/package.json" "$INSTALL_DIR/node/package.json" | md5sum)"
if [ "$OLD_PKG" != "$NEW_PKG" ] || [ ! -d "$INSTALL_DIR/node/node_modules" ] || [ ! -d "$INSTALL_DIR/panel/node_modules" ]; then
  ( cd "$INSTALL_DIR/node" && npm install --omit=dev --no-audit --no-fund --silent >>"$LOG" 2>&1 ) && ok "node dependencies" || warn "npm install (node) failed - see $LOG"
  ( cd "$INSTALL_DIR/panel" && npm install --omit=dev --no-audit --no-fund --silent >>"$LOG" 2>&1 ) && ok "panel dependencies" || warn "npm install (panel) failed - see $LOG"
else ok "Dependencies unchanged"; fi

# ---------------------------------------------------------------- 2. cloudflare tunnel
step "[2/6] Cloudflare tunnel"
SYS_CF=0; systemctl is-active --quiet cloudflared 2>/dev/null && SYS_CF=1
if pm2 describe avm-tunnel >/dev/null 2>&1; then
  BAD=0
  pm2 logs avm-tunnel --lines 30 --nostream 2>/dev/null | grep -qi "token is not valid" && BAD=1
  if [ "$SYS_CF" = 1 ] || [ "$BAD" = 1 ]; then
    pm2 delete avm-tunnel >/dev/null 2>&1
    [ -f "$INSTALL_DIR/.install.env" ] && sed -i 's|^CF_TUNNEL_TOKEN=.*|CF_TUNNEL_TOKEN=|' "$INSTALL_DIR/.install.env"
    ok "Removed pm2 avm-tunnel ($([ "$BAD" = 1 ] && echo 'invalid token' || echo 'systemd cloudflared already runs the tunnel'))"
  else ok "pm2 avm-tunnel looks fine"; fi
fi
if [ "$SYS_CF" = 1 ]; then
  if [ ! -f /etc/systemd/system/cloudflared.service.d/http2.conf ]; then
    EXEC="$(systemctl show -p ExecStart --value cloudflared | grep -o 'argv\[\]=[^;]*' | sed 's/argv\[\]=//' | head -n1)"
    if [ -n "$EXEC" ] && ! echo "$EXEC" | grep -q -- '--protocol'; then
      mkdir -p /etc/systemd/system/cloudflared.service.d
      printf '[Service]\nExecStart=\nExecStart=%s\n' "$(echo "$EXEC" | sed 's| tunnel | tunnel --protocol http2 |')" > /etc/systemd/system/cloudflared.service.d/http2.conf
      systemctl daemon-reload; systemctl restart cloudflared
      ok "cloudflared switched to HTTP/2 (no more QUIC timeouts)"
    else ok "cloudflared running"; fi
  else ok "cloudflared running (HTTP/2)"; fi
else
  pm2 describe avm-tunnel >/dev/null 2>&1 || warn "No Cloudflare tunnel running (fine if you use the public IP)"
fi

# ---------------------------------------------------------------- 3. incus (LXC / KVM)
step "[3/6] Incus (LXC / KVM)"
IN_CT=0; [ "$(awk 'NR==1{print $3}' /proc/self/uid_map 2>/dev/null)" != "4294967295" ] && IN_CT=1
if command -v incus >/dev/null && incus info >/dev/null 2>&1; then
  if [ "$IN_CT" = 1 ]; then
    incus profile set default security.privileged=true && incus profile set default security.nesting=true \
      && ok "Running inside a container: nested LXC set to privileged + nesting (fixes idmap error)"
  else ok "Incus on a real server - profile left as is"; fi
  incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0 >>"$LOG" 2>&1
  incus network set incusbr0 ipv4.dhcp=true ipv4.nat=true >>"$LOG" 2>&1
  for r in "INPUT -i incusbr0" "FORWARD -i incusbr0" "FORWARD -o incusbr0"; do
    iptables -w -C $r -m comment --comment avm -j ACCEPT 2>/dev/null || iptables -w -I ${r%% *} 1 ${r#* } -m comment --comment avm -j ACCEPT 2>/dev/null
  done
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow in on incusbr0 >/dev/null; ufw route allow in on incusbr0 >/dev/null; ufw route allow out on incusbr0 >/dev/null
  fi
  ok "Bridge incusbr0 $(incus network get incusbr0 ipv4.address 2>/dev/null) - DHCP + firewall open"
else
  ok "Incus not installed - skipping (Docker only)"
fi

# ---------------------------------------------------------------- 4. docker + web hosting
step "[4/6] Docker + website hosting"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  if iptables -w -nL DOCKER-USER >/dev/null 2>&1; then
    for d in "-i" "-o"; do
      iptables -w -C DOCKER-USER $d incusbr0 -m comment --comment avm -j ACCEPT 2>/dev/null || iptables -w -I DOCKER-USER 1 $d incusbr0 -m comment --comment avm -j ACCEPT
    done
    ok "Docker firewall: Incus bridge allowed (DOCKER-USER)"
  fi
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    for r in 80/tcp 443/tcp 443/udp; do ufw allow "$r" comment 'AVM web hosting' >/dev/null; done
    ok "ufw: 80 + 443 open for websites"
  fi
  if command -v ss >/dev/null; then
    BUSY="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v caddy | head -n1)"
    [ -n "$BUSY" ] && warn "Something else uses port 80/443 - websites need them free: $BUSY"
  fi
  docker ps --format '{{.Names}}' | grep -q '^avm-caddy$' && ok "Web server (avm-caddy) running" || ok "Web server starts with the first website"
else
  warn "Docker not running - Docker machines and websites need it (install.sh can install it)"
fi
sysctl -qw net.ipv4.ip_forward=1; echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-avm.conf 2>/dev/null

# ---------------------------------------------------------------- 5. restart
step "[5/6] Restarting AVM"
wait_http() { for _ in $(seq 1 30); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
NODE_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$INSTALL_DIR/node/config.json" 2>/dev/null || echo 8090)"
pm2 restart avm-node >/dev/null 2>&1 || pm2 start "$INSTALL_DIR/node/src/daemon.js" --name avm-node --cwd "$INSTALL_DIR/node" >/dev/null
wait_http "http://127.0.0.1:${NODE_PORT}/health" && ok "Node daemon online :$NODE_PORT" || warn "Node did not start - pm2 logs avm-node"
if [ -f "$INSTALL_DIR/panel/config.json" ]; then
  PANEL_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$INSTALL_DIR/panel/config.json" 2>/dev/null || echo 8000)"
  pm2 restart avm-panel >/dev/null 2>&1 || pm2 start "$INSTALL_DIR/panel/src/server.js" --name avm-panel --cwd "$INSTALL_DIR/panel" >/dev/null
  wait_http "http://127.0.0.1:${PANEL_PORT}/health" && ok "Panel online :$PANEL_PORT" || warn "Panel did not start - pm2 logs avm-panel"
fi
pm2 save >/dev/null 2>&1

# ---------------------------------------------------------------- 6. summary
step "[6/6] Check"
TOKEN="$(node -e 'console.log(require(process.argv[1]).token)' "$INSTALL_DIR/node/config.json" 2>/dev/null)"
TYPES="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${NODE_PORT}/api/system" 2>/dev/null | grep -o '"types":\[[^]]*\]' | tr -d '"' | sed 's/types://')"
ok "This node can create: ${TYPES:-unknown} (container = LXC, vm = KVM)"
echo
echo "${C}${B}  ❄ Done.${N} If you use Cloudflare: Caching -> Purge Everything once, then Ctrl+Shift+R in the browser."
echo "  Log: $LOG"
