# Magento Codex AI Toolkit

Codex-first prompt library for Magento 2 and Mage-OS.

## Quick Reference

- `npm test` runs deterministic repo validation
- `npm run test:promptfoo` runs optional OpenAI prompt evaluations
- `./scripts/install-codex.sh` installs the toolkit into `${CODEX_HOME:-$HOME/.codex}/skills/`

## Repo Rules

- Keep skills in `skills/<skill-name>/SKILL.md`
- Keep workflow prompts in `agent-skills/<agent-name>/SKILL.md`
- When adding or removing skills, update `README.md`, `package.json`, and `tests/structure.test.mjs`
- Do not add Claude-only paths or Anthropic-only provider defaults to operational docs or tests
- Keep promptfoo model profiles aligned with workload:
  `tests/providers.skills.yaml` for stateless skills,
  `tests/providers.agents.yaml` for standard agents,
  `tests/providers.deep-agents.yaml` for deep review and diagnostic agents
- Use `scripts/promptfoo-fallback.sh` when a promptfoo run should escalate from a cheaper model to a stronger one after failure
- Preserve upstream Magento content unless there is a concrete correctness or Codex-compatibility issue
