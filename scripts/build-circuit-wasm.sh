#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
manifest_path="$project_dir/dsp/circuit/Cargo.toml"
artifact_path="$project_dir/dsp/circuit/target/wasm32-unknown-unknown/release/sonic_board_circuit.wasm"
public_path="$project_dir/public/audio/circuit.wasm"

rustup target add wasm32-unknown-unknown
cargo build --manifest-path "$manifest_path" --lib --target wasm32-unknown-unknown --release
cp "$artifact_path" "$public_path"
chmod 0644 "$public_path"

printf '%s\n' "$public_path"
