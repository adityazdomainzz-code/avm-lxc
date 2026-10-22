# AVM Panel in Docker (experimental): Incus + node daemon + panel in one PRIVILEGED container.
# Docker machines are created on the HOST's Docker through the mounted /var/run/docker.sock.
# Build from the repo root:   docker build -f docker/Dockerfile -t avm .
# Run: see docker/docker-compose.yml (needs --privileged and host networking).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

# a dummy systemctl so package scripts don't fail inside the image build
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg iptables iproute2 procps kmod util-linux \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc \
 && printf 'Enabled: yes\nTypes: deb\nURIs: https://pkgs.zabbly.com/incus/stable\nSuites: bookworm\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/zabbly.asc\n' "$(dpkg --print-architecture)" \
      > /etc/apt/sources.list.d/zabbly-incus-stable.sources \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get update \
 && apt-get install -y --no-install-recommends incus nodejs docker.io \
 && rm -rf /var/lib/apt/lists/* /usr/local/bin/systemctl

WORKDIR /app
COPY node/package.json node/
RUN cd node && npm install --omit=dev --no-audit --no-fund
COPY panel/package.json panel/
RUN cd panel && npm install --omit=dev --no-audit --no-fund
COPY node/src node/src
COPY panel/src panel/src
COPY panel/public panel/public
COPY docker/entrypoint.sh /entrypoint.sh

VOLUME ["/data", "/var/lib/incus"]
CMD ["bash", "/entrypoint.sh"]
