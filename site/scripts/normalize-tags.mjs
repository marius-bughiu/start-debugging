#!/usr/bin/env node
/**
 * normalize-tags.mjs
 *
 * One-off migration that rewrites blog post frontmatter so every tag is a
 * lowercase kebab-case slug. Fixes the `/tag/C#/` 404 (the raw `#` is parsed
 * as a URL fragment by browsers) and deduplicates the taxonomy (e.g. `.NET 11`
 * and `dotnet-11` were separate tag pages for the same topic).
 *
 * Usage:
 *   node scripts/normalize-tags.mjs              # dry run — prints the plan
 *   node scripts/normalize-tags.mjs --apply      # actually rewrite files
 *
 * The script walks site/src/content/blog/** recursively (all locales), finds
 * the frontmatter `tags:` block in each .md, applies the MAP below, and
 * dedupes in-order. Files with no changes are left untouched.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");

const APPLY = process.argv.includes("--apply");

// Display-name tag -> slug. Slug-form tags not listed here are left alone.
const MAP = new Map([
  [".NET", "dotnet"],
  [".NET 10", "dotnet-10"],
  [".NET 11", "dotnet-11"],
  [".NET MAUI", "dotnet-maui"],
  ["ASP.NET Core", "aspnet-core"],
  ["Blazor", "blazor"],
  ["C#", "csharp"],
  ["C# 14", "csharp-14"],
  ["Compression", "compression"],
  ["CSV", "csv"],
  ["Dapper", "dapper"],
  ["Dart", "dart"],
  ["Database", "database"],
  ["dependency injection", "dependency-injection"],
  ["dotnet CLI", "dotnet-cli"],
  ["EF Core", "ef-core"],
  ["EF Core 11", "ef-core-11"],
  ["Fluorite", "fluorite"],
  ["Flutter", "flutter"],
  ["Game Development", "game-development"],
  ["HTTP/3", "http-3"],
  ["Interop", "interop"],
  ["JetBrains", "jetbrains"],
  ["JSON", "json"],
  ["Kestrel", "kestrel"],
  ["LINQ", "linq"],
  ["Mobile", "mobile"],
  ["MSBuild", "msbuild"],
  ["Native AOT", "native-aot"],
  ["NativeAOT", "native-aot"],
  ["Node.js", "nodejs"],
  ["Observability", "observability"],
  ["Open Source", "open-source"],
  ["OpenTelemetry", "opentelemetry"],
  ["Performance", "performance"],
  ["ReSharper", "resharper"],
  ["Rider", "rider"],
  ["SDK", "sdk"],
  ["Serialization", "serialization"],
  ["SQL Server", "sql-server"],
  ["Streaming", "streaming"],
  ["System.Text.Json", "system-text-json"],
  ["Tooling", "tooling"],
  ["VS Code", "vs-code"],
  ["Web Workers", "web-workers"],
  ["WebAssembly", "webassembly"],
  ["XAML", "xaml"],
]);

async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && full.endsWith(".md")) out.push(full);
  }
  return out;
}

function normalizeFile(src) {
  const lineSep = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") return { content: src, changed: false, changes: [] };

  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd === -1) return { content: src, changed: false, changes: [] };

  let tagsStart = -1;
  for (let i = 1; i < fmEnd; i++) {
    if (lines[i] === "tags:") {
      tagsStart = i;
      break;
    }
  }
  if (tagsStart === -1) return { content: src, changed: false, changes: [] };

  // tag block = subsequent lines that are list items (start with indent+dash)
  // or blank. Stops at the first non-indented key or `---`.
  let tagsEnd = fmEnd;
  for (let i = tagsStart + 1; i < fmEnd; i++) {
    if (!/^\s+-\s/.test(lines[i]) && lines[i].trim() !== "") {
      tagsEnd = i;
      break;
    }
  }

  const seen = new Set();
  const newTagLines = [];
  const changes = [];

  for (let i = tagsStart + 1; i < tagsEnd; i++) {
    const line = lines[i];
    // Matches `  - "value"` or `  - value` (unquoted). Captures indent+dash
    // prefix, quoted value, or unquoted value.
    const m = line.match(/^(\s+- )(?:"([^"]*)"|(\S.*?))\s*$/);
    if (!m) {
      newTagLines.push(line);
      continue;
    }
    const prefix = m[1];
    const quoted = m[2] !== undefined;
    const value = m[2] ?? m[3];
    const normalized = MAP.get(value) ?? value;

    if (seen.has(normalized)) {
      changes.push({ kind: "dedupe", value, normalized });
      continue;
    }
    seen.add(normalized);

    if (normalized !== value) {
      changes.push({ kind: "rename", from: value, to: normalized });
      newTagLines.push(quoted ? `${prefix}"${normalized}"` : `${prefix}${normalized}`);
    } else {
      newTagLines.push(line);
    }
  }

  if (changes.length === 0) return { content: src, changed: false, changes };

  const newLines = [
    ...lines.slice(0, tagsStart + 1),
    ...newTagLines,
    ...lines.slice(tagsEnd),
  ];
  return { content: newLines.join(lineSep), changed: true, changes };
}

async function main() {
  const files = await walk(CONTENT_ROOT);
  console.log(`Scanning ${files.length} markdown files under ${path.relative(SITE_ROOT, CONTENT_ROOT)}`);

  const renameCounts = new Map(); // "from -> to" -> n
  const dedupeCounts = new Map(); // "value (->normalized)" -> n
  let filesChanged = 0;
  const changedFiles = [];

  for (const file of files) {
    const src = await fs.readFile(file, "utf8");
    const { content, changed, changes } = normalizeFile(src);
    if (!changed) continue;

    filesChanged++;
    changedFiles.push(path.relative(SITE_ROOT, file));

    for (const c of changes) {
      if (c.kind === "rename") {
        const key = `${c.from} -> ${c.to}`;
        renameCounts.set(key, (renameCounts.get(key) ?? 0) + 1);
      } else {
        const key = c.value === c.normalized ? c.value : `${c.value} (-> ${c.normalized})`;
        dedupeCounts.set(key, (dedupeCounts.get(key) ?? 0) + 1);
      }
    }

    if (APPLY) {
      await fs.writeFile(file, content, "utf8");
    }
  }

  console.log("");
  console.log(`Files changed: ${filesChanged} ${APPLY ? "(written)" : "(dry run — pass --apply to write)"}`);

  if (renameCounts.size > 0) {
    console.log("");
    console.log("Renames:");
    const sorted = [...renameCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of sorted) console.log(`  ${n.toString().padStart(4)}  ${k}`);
  }

  if (dedupeCounts.size > 0) {
    console.log("");
    console.log("Deduped (tag already present under target slug):");
    const sorted = [...dedupeCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of sorted) console.log(`  ${n.toString().padStart(4)}  ${k}`);
  }

  if (!APPLY && filesChanged > 0) {
    console.log("");
    console.log("Sample of files that would change:");
    for (const f of changedFiles.slice(0, 10)) console.log(`  ${f}`);
    if (changedFiles.length > 10) console.log(`  ... and ${changedFiles.length - 10} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
