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
 * Eight of the ten CLIs ship standalone binaries, so they carry no
 * runtime of their own. pi and dsh are published only on npm, so they get a
 * private Node under /opt/bento that runs them and nothing else: it is
 * never placed on the PATH an agent's shell sees, so `node` in a
 * workspace still means "the one this repository installed".
 */

import type { AgentCli } from "@bento/core";

/** Binaries this script is responsible for putting on the PATH. */
export const AGENT_BINARIES = ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"] as const;

export type AgentBinary = (typeof AGENT_BINARIES)[number];

/**
 * Which binary a profile's CLI spawns. This is what lets a sandbox
 * install the two agents a card's pipeline actually uses instead of all
 * ten, so the first stage of a new card waits for two installers rather
 * than for ten plus a Node runtime.
 *
 * `fake` maps to nothing: it is the in-process test agent, and a
 * sandbox never spawns a binary for it.
 */
export const AGENT_CLI_BINARIES: Record<AgentCli, AgentBinary | null> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode",
  pi: "pi",
  pool: "pool",
  dsh: "dsh",
  antigravity: "agy",
  muse: "muse",
  fx: "fx",
  fake: null,
};

/**
 * The binaries a set of CLIs needs, deduplicated and in AGENT_BINARIES
 * order so the same pipeline always renders the same script. A CLI with
 * no binary contributes nothing.
 */
export function toolchainBinaries(clis: Iterable<AgentCli>): AgentBinary[] {
  const wanted = new Set<AgentBinary>();
  for (const cli of clis) {
    const binary = AGENT_CLI_BINARIES[cli];
    if (binary) wanted.add(binary);
  }
  return AGENT_BINARIES.filter((binary) => wanted.has(binary));
}

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
 * expect, and six vendors' installers are all called at once from one
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
 * the five it already has alone. Adding dsh is the same for a machine
 * that never had it, and so is adding agy. Warm sprites that already
 * have pi or opencode too old for native DeepSeek, or a dsh pin that
 * has moved, are caught by the version check below rather than a bump.
 * Adding muse is the same for a machine that never had it.
 * Adding fx is the same for a machine that never had it.
 * fx's custom connections require the dev-channel binary. A separate
 * marker upgrades only fx on warm machines that already have the v3 set.
 *
 * Installing only a card's own agents did not need one either, and the
 * reasoning is the same one more time. A warm sprite's whole-set marker
 * is still read, and counts for every CLI it covers, so such a machine
 * reinstalls nothing; any CLI it is later asked for that it does not
 * have is absent from the PATH and installed then. Bumping for it would have done the
 * one thing this change exists to avoid: send every warm sprite in the
 * fleet to ten installers at once.
 *
 * It does change what a bump costs, and for the better. A bump used to
 * mean every warm sprite reinstalling all ten CLIs on its next
 * provision, which is the fan-out most likely to get a vendor to
 * throttle us. Now each card reinstalls the two or three agents it
 * actually runs, spread over whenever those cards next run. Wait for
 * .github/workflows/sandbox-e2e.yml before merging a bump all the same:
 * a real sprite is still the only thing that can say the installers
 * themselves work.
 */
export const TOOLCHAIN_VERSION = 3;

/**
 * Where the script records what it has installed: one empty file per
 * CLI, in a directory named for the toolchain version. Exported so
 * provisioning can ask "are this card's agents still ahead of us?"
 * cheaply and say so before the minutes-long wait rather than after.
 *
 * Per CLI rather than one marker for the whole set, because a provision
 * now installs only the agents a card's pipeline uses. One marker
 * cannot answer "was claude installed at this version?" on a machine
 * where only codex has ever run, and answering that wrong is how a
 * version bump would silently skip the very CLI it was bumped for.
 */
export const TOOLCHAIN_STAMPS = `/opt/bento/toolchain/v${TOOLCHAIN_VERSION}`;

