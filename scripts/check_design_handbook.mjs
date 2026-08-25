#!/usr/bin/env node
/**
 * Validate the reviewable proven-methods handbook (#682).
 *
 * This is deliberately structural: it checks source completeness, local-link
 * integrity, status vocabulary, and diagram fences. It does not decide whether
 * a technical claim is true; production claims still require the normal
 * issue/PR/close-proof review.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CHAPTERS = [
  "docs/design/proven-methods/DETERMINISTIC_CONTEXT_ASSEMBLY.md",
  "docs/design/proven-methods/LOG_EVIDENCE_PIPELINE.md",
  "docs/design/proven-methods/INVESTIGATION_LOOP.md",
  "docs/design/proven-methods/DEMO_EVALUATION_LAB.md",
  "docs/design/proven-methods/INCIDENT_EVIDENCE_BUNDLE.md",
  "docs/design/proven-methods/HELP_TRUTH_AND_DELIVERY.md",
  "docs/design/proven-methods/IDENTITY_AND_ADMINISTRATION.md",
];
const TEMPLATE = "docs/design/proven-methods/METHOD_TEMPLATE.md";
const INDEX = "docs/design/PROVEN_METHODS.md";
const STATUS_TERMS = [
  "Shipped",
  "Partial",
  "Local integration",
  "Accepted design",
  "Planned",
];
const TEMPORARY_PROMOTION_WORDING = [
  /\buntil (?:issue )?#?\d+ is merged\b/i,
  /\b(?:remains |is )?local until\b/i,
  /\buntil this handbook is merged\b/i,
  /\bcurrent acceptance branch\b/i,
  /\bon (?:this|the) (?:current )?(?:acceptance|integration) branch\b/i,
  /\bcurrent-main\/package availability until merged\b/i,
];

export function assertReleaseStableHandbookWording(relativePath, text) {
  for (const pattern of TEMPORARY_PROMOTION_WORDING) {
    if (pattern.test(text)) {
      throw new Error(
        `${relativePath}: contains temporary promotion wording that becomes stale after merge`,
      );
    }
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertFile(repositoryRoot, relativePath) {
  const absolute = path.resolve(repositoryRoot, relativePath);
  if (!isInside(repositoryRoot, absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`missing handbook file: ${relativePath}`);
  }
  return { absolute, text: fs.readFileSync(absolute, "utf8") };
}

function validateMarkdownFile(repositoryRoot, relativePath, text) {
  const h1Count = (text.match(/^# [^\n]+$/gm) ?? []).length;
  if (h1Count !== 1) {
    throw new Error(
      `${relativePath}: expected exactly one H1, found ${h1Count}`,
    );
  }
  if (/\/Users\/|[A-Za-z]:\\Users\\/.test(text)) {
    throw new Error(`${relativePath}: contains a private absolute user path`);
  }
  assertReleaseStableHandbookWording(relativePath, text);

  const fences = text.match(/^```mermaid\s*$|^```\s*$/gm) ?? [];
  let open = false;
  let diagrams = 0;
  for (const fence of fences) {
    if (fence === "```mermaid") {
      if (open) throw new Error(`${relativePath}: nested Mermaid fence`);
      open = true;
      diagrams += 1;
    } else if (open) {
      open = false;
    }
  }
  if (open) throw new Error(`${relativePath}: unclosed Mermaid fence`);

  const diagramBlocks = [
    ...text.matchAll(/^```mermaid\s*\n([\s\S]*?)^```\s*$/gm),
  ];
  for (const [index, match] of diagramBlocks.entries()) {
    const source = match[1];
    if (!/^%%\s*title\s*:\s*\S.+$/im.test(source)) {
      throw new Error(
        `${relativePath}: Mermaid diagram ${index + 1} is missing a specific '%% title:'`,
      );
    }
    if (
      /^\s*(?:alt|else|opt|loop|par|and|critical|option|break|rect|subgraph|end)\b/im.test(
        source,
      ) ||
      /-\.\s*["'][^"']+["']\s*\.-?>/m.test(source)
    ) {
      throw new Error(
        `${relativePath}: Mermaid diagram ${index + 1} uses syntax the bundled renderer cannot represent faithfully`,
      );
    }
  }

  for (const match of text.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (
      target === "" ||
      /^(?:https?:|help:|mailto:)/.test(target) ||
      target.startsWith("/")
    ) {
      continue;
    }
    const resolved = path.resolve(
      repositoryRoot,
      path.dirname(relativePath),
      target,
    );
    if (!isInside(repositoryRoot, resolved)) {
      throw new Error(`${relativePath}: link escapes repository: ${target}`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`${relativePath}: broken relative link: ${target}`);
    }
  }
  return diagrams;
}

export function validateDesignHandbook(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`repository root is not a directory: ${root}`);
  }

  const index = assertFile(root, INDEX);
  validateMarkdownFile(root, INDEX, index.text);
  for (const term of STATUS_TERMS) {
    if (!index.text.includes(`**${term}**`)) {
      throw new Error(`${INDEX}: missing status definition '${term}'`);
    }
  }
  if (!index.text.includes("## Handbook maintenance contract")) {
    throw new Error(`${INDEX}: missing handbook maintenance contract`);
  }

  const requiredFiles = [...CHAPTERS, TEMPLATE];
  for (const relativePath of requiredFiles) {
    const expectedLink = path.posix.relative(
      path.posix.dirname(INDEX),
      relativePath,
    );
    if (!index.text.includes(`(${expectedLink})`)) {
      throw new Error(`${INDEX}: does not link ${relativePath}`);
    }
  }

  let diagramCount = 0;
  for (const relativePath of CHAPTERS) {
    const chapter = assertFile(root, relativePath);
    diagramCount += validateMarkdownFile(root, relativePath, chapter.text);
    for (let section = 1; section <= 16; section += 1) {
      if (!chapter.text.includes(`## ${section}.`)) {
        throw new Error(`${relativePath}: missing numbered section ${section}`);
      }
    }
    if (!chapter.text.includes("Shipped / partial / planned matrix")) {
      throw new Error(`${relativePath}: missing explicit status matrix`);
    }
  }
  if (diagramCount < CHAPTERS.length) {
    throw new Error("every method chapter must include a Mermaid diagram");
  }

  const template = assertFile(root, TEMPLATE);
  validateMarkdownFile(root, TEMPLATE, template.text);
  for (let section = 1; section <= 16; section += 1) {
    if (!template.text.includes(`## ${section}.`)) {
      throw new Error(`${TEMPLATE}: missing numbered section ${section}`);
    }
  }
  if (!template.text.includes("## Author checklist")) {
    throw new Error(`${TEMPLATE}: missing author checklist`);
  }

  return {
    files: 1 + requiredFiles.length,
    chapters: CHAPTERS.length,
    diagrams: diagramCount,
  };
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(scriptPath), "..");
  const result = validateDesignHandbook(repositoryRoot);
  process.stdout.write(
    `check_design_handbook: OK (${result.files} files, ${result.chapters} chapters, ${result.diagrams} diagrams)\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`check_design_handbook: FAILED — ${error.message}\n`);
    process.exitCode = 1;
  }
}
