# Bento sandbox base image. Agents run inside containers built from this
# image with permission checks disabled: the container is the security
# boundary. Keep this image free of host secrets; credentials arrive as
# env vars on each exec, never baked in.
#
# What this image carries is deliberate: git, a few search tools, and the
# agent CLIs. No language runtime for the project. Which toolchain a
# repository needs belongs to the repository, and arrives through its
# setup command, so a Go service and a Node service can share this image
# and each install what it actually wants. An image that shipped Node
# would quietly decide the version for every Node project in it.
#
# The Sprite driver installs the same set with the same rules from
# packages/sandbox/src/agent-toolchain.ts; a test keeps the two lists in
# step.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq ripgrep unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs, from the installers that ship standalone binaries, so none
# of them brings a runtime the project would then trip over.
#
# Downloaded first and then run, rather than piped into a shell: a
# pipeline reports the shell's exit status, so a fetch that answers 403
# hands an empty script to a shell that exits 0, and a build that
# installed nothing looks like a build that worked.
#
# opencode comes from its release rather than through its installer.
# That installer asks api.github.com which release is latest, only to
# print a version, and exits without installing when the call fails,
# which it does for an hour at a time once an address has spent the
# sixty unauthenticated requests it gets. /releases/latest/download
# serves the newest build without the API and without a version number.
# The installer is kept only for the day upstream moves the release.
#
# pool's installer refuses to run without a terminal unless the EULA is
# accepted up front, which is Bento accepting Poolside's terms on the
# operator's behalf, here and in every sandbox the Sprite script builds.
# Same order and same reasons as packages/sandbox/src/agent-toolchain.ts.
RUN set -eu; \
    fetch_run() { \
      for attempt in 1 2 3; do \
        if curl -fsSL "$2" -o /tmp/installer && "$3" /tmp/installer; then rm -f /tmp/installer; return 0; fi; \
        sleep 5; \
      done; \
      echo "error: $1 install failed"; \
      return 1; \
    }; \
    fetch_run claude https://claude.ai/install.sh bash; \
    fetch_run codex https://chatgpt.com/codex/install.sh sh; \
    fetch_run cursor https://cursor.com/install bash; \
    fetch_run agy https://antigravity.google/cli/install.sh bash; \
    POOL_INSTALL_ACCEPT_EULA=1 fetch_run pool https://downloads.poolside.ai/pool/install.sh sh; \
    case "$(dpkg --print-architecture)" in arm64) target=linux-arm64 ;; *) target=linux-x64 ;; esac; \
    if [ "$target" = linux-x64 ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then target=linux-x64-baseline; fi; \
    mkdir -p /tmp/oc "$HOME/.opencode/bin"; \
    if curl -fsSL "https://github.com/anomalyco/opencode/releases/latest/download/opencode-$target.tar.gz" \
         -o /tmp/oc/oc.tar.gz && tar -xzf /tmp/oc/oc.tar.gz -C /tmp/oc && [ -f /tmp/oc/opencode ]; then \
      mv /tmp/oc/opencode "$HOME/.opencode/bin/opencode"; \
      chmod 755 "$HOME/.opencode/bin/opencode"; \
    else \
      fetch_run opencode https://opencode.ai/install bash; \
    fi; \
    rm -rf /tmp/oc

# pi and dsh are published on npm only, so they get a private Node that runs
# them and nothing else. /opt/bento/node/bin stays off PATH: `node` inside a
# workspace has to mean the one that repository's setup command
# installed, not this one.
ENV BENTO_NODE_VERSION=22.22.2
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) node_arch=x64 ;; esac \
 && mkdir -p /opt/bento/node \
 && curl -fsSL "https://nodejs.org/dist/v${BENTO_NODE_VERSION}/node-v${BENTO_NODE_VERSION}-linux-${node_arch}.tar.xz" \
    -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /opt/bento/node --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && PATH=/opt/bento/node/bin:$PATH /opt/bento/node/bin/npm install -g --prefix /opt/bento/pi \
    @earendil-works/pi-coding-agent \
 && PATH=/opt/bento/node/bin:$PATH /opt/bento/node/bin/npm install -g --prefix /opt/bento/dsh \
    @deepseek-ai/dsh@0.1.1-rc.2 \
 && printf '#!/bin/sh\nPATH=/opt/bento/node/bin:$PATH\nexport PATH\nexec /opt/bento/pi/bin/pi "$@"\n' \
    > /usr/local/bin/pi \
 && printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'PATH=/opt/bento/node/bin:$PATH' \
    'export PATH' \
    'if [ -z "${DSH_HOME:-}" ]; then' \
    '  mkdir -p /opt/bento/dsh-runs' \
    '  DSH_HOME=$(mktemp -d /opt/bento/dsh-runs/XXXXXX)' \
    '  cp -a /opt/bento/dsh-home/. "$DSH_HOME"/' \
    'fi' \
    'export DSH_HOME' \
    'exec /opt/bento/dsh/bin/dsh "$@"' \
    > /usr/local/bin/dsh \
 && chmod +x /usr/local/bin/pi /usr/local/bin/dsh \
 && mkdir -p /opt/bento/dsh-home \
 && printf '%s\n' \
    '- id: agent-default-model' \
    '  config:' \
    '    provider: deepseek-official' \
    '    model: !!js process.env.DSH_MODEL' \
    '- id: tool-web' \
    '  disabled: true' \
    > /opt/bento/dsh-home/cordis.patch.yml \
 && DSH_HOME=/opt/bento/dsh-home DSH_MODEL=deepseek-v4-pro DSH_PERMISSION_MODE=danger-full-access DSH_TELEMETRY_DISABLED=1 \
    /usr/local/bin/dsh --profile headless --dump-config >/dev/null

# Installers drop binaries in their own directories, and an agent is
# spawned directly rather than through a login shell, so every tool is
# linked somewhere the default PATH already covers.
#
# The check at the end fails the build rather than warning. An image
# that ships without one of these produces no symptom until a card runs
# that agent half an hour later, and then only "executable file
# `opencode` not found in $PATH".
RUN for tool in agy claude codex cursor-agent opencode pool; do \
      for dir in /root/.local/bin /root/.opencode/bin /root/.cursor/bin; do \
        [ -x "$dir/$tool" ] && ln -sf "$dir/$tool" /usr/local/bin/"$tool" && break; \
      done; \
    done; \
    status=0; \
    for tool in agy claude codex cursor-agent dsh opencode pi pool; do \
      command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is not on PATH"; status=1; }; \
    done; \
    exit $status

# Antigravity signs in with a Google account, and a sandbox has no
# browser to sign in with. modelProvider "gemini" is what makes
# GEMINI_API_KEY the credential instead, and the CLI refuses to start
# with one set and not the other. Same file, same reason, as
# packages/sandbox/src/agent-toolchain.ts writes on a bare machine.
RUN mkdir -p /root/.gemini/antigravity-cli \
 && printf '%s\n' '{ "modelProvider": "gemini" }' \
    > /root/.gemini/antigravity-cli/settings.json

RUN git config --system user.email "no-reply@usebento.ai" \
    && git config --system user.name "Bento Agent" \
    && git config --system --add safe.directory /workspace

WORKDIR /workspace
CMD ["sleep", "infinity"]