/**
 * What TOOLCHAIN_STAMPS replaced: a single file meaning "every CLI was
 * attempted at this version". Warm sprites across the fleet still carry
 * one, and it is good evidence, so the script reads it as a stamp for
 * any CLI rather than reinstalling ten working binaries to learn what
 * the machine already knows. Versioned exactly like the stamps, so a
 * bump cannot inherit the previous version's word for it.
 *
 * Read, never written and never removed. A machine that has it keeps
 * it, so a deploy of this change can be rolled back without sending the
 * whole fleet through ten installers at once.
 */
export const TOOLCHAIN_LEGACY_MARKER = `/opt/bento/toolchain-v${TOOLCHAIN_VERSION}`;
const FX_CUSTOM_MARKER = "/opt/bento/fx-custom-connections";

/**
 * How the script names the CLIs that are still not on the PATH when it
 * finishes. Printed on stdout so provisioning can put the failure in
 * the run's transcript, where the person who started the run reads it.
 */
export const TOOLCHAIN_MISSING_PREFIX = "bento-toolchain-missing:";

/** Node used only to run npm-distributed agents. Off the agent's PATH on purpose. */
const NODE_VERSION = "22.22.2";
/** Native DeepSeek on opencode needs this floor; warm sprites below it reinstall. */
const OPENCODE_MIN_VERSION = "1.14.24";
/** Native DeepSeek on pi needs this floor; warm sprites below it reinstall. */
const PI_MIN_VERSION = "0.70.1";
/**
 * Pin bumps reinstall via the version check below, not a TOOLCHAIN_VERSION
 * bump: warm sprites that already have dsh compare --version to this string.
 */
const DSH_VERSION = "0.1.1-rc.2";
/**
 * dsh 0.1.1-rc.2 depends on @deepseek-ai/cordis-plugin-hmr with a caret.
 * 1.0.18 removed registerConfig, which a headless run calls to watch
 * the user patch layer. 1.0.17 is the last release that still provides
 * it. Installed beside dsh so npm dedupes to this version.
 *
 * That pin is not enough on its own. Cordis hides a service from
 * ctx.get until the plugin fiber is active, and the HMR plugin's
 * startup waits on a realpath. dsh creates the plugin and then
 * immediately asks for the service, so the lookup misses and the run
 * dies with "user patch-layer watching requires the Cordis HMR
 * service" even when 1.0.17 is the copy on disk. The install patches
 * that lookup to wait out the startup. The pin file records both, so
 * a machine that only has the plugin version installs again.
 */
const DSH_HMR_VERSION = "1.0.17";
const DSH_HMR_PIN_VALUE = `${DSH_HMR_VERSION}+wait`;
const DSH_HMR_PIN = "/opt/bento/dsh-hmr-pin";

/**
 * The provisioning script, rendered for the CLIs this sandbox is asked
 * to be able to spawn. Defaults to all of them, which is what the
 * Docker image installs and what a caller naming nothing gets.
 *
 * Idempotent, and safe to run on every provision: a sandbox that
 * already has the asked-for CLIs exits immediately, which is the common
 * case once a card is past its first stage.
 *
 * Written as POSIX sh because it runs wherever the sandbox came from,
 * and installer failures are tolerated one CLI at a time: a run using
 * Claude Code should not be stopped by opencode's CDN being down. What
 * changed in v3 is what happens next. The marker used to mean "the
 * install ran", so a sandbox that lost one installer to a rate limit
 * skipped straight past it on every later provision and every run of
 * that agent died at spawn with the runtime's own words, "executable
 * file `opencode` not found in $PATH". Now a stamp goes on one CLI at a
 * time and only for a CLI that resolves, and a later provision retries
 * the ones that do not, so the sandbox heals itself the moment the
 * installer is reachable again.
 *
 * What changed after that is the scope. A card whose pipeline runs
 * Claude Code and Codex used to wait on ten installers plus a private
 * Node it would never call, every one of them on the critical path of
 * its first stage. Asking for two installs two. An agent added to the
 * pipeline after the card was created is not a special case: it is
 * absent from the PATH and unstamped, so the provision that first needs
 * it installs it and the run proceeds.
 */
