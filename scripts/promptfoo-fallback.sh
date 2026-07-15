#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <skills|agents|deep> <config> [config ...]" >&2
  exit 2
fi

profile="$1"
shift

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp -R "$repo_root/tests" "$tmp_dir/"

case "$profile" in
  skills)
    attempts=(
      "gpt-5.4 low"
      "gpt-5.5 medium"
      "gpt-5.6 high"
    )
    ;;
  agents)
    attempts=(
      "gpt-5.5 medium"
      "gpt-5.6 high"
    )
    ;;
  deep)
    attempts=(
      "gpt-5.6 high"
    )
    ;;
  *)
    echo "Unknown profile: $profile" >&2
    exit 2
    ;;
esac

rewrite_configs() {
  local provider_ref="$1"
  for rel_config in "$@"; do
    [ "$rel_config" = "$provider_ref" ] && continue
    local temp_config="$tmp_dir/$rel_config"
    sed -i -E 's#file://\.\./providers[^"]*\.yaml#file://../providers.override.yaml#g' "$temp_config"
  done
}

run_eval() {
  local model="$1"
  local effort="$2"
  local override="$tmp_dir/tests/providers.override.yaml"

  cat > "$override" <<EOF
- id: openai:${model}
  config:
    temperature: 0
    max_tokens: 8192
    reasoning:
      effort: ${effort}
    text:
      verbosity: medium
EOF

  rewrite_configs "$override" "$@"

  local cmd=(npx promptfoo@latest eval)
  shift 2
  for rel_config in "$@"; do
    cmd+=(--config "$tmp_dir/$rel_config")
  done
  cmd+=(--max-concurrency 1)

  echo "Trying model=${model} effort=${effort}" >&2
  "${cmd[@]}"
}

for attempt in "${attempts[@]}"; do
  model="${attempt%% *}"
  effort="${attempt##* }"
  if run_eval "$model" "$effort" "$@"; then
    exit 0
  fi
  echo "Attempt failed for model=${model} effort=${effort}, escalating..." >&2
done

exit 1
