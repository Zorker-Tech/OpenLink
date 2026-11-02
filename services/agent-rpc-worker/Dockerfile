FROM node:22-bookworm AS node-runtime

FROM ubuntu:26.10

ENV DEBIAN_FRONTEND=noninteractive

# Node 24 crashes before startup in the Project VM's QEMU TCG. Use the Node 22
# runtime and its npm/corepack tooling on the Ubuntu desktop image.
COPY --from=node-runtime /usr/local/ /usr/local/

# OpenSandbox runs this Ubuntu userspace as the per-session agent and desktop
# workload. Keep the desktop stack in the workload image, not the Project VM.
# Use the Ubuntu mirror for faster package downloads; APT still verifies the
# archive with Ubuntu's signing key.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sed -i \
      -e 's|URIs: http://archive.ubuntu.com/ubuntu/|URIs: http://mirrors.aliyun.com/ubuntu/|' \
      -e 's|URIs: http://security.ubuntu.com/ubuntu/|URIs: http://mirrors.aliyun.com/ubuntu/|' \
      /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get -o Acquire::http::Proxy::mirrors.aliyun.com=DIRECT -o Acquire::Retries=5 -o Acquire::http::Timeout=600 -o Acquire::https::Timeout=600 update \
  && apt-get -o Acquire::http::Proxy::mirrors.aliyun.com=DIRECT -o Acquire::Retries=5 -o Acquire::http::Timeout=600 -o Acquire::https::Timeout=600 install -y --no-install-recommends \
    curl git python3 python3-pip build-essential ca-certificates \
    locales dbus-x11 fonts-dejavu-core fonts-noto-cjk fonts-noto-cjk-extra gnome-session gnome-shell gnome-terminal \
    nautilus ubuntu-session ubuntu-desktop-minimal novnc python3-websockify \
    qemu-system-x86 qemu-utils x11vnc x11-xserver-utils xterm xorriso xvfb \
  && corepack enable pnpm \
  && corepack prepare pnpm@10.12.4 --activate \
  && locale-gen en_US.UTF-8 \
  && groupmod --new-name openlink ubuntu \
  && usermod --login openlink --home /home/openlink --move-home --gid openlink ubuntu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
COPY packages/pi-runtime/tarballs ./packages/pi-runtime/tarballs
COPY services/agent-rpc-worker/package.json services/agent-rpc-worker/package-lock.json ./openlink/agent-rpc-worker/
WORKDIR /opt/openlink/agent-rpc-worker
RUN npm ci --omit=dev --ignore-scripts=false
COPY services/agent-rpc-worker/dist ./dist
COPY services/agent-browser-extension/openlink-browser.ts ./extensions/openlink-browser.ts
COPY services/agent-supabase-extension/openlink-supabase.ts ./extensions/openlink-supabase.ts
COPY services/agent-desktop-extension/openlink-desktop.ts ./extensions/openlink-desktop.ts
COPY services/agent-worker/desktop/start.sh /opt/openlink/desktop/start.sh
COPY services/agent-worker/desktop/run-ubuntu-vm.sh /opt/openlink/desktop/run-ubuntu-vm.sh
COPY services/agent-worker/desktop/qmp-control.py /opt/openlink/desktop/qmp-control.py

ENV NODE_ENV=production
EXPOSE 43131 6080
ENTRYPOINT ["node", "dist/main.js"]