export function agentToolchainScript(binaries: readonly string[] = AGENT_BINARIES): string {
  return `set -eu
STAMPS=${TOOLCHAIN_STAMPS}
LEGACY_MARKER=${TOOLCHAIN_LEGACY_MARKER}
FX_CUSTOM_MARKER=${FX_CUSTOM_MARKER}
ALL='${binaries.join(" ")}'
# Installers write under it, and \${HOME} unset would end the script here
# rather than at the missing tool, under set -u.
HOME=\${HOME:-/root}
export HOME
mkdir -p /opt/bento /usr/local/bin "$STAMPS"

# Installers drop binaries wherever they like; this puts them somewhere
# every PATH already includes, because an agent is spawned directly
# rather than through a login shell.
publish() {
  command -v "$1" >/dev/null 2>&1 && return 0
  for dir in "$HOME/.local/bin" /root/.local/bin "$HOME/.opencode/bin" /root/.opencode/bin \\
             "$HOME/.cursor/bin" /root/.cursor/bin "$HOME/.antigravity/bin" /root/.antigravity/bin \\
             /opt/bento/bin; do
    if [ -x "$dir/$1" ]; then ln -sf "$dir/$1" /usr/local/bin/"$1"; return 0; fi
  done
  return 1
}

# 0 if $1 is a lower major.minor.patch than $2. Digits are taken from the
# first dotted triple so "opencode 1.14.24" still compares.
version_below() {
  current=$(printf '%s' "$1" | tr -cd '0-9.') || true
  floor=$(printf '%s' "$2" | tr -cd '0-9.') || true
  c1=\${current%%.*}
  rest=\${current#"$c1"}
  rest=\${rest#.}
  c2=\${rest%%.*}
  rest=\${rest#"$c2"}
  rest=\${rest#.}
  c3=\${rest%%.*}
  f1=\${floor%%.*}
  rest=\${floor#"$f1"}
  rest=\${rest#.}
  f2=\${rest%%.*}
  rest=\${rest#"$f2"}
  rest=\${rest#.}
  f3=\${rest%%.*}
  c1=\${c1%%[!0-9]*}
  c2=\${c2%%[!0-9]*}
  c3=\${c3%%[!0-9]*}
  f1=\${f1%%[!0-9]*}
  f2=\${f2%%[!0-9]*}
  f3=\${f3%%[!0-9]*}
  [ -n "$c1" ] || c1=0
  [ -n "$c2" ] || c2=0
  [ -n "$c3" ] || c3=0
  [ -n "$f1" ] || f1=0
  [ -n "$f2" ] || f2=0
  [ -n "$f3" ] || f3=0
  if [ "$c1" -lt "$f1" ]; then return 0; fi
  if [ "$c1" -gt "$f1" ]; then return 1; fi
  if [ "$c2" -lt "$f2" ]; then return 0; fi
  if [ "$c2" -gt "$f2" ]; then return 1; fi
  if [ "$c3" -lt "$f3" ]; then return 0; fi
  return 1
}

# Present but too old for what Bento now builds. dsh is a string contains
# against the pin, not semver, because the pin is 0.1.1-rc.2.
# The inner dsh binary is asked directly so a version check does not copy
# a per-run home.
cli_stale() {
  tool=$1
  case "$tool" in
    opencode)
      ver=$(opencode --version 2>/dev/null | head -n 1) || true
      [ -n "$ver" ] || return 0
      version_below "$ver" "${OPENCODE_MIN_VERSION}"
      ;;
    pi)
      ver=$(pi --version 2>/dev/null | head -n 1) || true
      [ -n "$ver" ] || return 0
      version_below "$ver" "${PI_MIN_VERSION}"
      ;;
    dsh)
      ver=$(/opt/bento/dsh/bin/dsh --version 2>/dev/null || true)
      [ -n "$ver" ] || ver=$(/opt/bento/dsh/bin/dsh -V 2>/dev/null || true)
      case "$ver" in
        *${DSH_VERSION}*) ;;
        *) return 0 ;;
      esac
      # The binary's version does not name the HMR plugin beside it.
      # A machine installed before the pin has the right dsh and a
      # headless run that dies, so the pin file is what sends it back
      # through npm. Missing or different counts as stale.
      [ "$(cat ${DSH_HMR_PIN} 2>/dev/null || true)" = "${DSH_HMR_PIN_VALUE}" ] && return 1
      return 0
      ;;
    fx)
      [ ! -f "$FX_CUSTOM_MARKER" ]
      ;;
    *) return 1 ;;
  esac
}

# What this card can actually spawn decides the work. For a card whose
# agents are all here this is a couple of builtin lookups each and no
# network, which is what makes every stage after the first free. A CLI
# needs installing when nothing says this version installed it (a fresh
# machine, or a version bump, which means the commands Bento builds now
# want newer CLIs than the ones already here), when its binary has gone
# missing, or when it is below a floor this script now requires.
#
# Two things can say it. Its own stamp, or the single marker that warm
# machines from before stamps carry, which means the whole set was
# attempted at this version and is exactly as good a word for one CLI.
#
# That marker is read rather than converted and deleted, and it is left
# where it is. Deleting it would be tidier, and it would also mean that
# rolling back to the version before stamps, or one older machine in a
# rolling deploy, found no marker and reinstalled all ten CLIs on every
# warm sprite at once: the fleet-wide installer fan-out this whole change
# exists to avoid. It costs one stat per CLI and stops being read the
# moment TOOLCHAIN_VERSION moves, since both paths are versioned.
needed=""
for tool in $ALL; do
  if publish "$tool" && { [ -f "$STAMPS/$tool" ] || [ -f "$LEGACY_MARKER" ]; }; then
    if cli_stale "$tool"; then needed="$needed $tool"; fi
  else
    needed="$needed $tool"
  fi
done

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

# Before the early exit, because these belong to the sandbox rather than
# to any one agent: the repository clone that provisioning does next
# needs git whether or not a single CLI was missing, and a card whose
# agents are all installed still commits as somebody.
git config --system user.email "no-reply@usebento.ai" || true
git config --system user.name "Bento Agent" || true
# --replace-all rather than --add: this runs on every provision now, and
# --add would append another identical line to /etc/gitconfig each time.
git config --system --replace-all safe.directory '*' || true

# Every asked-for CLI is stamped and on the PATH, which is every stage
# of a card after its first.
if [ -z "$needed" ]; then exit 0; fi

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

# Antigravity signs in with a Google account, and a sandbox has no
# browser to sign in with. modelProvider "gemini" is what makes
# GEMINI_API_KEY the credential instead, and the CLI refuses to start
# with one set and not the other, which is why the file is written here
# rather than left to a run. Only when there is none: a local user who
# shares their own ~/.gemini has it mounted over this, and their
# settings, and their login, are the ones that should decide.
if wanted agy; then
  install_from agy https://antigravity.google/cli/install.sh bash || true
  if [ ! -f "$HOME/.gemini/antigravity-cli/settings.json" ]; then
    if mkdir -p "$HOME/.gemini/antigravity-cli" 2>/dev/null; then
      printf '%s\n' '{ "modelProvider": "gemini" }' \
        > "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null || true
    fi
  fi
fi

# pool's installer refuses to run without a terminal unless the EULA is
# accepted up front, so accepting it is what makes the install headless
# at all. Note what that means: Bento accepts Poolside's terms inside
# every sandbox it provisions, on the operator's behalf. Scoped to the
# one command, which is also where the installer's child shell reads it.
if wanted pool; then
  POOL_INSTALL_ACCEPT_EULA=1 install_from pool https://downloads.poolside.ai/pool/install.sh sh || true
fi

# Muse Code's installer rewrites shell rc files unless told not to.
# The sandbox has no login shell that would read them, and rewriting
# them is a surprise on a machine that already has a PATH.
if wanted muse; then
  MUSE_NO_MODIFY_PATH=1 install_from muse https://dev.meta.ai/install.sh bash || true
fi

# fx's installer writes PATH lines into shell rc files when ~/.local/bin
# is not already on PATH. The sandbox has no login shell that would
# read them, and publish() already looks there. Putting the install
# dir on PATH first is what keeps the rc files alone.
if wanted fx; then
  mkdir -p "$HOME/.local/bin"
  (PATH="$HOME/.local/bin:$PATH" FX_INSTALL_DIR="$HOME/.local/bin" \\
    install_from fx https://fx.sh/setup.sh bash) || true
  if [ -x "$HOME/.local/bin/fx" ] &&
     FX_INSTALL_DIR="$HOME/.local/bin" "$HOME/.local/bin/fx" upgrade --channel dev --json >/dev/null; then
    touch "$FX_CUSTOM_MARKER"
  else
    echo "bento: fx custom connections build is unavailable" >&2
  fi
fi

# pi and dsh are npm only, so they share a private Node. A compatibility
# check upgrades warm machines below dsh's floor without replacing a newer
# supported runtime. The old runtime stays usable if the download fails.
node_supported() {
  [ -x /opt/bento/node/bin/node ] || return 1
  version=$(/opt/bento/node/bin/node --version 2>/dev/null) || return 1
  version=\${version#v}
  major=\${version%%.*}
  rest=\${version#*.}
  minor=\${rest%%.*}
  case "$major:$minor" in *[!0-9:]*|:|*:) return 1 ;; esac
  if [ "$major" -eq 22 ]; then [ "$minor" -ge 19 ]; else [ "$major" -ge 24 ]; fi
}

ensure_node() {
  node_supported && return 0
  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) return 1 ;;
  esac
  tarball="node-v${NODE_VERSION}-linux-$node_arch.tar.xz"
  rm -rf /opt/bento/node-next
  if curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$tarball" -o /tmp/node.tar.xz; then
    mkdir -p /opt/bento/node-next
    if tar -xJf /tmp/node.tar.xz -C /opt/bento/node-next --strip-components=1; then
      rm -rf /opt/bento/node
      mv /opt/bento/node-next /opt/bento/node
    fi
  fi
  rm -rf /opt/bento/node-next
  rm -f /tmp/node.tar.xz
  node_supported
}

# /opt/bento/node/bin is never added to the workspace PATH. Each shim adds it
# only to its agent process, so a repository that wants Node still installs one.
if wanted dsh; then
  if ensure_node; then
    PATH=/opt/bento/node/bin:$PATH /opt/bento/node/bin/npm install -g --prefix /opt/bento/dsh \\
      @deepseek-ai/dsh@${DSH_VERSION} @deepseek-ai/cordis-plugin-hmr@${DSH_HMR_VERSION} >/dev/null 2>&1 \\
      || echo "bento: dsh install failed" >&2
    if [ -x /opt/bento/dsh/bin/dsh ]; then
      # Cordis answers ctx.get only once the plugin fiber is active.
      # dsh asks on the same turn it creates the plugin, and the HMR
      # startup still has a realpath in flight, so the service looks
      # missing. Wait for it. A second install sees the marker and
      # leaves the file alone.
      boot=$(find /opt/bento/dsh -path '*/@deepseek-ai/dsh-app-boot/lib/index.js' -type f 2>/dev/null | head -n 1)
      if [ -n "$boot" ]; then
        if ! BENTO_DSH_BOOT="$boot" /opt/bento/node/bin/node <<'BENTO_DSH_HMR_WAIT'
const fs = require("fs");
const file = process.env.BENTO_DSH_BOOT;
const text = fs.readFileSync(file, "utf8");
if (text.includes("bento-wait-for-hmr")) process.exit(0);
const bin = "$" + "{binName}";
const tick = String.fromCharCode(96);
const message = tick + bin + ": user patch-layer watching requires the Cordis HMR service" + tick;
const needle = "\\tconst hmr = ctx.get(\\"hmr\\");\\n\\tif (hmr === void 0) throw new Error(" + message + ");";
const patch = [
  "\\t// bento-wait-for-hmr: ctx.get hides the service until its fiber is active.",
  "\\tlet hmr = ctx.get(\\"hmr\\");",
  "\\tfor (let attempt = 0; hmr === void 0 && attempt < 50; attempt++) {",
  "\\t\\tawait new Promise((resolve) => setTimeout(resolve, 20));",
  "\\t\\thmr = ctx.get(\\"hmr\\");",
  "\\t}",
  "\\tif (hmr === void 0) throw new Error(" + message + ");",
].join("\\n");
if (!text.includes(needle)) {
  console.error("bento: dsh boot file has no HMR check to patch");
  process.exit(1);
}
fs.writeFileSync(file, text.replace(needle, patch));
BENTO_DSH_HMR_WAIT
        then
          echo "bento: dsh HMR wait patch failed" >&2
          rm -f /opt/bento/dsh/bin/dsh
        fi
      fi
    fi
    if [ -x /opt/bento/dsh/bin/dsh ]; then
      printf '%s\\n' "${DSH_HMR_PIN_VALUE}" > ${DSH_HMR_PIN}
      mkdir -p /opt/bento/dsh-home
      cat > /opt/bento/dsh-home/cordis.patch.yml <<'BENTO_DSH_PROFILE'
- id: agent-default-model
  config:
    provider: deepseek-official
    model: !!js process.env.DSH_MODEL
- id: tool-web
  disabled: true
BENTO_DSH_PROFILE
      cat > /usr/local/bin/dsh <<'BENTO_DSH_SHIM'
#!/bin/sh
set -eu
PATH=/opt/bento/node/bin:$PATH
export PATH
if [ -z "\${DSH_HOME:-}" ]; then
  mkdir -p /opt/bento/dsh-runs
  DSH_HOME=$(mktemp -d /opt/bento/dsh-runs/XXXXXX)
  cp -a /opt/bento/dsh-home/. "$DSH_HOME"/
fi
export DSH_HOME
exec /opt/bento/dsh/bin/dsh "$@"
BENTO_DSH_SHIM
      chmod +x /usr/local/bin/dsh
      if ! DSH_HOME=/opt/bento/dsh-home DSH_MODEL=deepseek-v4-pro DSH_PERMISSION_MODE=danger-full-access DSH_TELEMETRY_DISABLED=1 \\
        /usr/local/bin/dsh --profile headless --dump-config >/dev/null 2>&1; then
        rm -f /usr/local/bin/dsh
        echo "bento: dsh profile initialization failed" >&2
      fi
    fi
  else
    echo "bento: dsh install failed, no private Node" >&2
  fi
fi

if wanted pi; then
  if ensure_node; then
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
#
# The stamp goes on here, one CLI at a time and only for a CLI that
# resolves, so an installer that had a bad minute leaves no stamp and is
# the only thing retried next time. The whole-set marker this replaced
# had to be written even on failure, precisely to avoid reinstalling
# nine working CLIs for one unreachable vendor; stamping per CLI is what
# makes that trade unnecessary.
missing=""
for tool in $ALL; do
  if publish "$tool"; then
    touch "$STAMPS/$tool"
  else
    missing="$missing$tool "
  fi
done
if [ -n "$missing" ]; then
  echo "${TOOLCHAIN_MISSING_PREFIX} $missing"
  for tool in $missing; do echo "bento: $tool is not installed" >&2; done
fi
`;
}

