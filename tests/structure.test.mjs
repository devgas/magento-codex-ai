import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function listSkillDirs(baseDir) {
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function markdownLinks(content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function fileUriLinks(content) {
  return [...content.matchAll(/file:\/\/([^\s"]+)/g)].map((match) => match[1]);
}

const skillDirs = listSkillDirs(path.join(repoRoot, "skills"));
const agentSkillDirs = listSkillDirs(path.join(repoRoot, "agent-skills"));
const repoFiles = walk(repoRoot);
const operationalFiles = repoFiles.filter((filePath) => {
  const rel = path.relative(repoRoot, filePath);
  return !rel.startsWith(".git/") &&
    rel !== "MAGENTO_AI_REFERENCE.md" &&
    rel !== "tests/structure.test.mjs";
});

test("expected skill counts are present", () => {
  assert.equal(skillDirs.length, 16);
  assert.equal(agentSkillDirs.length, 12);
});

test("every skill file has basic frontmatter", () => {
  for (const dir of [...skillDirs, ...agentSkillDirs]) {
    const baseDir = skillDirs.includes(dir) ? "skills" : "agent-skills";
    const skillPath = path.join(repoRoot, baseDir, dir, "SKILL.md");
    const content = read(skillPath);

    assert.match(content, /^---\n[\s\S]+?\n---\n/);
    assert.match(content, /\nname:\s*[^\n]+/);
    assert.match(content, /\ndescription:\s*[^\n]+/);
  }
});

test("markdown links resolve inside repo", () => {
  for (const filePath of operationalFiles.filter((file) => file.endsWith(".md"))) {
    const content = read(filePath);
    for (const link of markdownLinks(content)) {
      if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("#")) {
        continue;
      }

      const target = path.resolve(path.dirname(filePath), link);
      assert.ok(fs.existsSync(target), `${path.relative(repoRoot, filePath)} -> ${link} does not exist`);
    }
  }
});

test("promptfoo file URIs resolve", () => {
  const yamlFiles = repoFiles.filter((filePath) => filePath.endsWith(".yaml"));

  for (const filePath of yamlFiles) {
    const content = read(filePath);
    for (const link of fileUriLinks(content)) {
      const target = path.resolve(path.dirname(filePath), link);
      assert.ok(fs.existsSync(target), `${path.relative(repoRoot, filePath)} -> file://${link} does not exist`);
    }
  }
});

test("operational files are Codex-facing", () => {
  const bannedPatterns = [
    "~/.claude",
    "Claude Code",
    "anthropic:messages:claude",
    "model: sonnet",
    "subagents/"
  ];

  for (const filePath of operationalFiles) {
    const content = read(filePath);
    for (const pattern of bannedPatterns) {
      assert.ok(
        !content.includes(pattern),
        `${path.relative(repoRoot, filePath)} still contains banned pattern: ${pattern}`
      );
    }
  }
});

test("providers config is OpenAI-only", () => {
  const providers = read(path.join(repoRoot, "tests", "providers.yaml"));

  assert.match(providers, /openai:gpt-4o/);
  assert.ok(!providers.includes("anthropic:"));
});
