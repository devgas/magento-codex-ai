# Magento Codex AI Toolkit

Codex-first Magento 2 and Mage-OS prompt toolkit, adapted from `furan917/magento-ai-toolkit` for local Codex workflows.

This repo keeps the upstream skill corpus, removes Claude-only packaging, fixes broken internal links, and adds deterministic local tests so the toolkit can be validated without API keys.

## Quick Start

```bash
npm test
./scripts/install-codex.sh
```

The installer copies both `skills/` and `agent-skills/` into `${CODEX_HOME:-$HOME/.codex}/skills/`.

## How To Use In Codex

### Install as Codex skills

```bash
./scripts/install-codex.sh
```

After installation, the skill folders are available from your Codex skills directory:

- `skills/` for focused reference prompts
- `agent-skills/` for multi-step agent workflows

### Use without installing

Open any `SKILL.md` file and paste it as a system prompt, or point your own tooling at the file directly.

### Optional prompt evaluation

The repo still ships promptfoo configs, but they are OpenAI-only and split by workload profile:

```bash
npm run test:promptfoo
```

Set `OPENAI_API_KEY` before running promptfoo-based tests.

Current model mapping:

- `skills/*`: `gpt-5.6-terra` with `reasoning.effort: low`
- most `agent-skills/*`: `gpt-5.6-terra` with `reasoning.effort: medium`
- deep review agents (`code-review`, `performance-auditor`, `search`, `sql`, `cron`): `gpt-5.6` with `reasoning.effort: high`

## Structure

```text
magento-codex-ai/
├── AGENTS.md
├── README.md
├── skills/
├── agent-skills/
├── snippets/
├── checklists/
├── tests/
├── scripts/
└── MAGENTO_AI_REFERENCE.md
```

- `skills/`: single-topic Magento reference skills
- `agent-skills/`: workflow-oriented prompts for larger tasks
- `snippets/`: copy-pasteable XML and PHP stubs
- `checklists/`: human-run delivery and review checklists
- `tests/`: local structure validation plus optional promptfoo configs
- `MAGENTO_AI_REFERENCE.md`: upstream Magento reference corpus retained as source material

## What Changed From The Reference Repo

- Removed Claude-native subagent packaging from the delivered repo shape
- Switched installation docs to `~/.codex/skills`
- Fixed broken companion-skill links in `agent-skills/`
- Replaced Anthropic promptfoo provider defaults with GPT-5.6-based OpenAI profiles
- Split providers by workload so skills, standard agents, and deep-review agents do not all use the same reasoning budget
- Added a local `node:test` suite that validates file counts, frontmatter, links, and Codex-facing docs

## Attribution

This repo is derived from `https://github.com/furan917/magento-ai-toolkit`. The upstream `LICENSE` and `MAGENTO_AI_REFERENCE.md` are preserved here.