/**
 * The script with every CLI asked for. What the Docker image mirrors,
 * and what a driver that names no agents installs.
 */
export const AGENT_TOOLCHAIN_SCRIPT = agentToolchainScript();

/**
 * Asks a sandbox whether the CLIs this card needs are already stamped,
 * so provisioning can name a minutes-long install before it happens
 * rather than after it. Cheap on purpose: one stat per CLI, no network,
 * and no installer.
 *
 * Reads the same two things the script does, a stamp or the pre-stamp
 * marker, so a warm machine is not told it is about to wait minutes for
 * an install that will take a second.
 *
 * Only as good as those, which say a CLI resolved when it was installed
 * rather than that it resolves now. The script itself checks
 * the PATH and reinstalls what has gone missing, so the cost of being
 * wrong here is a progress line that was too optimistic, never a run
 * that starts without its agent.
 */
export function toolchainPresenceProbe(binaries: readonly string[] = AGENT_BINARIES): string {
  if (binaries.length === 0) return "echo tools-present";
  return [
    `for tool in ${binaries.join(" ")}; do`,
    `  if [ ! -f ${TOOLCHAIN_STAMPS}/"$tool" ] && [ ! -f ${TOOLCHAIN_LEGACY_MARKER} ]; then`,
    "    echo tools-absent",
    "    exit 0",
    "  fi",
    "done",
    "echo tools-present",
  ].join("\n");
}

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
