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
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && curl -fsSL https://chatgpt.com/codex/install.sh | sh \
 && curl -fsSL https://opencode.ai/install | bash \
 && curl -fsS https://cursor.com/install | bash

# pi is published on npm only, so it gets a private Node that runs pi and
# nothing else. /opt/bento/node/bin stays off PATH: `node` inside a
# workspace has to mean the one that repository's setup command
# installed, not this one.
ENV BENTO_NODE_VERSION=22.14.0
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) node_arch=x64 ;; esac \
 && mkdir -p /opt/bento/node \
 && curl -fsSL "https://nodejs.org/dist/v${BENTO_NODE_VERSION}/node-v${BENTO_NODE_VERSION}-linux-${node_arch}.tar.xz" \
    -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /opt/bento/node --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && PATH=/opt/bento/node/bin:$PATH /opt/bento/node/bin/npm install -g --prefix /opt/bento/pi \
    @earendil-works/pi-coding-agent \
 && printf '#!/bin/sh\nPATH=/opt/bento/node/bin:$PATH\nexport PATH\nexec /opt/bento/pi/bin/pi "$@"\n' \
    > /usr/local/bin/pi \
 && chmod +x /usr/local/bin/pi

# Installers drop binaries in their own directories, and an agent is
# spawned directly rather than through a login shell, so every tool is
# linked somewhere the default PATH already covers.
RUN for tool in claude codex cursor-agent opencode; do \
      for dir in /root/.local/bin /root/.opencode/bin /root/.cursor/bin; do \
        [ -x "$dir/$tool" ] && ln -sf "$dir/$tool" /usr/local/bin/"$tool" && break; \
      done; \
    done; \
    for tool in claude codex cursor-agent opencode pi; do \
      command -v "$tool" >/dev/null 2>&1 || echo "warning: $tool is not on PATH"; \
    done

RUN git config --system user.email "agent@bento.dev" \
    && git config --system user.name "Bento Agent" \
    && git config --system --add safe.directory /workspace

WORKDIR /workspace
CMD ["sleep", "infinity"]
