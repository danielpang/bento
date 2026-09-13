#!/bin/sh
set -eu

# Resolve the installed bin symlink before looking for the packaged entry point.
bento_script=$0
while [ -L "$bento_script" ]; do
  bento_directory=$(CDPATH='' cd -P -- "$(dirname -- "$bento_script")" && pwd)
  bento_script=$(readlink "$bento_script")
  case "$bento_script" in
    /*) ;;
    *) bento_script=$bento_directory/$bento_script ;;
  esac
done
bento_directory=$(CDPATH='' cd -P -- "$(dirname -- "$bento_script")" && pwd)
exec node "$bento_directory/dist/cli.js" "$@"
