#!/usr/bin/env bash
# Links the arena-presence skill into Claude Code and Codex, so agents in any project can put
# themselves on the Arena dashboard. Re-run safely; remove with: scripts/install-skill.sh --uninstall
#
# Claude Code reads ~/.claude/skills (on some machines a link to ~/.agents/skills); Codex reads
# ~/.codex/skills. Each gets a symlink to this checkout, so `git pull` updates the skill too.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../skills/arena-presence" && pwd)"
TARGETS=("$HOME/.claude/skills" "$HOME/.codex/skills")

for dir in "${TARGETS[@]}"; do
  dest="$dir/arena-presence"
  if [[ "${1:-}" == "--uninstall" ]]; then
    if [[ -L "$dest" ]]; then rm "$dest" && echo "removed $dest"; fi
    continue
  fi
  mkdir -p "$dir"
  if [[ -L "$dest" && "$(readlink "$dest")" == "$SKILL_DIR" ]]; then
    echo "already linked: $dest"
  elif [[ -e "$dest" || -L "$dest" ]]; then
    echo "skipped $dest: something else is already there" >&2
  else
    ln -s "$SKILL_DIR" "$dest" && echo "linked $dest -> $SKILL_DIR"
  fi
done
