#!/usr/bin/env bash
# Builds GNU LibreDWG from its pinned release tarball, for CI checks only.
# LibreDWG is GPL-3.0+. It is never shipped with cad-axi; it reads what the
# engine writes and writes DWG files the engine must read (design §12).
# Usage: scripts/oracles/build-libredwg.sh <prefix>
set -euo pipefail
prefix=${1:?usage: build-libredwg.sh <prefix>}
version=0.14
sha256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/libredwg.tar.xz" "https://ftp.gnu.org/gnu/libredwg/libredwg-$version.tar.xz"
echo "$sha256  $work/libredwg.tar.xz" | sha256sum -c -
tar -xJf "$work/libredwg.tar.xz" -C "$work"
cd "$work/libredwg-$version"
./configure --prefix="$prefix" --disable-bindings --disable-docs --enable-release --disable-shared >/dev/null
make -j"$(nproc)" >/dev/null
make install >/dev/null
"$prefix/bin/dwgread" --version | head -1
