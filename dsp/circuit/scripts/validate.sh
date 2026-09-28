#!/usr/bin/env bash
# Validation matrix for every circuit model: DC operating point and transient
# agreement with ngspice, aliasing, and realtime factor. Needs ngspice on PATH.
# Usage: scripts/validate.sh [model ...]   (default: all models/*.cir)
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release -q
tool=./target/release/circuit-tool
models=("$@")
if [ ${#models[@]} -eq 0 ]; then
  models=(models/*.cir)
fi
signals=(220:0.05 440:0.3 110:0.5,165:0.4)
for model in "${models[@]}"; do
  controls=$(grep -c '^\*@control' "$model")
  # Knob sets: all mid, then each knob at 0 and 1 with the rest mid.
  sets=("$(printf '0.5%.0s,' $(seq "$controls") | sed 's/,$//')")
  for k in $(seq 0 $((controls - 1))); do
    for v in 0.0 1.0; do
      s=""
      for j in $(seq 0 $((controls - 1))); do
        s+=$([ "$j" = "$k" ] && echo "$v" || echo 0.5),
      done
      sets+=("${s%,}")
    done
  done
  echo "== $model"
  $tool op "$model" | tail -1
  worst=0
  fails=0
  for set in "${sets[@]}"; do
    for sig in "${signals[@]}"; do
      line=$($tool compare "$model" --controls "$set" --signal "$sig" --dur 0.1 --skip 0.05 | tail -1)
      nrmse=$(echo "$line" | sed -E 's/.*NRMSE ([0-9.e+-]+)%.*/\1/')
      f=$(echo "$line" | sed -E 's/.* ([0-9]+) failures.*/\1/')
      worst=$(awk -v a="$worst" -v b="$nrmse" 'BEGIN { print (b > a) ? b : a }')
      fails=$((fails + f))
    done
  done
  echo "  worst NRMSE vs ngspice: ${worst}% over ${#sets[@]} knob sets x ${#signals[@]} signals, Newton failures: $fails"
  for os in 2 4; do
    $tool alias "$model" --os "$os" --controls "${sets[0]}" | sed 's/^/  /'
    $tool bench "$model" --os "$os" | sed 's/^/  /'
  done
done
