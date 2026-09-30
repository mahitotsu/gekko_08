#!/usr/bin/env bash
# Lambda の配布物を build/hop に作る（JWT の署名検証に PyJWT と cryptography を同梱する）
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf build/hop
mkdir -p build/hop
cp lambda/hop/index.py build/hop/
uv pip install -q --target build/hop --python-platform x86_64-manylinux_2_17 --python-version 3.13 "pyjwt[crypto]"
