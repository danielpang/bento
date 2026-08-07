/**
 * What a sandbox needs before an agent can run in it, and nothing more.
 *
 * The line is deliberate: Bento installs git and the agent CLIs, and no
 * language runtime for the project. A repository's toolchain belongs to
 * the repository, so it arrives through that repository's setup command,
 * where the people who work in it can name the version they need. An
 * image that shipped Node would make every Node project appear to work
 * on whatever version happened to be baked in, and every Go project
 * start by fighting it.
 *
 * Four of the five CLIs ship standalone binaries, so they carry no
 * runtime of their own. pi is published only on npm, so it gets a
 * private Node under /opt/bento that runs pi and nothing else: it is
 * never placed on the PATH an agent's shell sees, so `node` in a
 * workspace still means "the one this repository installed".
 */

/** Binaries this script is responsible for putting on the PATH. */
export const AGENT_BINARIES = ["claude", "codex", "cursor-agent", "opencode", "pi"] as const;

/**
 * Bumped whenever the script changes what it installs. It names the
 * marker file, so a sprite that survives a Bento deploy installs the
 * new set instead of reporting the old one as done.
 */
export const TOOLCHAIN_VERSION = 1;

/**
 * The marker file the script leaves behind. Exported so provisioning
 * can ask "is the install still ahead?" cheaply and say so before the
 * minutes-long wait rather than after.
 */
export const TOOLCHAIN_MARKER = `/opt/bento/toolchain-v${TOOLCHAIN_VERSION}`;

/** Node used only to run pi. Off the agent's PATH on purpose. */
const NODE_VERSION = "22.14.0";

/**
 * Idempotent, and safe to run on every provision: a sandbox that already
 * has this version of the toolchain exits immediately, which is the
 * common case once a card is past its first stage.
 *
 * Written as POSIX sh because it runs wherever the sandbox came from,
 * and installer failures are tolerated one CLI at a time: a run using
 * Claude Code should not be stopped by opencode's CDN being down. The
 * missing tool is reported when a run that needs it cannot start.
 */
export const AGENT_TOOLCHAIN_SCRIPT = `set -eu
MARKER=${TOOLCHAIN_MARKER}
[ -f "$MARKER" ] && exit 0
mkdir -p /opt/bento /usr/local/bin

# Base tools. git is the only one of these the project's own code sees.
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \\
      git curl ca-certificates >/dev/null
  fi
fi

# Installers drop binaries wherever they like; this puts them somewhere
# every PATH already includes, because an agent is spawned directly
# rather than through a login shell.
publish() {
  command -v "$1" >/dev/null 2>&1 && return 0
  for dir in "$HOME/.local/bin" /root/.local/bin "$HOME/.opencode/bin" /root/.opencode/bin \\
             "$HOME/.cursor/bin" /root/.cursor/bin /opt/bento/bin; do
    if [ -x "$dir/$1" ]; then ln -sf "$dir/$1" /usr/local/bin/"$1"; return 0; fi
  done
  return 1
}

curl -fsSL https://claude.ai/install.sh | bash || echo "bento: claude code install failed" >&2
curl -fsSL https://chatgpt.com/codex/install.sh | sh || echo "bento: codex install failed" >&2
curl -fsSL https://opencode.ai/install | bash || echo "bento: opencode install failed" >&2
curl -fsS https://cursor.com/install | bash || echo "bento: cursor install failed" >&2

# pi is npm only, so it gets its own Node. /opt/bento/node/bin is never
# added to PATH: the shim below puts it there for pi's process alone, so
# a repository that wants Node still has to install one.
if [ ! -x /opt/bento/node/bin/node ]; then
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) node_arch="" ;;
  esac
  if [ -n "$node_arch" ]; then
    tarball="node-v${NODE_VERSION}-linux-$node_arch.tar.xz"
    if curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$tarball" -o /tmp/node.tar.xz; then
      mkdir -p /opt/bento/node
      tar -xJf /tmp/node.tar.xz -C /opt/bento/node --strip-components=1
      rm -f /tmp/node.tar.xz
    fi
  fi
fi
if [ -x /opt/bento/node/bin/node ]; then
  PATH=/opt/bento/node/bin:$PATH /opt/bento/node/bin/npm install -g --prefix /opt/bento/pi \\
    @earendil-works/pi-coding-agent >/dev/null 2>&1 || echo "bento: pi install failed" >&2
  if [ -x /opt/bento/pi/bin/pi ]; then
    printf '#!/bin/sh\\nPATH=/opt/bento/node/bin:$PATH\\nexport PATH\\nexec /opt/bento/pi/bin/pi "$@"\\n' \\
      > /usr/local/bin/pi
    chmod +x /usr/local/bin/pi
  fi
fi

for tool in ${AGENT_BINARIES.join(" ")}; do
  publish "$tool" || echo "bento: $tool is not installed" >&2
done

git config --system user.email "agent@bento.dev" || true
git config --system user.name "Bento Agent" || true
git config --system --add safe.directory '*' || true

touch "$MARKER"
`;
