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
 * Five of the six CLIs ship standalone binaries, so they carry no
 * runtime of their own. pi is published only on npm, so it gets a
 * private Node under /opt/bento that runs pi and nothing else: it is
 * never placed on the PATH an agent's shell sees, so `node` in a
 * workspace still means "the one this repository installed".
 */

/** Binaries this script is responsible for putting on the PATH. */
export const AGENT_BINARIES = ["claude", "codex", "cursor-agent", "opencode", "pi", "pool"] as const;

/**
 * Bumped whenever the script changes what it installs, or when the
 * commands Bento builds start requiring newer CLIs than a warm
 * machine may hold. It names the marker file, so a sprite that
 * survives a Bento deploy installs the new set instead of reporting
 * the old one as done.
 *
 * v2: claude is invoked with --include-partial-messages, which a
 * binary installed under v1 may predate; the reinstall brings every
 * warm sprite to a CLI that has it.
 *
 * v3: the marker used to be written whether the CLIs landed or not, so
 * a sandbox that lost one installer to a bad minute never installed it
 * again. Machines carrying a v2 marker may be missing a CLI because of
 * it, and the bump makes them install the set once more.
 *
 * Bumping this is not free, and it is worth knowing why before you do.
 * Every warm sprite in the fleet reinstalls the whole set on its next
 * provision, so the next run of every card pays minutes it did not
 * expect, and five vendors' installers are all called at once from one
 * egress address. That is the condition that gets one of them
 * throttled, which means a bump is the change most likely to hit the
 * failure this version exists to fix: bumping to fix a rate limit feeds
 * it. Nothing wedges when it does, and agent-toolchain.test.ts holds
 * that guarantee, but a real sprite is the only thing that can say the
 * installers themselves still work, so
 * .github/workflows/sandbox-e2e.yml runs one whenever this file
 * changes. Wait for it before merging a bump.
 *
 * Which is also why fixing opencode did not need one. Since v3 the
 * retry decision comes from the binaries rather than the marker, so a
 * sandbox missing a CLI already reinstalls it on its next provision and
 * picks up whatever this script now does. Adding pool did not need one
 * either, and for the same reason: a warm sprite holding the v3 marker
 * finds pool absent from the PATH, installs that one CLI, and leaves
 * the five it already has alone.
 */
export const TOOLCHAIN_VERSION = 3;

/**
 * The marker file the script leaves behind. Exported so provisioning
 * can ask "is the install still ahead?" cheaply and say so before the
 * minutes-long wait rather than after.
 */
export const TOOLCHAIN_MARKER = `/opt/bento/toolchain-v${TOOLCHAIN_VERSION}`;

/**
 * How the script names the CLIs that are still not on the PATH when it
 * finishes. Printed on stdout so provisioning can put the failure in
 * the run's transcript, where the person who started the run reads it.
 */
export const TOOLCHAIN_MISSING_PREFIX = "bento-toolchain-missing:";

/** Node used only to run pi. Off the agent's PATH on purpose. */
const NODE_VERSION = "22.14.0";

/**
 * Idempotent, and safe to run on every provision: a sandbox that already
 * has every CLI exits immediately, which is the common case once a card
 * is past its first stage.
 *
 * Written as POSIX sh because it runs wherever the sandbox came from,
 * and installer failures are tolerated one CLI at a time: a run using
 * Claude Code should not be stopped by opencode's CDN being down. What
 * changed in v3 is what happens next. The marker used to mean "the
 * install ran", so a sandbox that lost one installer to a rate limit
 * skipped straight past it on every later provision and every run of
 * that agent died at spawn with the runtime's own words, "executable
 * file `opencode` not found in $PATH". Now the marker only ends the
 * script when every binary actually resolves, and a later provision
 * retries the ones that do not, so the sandbox heals itself the moment
 * the installer is reachable again.
 */
