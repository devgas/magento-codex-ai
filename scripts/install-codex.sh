#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
skills_dir="$codex_home/skills"

mkdir -p "$skills_dir"
cp -R "$repo_root/skills/." "$skills_dir/"
cp -R "$repo_root/agent-skills/." "$skills_dir/"

printf 'Installed skills into %s\n' "$skills_dir"
