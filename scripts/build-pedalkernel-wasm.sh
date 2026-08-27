#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
manifest_path="$project_dir/dsp/pedalkernel-wasm/Cargo.toml"
artifact_path="$project_dir/dsp/pedalkernel-wasm/target/wasm32-unknown-unknown/release/sonic_board_pedalkernel_wasm.wasm"
public_path="$project_dir/public/audio/pedalkernel.wasm"

rustup target add wasm32-unknown-unknown
cargo build --manifest-path "$manifest_path" --target wasm32-unknown-unknown --release
cp "$artifact_path" "$public_path"
chmod 0644 "$public_path"

printf '%s\n' "$public_path"