export const AGENT_TOOLCHAIN_SCRIPT = `set -eu
MARKER=${TOOLCHAIN_MARKER}
ALL='${AGENT_BINARIES.join(" ")}'
# Installers write under it, and \${HOME} unset would end the script here
# rather than at the missing tool, under set -u.
HOME=\${HOME:-/root}
export HOME
mkdir -p /opt/bento /usr/local/bin

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

# What a run can actually spawn decides the work, not the marker alone.
# With the marker there this is six builtin lookups and no network,
# which is what makes the common case free; without it the whole set is
# installed, because a version bump means the commands Bento builds now
# want newer CLIs than the ones already here.
needed=""
if [ -f "$MARKER" ]; then
  for tool in $ALL; do
    publish "$tool" || needed="$needed $tool"
  done
  if [ -z "$needed" ]; then exit 0; fi
else
  needed="$ALL"
fi

wanted() {
  case " $needed " in *" $1 "*) return 0 ;; esac
  return 1
}

# Base packages. git is the only one of these the project's own code
# sees; the rest are what the CLI installers unpack themselves with, and
# an installer that downloads its archive and cannot open it leaves
# nothing behind but an exit code. bash, because three of the five
# installers are bash scripts rather than sh ones.
packages=""
command -v git >/dev/null 2>&1 || packages="$packages git"
command -v curl >/dev/null 2>&1 || packages="$packages curl"
command -v tar >/dev/null 2>&1 || packages="$packages tar"
command -v unzip >/dev/null 2>&1 || packages="$packages unzip"
command -v xz >/dev/null 2>&1 || packages="$packages xz-utils"
command -v bash >/dev/null 2>&1 || packages="$packages bash"
if [ -n "$packages" ] && command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \\
    ca-certificates $packages >/dev/null
fi

# Downloaded first and then run, rather than piped into a shell: a
# pipeline reports the shell's exit status, so a fetch that answers 403
# or times out hands an empty script to a shell that exits 0, and the
# failure reads as a success all the way to the missing binary.
#
# Retried, because these are network installs and a lost packet is not
# a reason to leave a sandbox without a CLI. Three quick attempts is
# all this is: it covers a blip, and nothing longer. The failure that
# actually happens, opencode's GitHub API rate limit, lasts an hour and
# is handled by not depending on that API at all. See below.
install_from() {
  name=$1
  url=$2
  runner=$3
  script=/tmp/bento-install-$name
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if curl -fsSL "$url" -o "$script" && "$runner" "$script"; then
      rm -f "$script"
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -le 3 ]; then sleep 5; fi
  done
  rm -f "$script"
  echo "bento: $name install failed" >&2
  return 1
}

# opencode comes from its release rather than through its installer.
#
# That installer asks api.github.com which release is latest, purely to
# print a version, and then exits without installing when the call
# fails. It fails for an hour at a time, because an hour is the window
# an address gets sixty unauthenticated requests in, and a pool of
# sprites shares one address. Nothing about installing needs that call:
# /releases/latest/download serves the newest build without a version
# number and without the API, and the installer builds exactly that URL
# before it asks. Nor is the rest of what it does wanted here, since it
# ends by writing PATH lines into shell rc files, and publish() puts the
# binary somewhere every PATH already covers.
#
# What is worth keeping is the target detection, so it is kept: a
# machine without avx2 needs the baseline build and musl needs the musl
# one, and the wrong choice installs a binary that will not start.
install_opencode_release() {
  case "$(uname -m)" in
    x86_64|amd64) target=linux-x64 ;;
    aarch64|arm64) target=linux-arm64 ;;
    *) return 1 ;;
  esac
  if [ "$target" = linux-x64 ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    target="$target-baseline"
  fi
  is_musl=no
  if [ -f /etc/alpine-release ]; then is_musl=yes; fi
  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then is_musl=yes; fi
  fi
  if [ "$is_musl" = yes ]; then target="$target-musl"; fi

  unpack=/tmp/bento-opencode
  attempt=1
  while [ "$attempt" -le 3 ]; do
    rm -rf "$unpack"
    mkdir -p "$unpack"
    if curl -fsSL "https://github.com/anomalyco/opencode/releases/latest/download/opencode-$target.tar.gz" \\
         -o "$unpack/opencode.tar.gz" &&
       tar -xzf "$unpack/opencode.tar.gz" -C "$unpack" &&
       [ -f "$unpack/opencode" ]; then
      mkdir -p "$HOME/.opencode/bin"
      mv "$unpack/opencode" "$HOME/.opencode/bin/opencode"
      chmod 755 "$HOME/.opencode/bin/opencode"
      rm -rf "$unpack"
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -le 3 ]; then sleep 5; fi
  done
  rm -rf "$unpack"
  echo "bento: opencode release download failed" >&2
  return 1
}

if wanted claude; then install_from claude https://claude.ai/install.sh bash || true; fi
if wanted codex; then install_from codex https://chatgpt.com/codex/install.sh sh || true; fi
if wanted opencode; then
  install_opencode_release || true
  # The one thing the installer knows better than this script is where
  # the release lives, so it is kept for the day that moves: a renamed
  # asset or another change of GitHub organization 404s the download
  # above and lands here, where the vendor's own script can still be
  # right. On every ordinary day it is never fetched.
  if ! publish opencode; then
    install_from opencode https://opencode.ai/install bash || true
  fi
fi
if wanted cursor-agent; then install_from cursor https://cursor.com/install bash || true; fi

# pool's installer refuses to run without a terminal unless the EULA is
# accepted up front, so accepting it is what makes the install headless
# at all. Note what that means: Bento accepts Poolside's terms inside
# every sandbox it provisions, on the operator's behalf. Scoped to the
# one command, which is also where the installer's child shell reads it.
if wanted pool; then
  POOL_INSTALL_ACCEPT_EULA=1 install_from pool https://downloads.poolside.ai/pool/install.sh sh || true
fi

# pi is npm only, so it gets its own Node. /opt/bento/node/bin is never
# added to PATH: the shim below puts it there for pi's process alone, so
# a repository that wants Node still has to install one.
if wanted pi; then
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
  else
    echo "bento: pi install failed, no private Node" >&2
  fi
fi

# The install is worth exactly what a run can spawn afterwards, so the
# verdict comes from the PATH rather than from the installers' exit
# codes. On stdout as well as stderr, because provisioning reads this
# line and puts the missing CLI in the run's transcript, rather than
# leaving the run to fail later with a shell's "not found".
missing=""
for tool in $ALL; do
  publish "$tool" || missing="$missing$tool "
done
if [ -n "$missing" ]; then
  echo "${TOOLCHAIN_MISSING_PREFIX} $missing"
  for tool in $missing; do echo "bento: $tool is not installed" >&2; done
fi

git config --system user.email "agent@bento.dev" || true
git config --system user.name "Bento Agent" || true
git config --system --add safe.directory '*' || true

# Written even when a CLI is missing, and deliberately. The marker says
# "this version of the toolchain has run here"; the retry decision is
# made above from the binaries themselves, so the next provision installs
# whatever is still absent and nothing else. Holding the marker back
# instead would reinstall the whole set, minutes of it, on every stage of
# a card whose one unreachable CLI it never uses.
touch "$MARKER"
`;

/**
 * The CLIs the script could not put on the PATH, read back from its
 * output. An empty array means every one of them is there, which is
 * both the common case and the only case a run can rely on.
 */
export function toolchainMissing(output: string): string[] {
  const line = output.split("\n").find((candidate) => candidate.startsWith(TOOLCHAIN_MISSING_PREFIX));
  if (!line) return [];
  return line.slice(TOOLCHAIN_MISSING_PREFIX.length).trim().split(/\s+/).filter(Boolean);
}
