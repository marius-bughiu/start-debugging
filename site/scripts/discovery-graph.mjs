#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDiscoveryGraph } from "./lib/discovery-graph.mjs";

const args = process.argv.slice(2);
const supported = new Set(["dist", "output", "origin", "cohort", "provenance"]);
for (const arg of args) {
  if (["--help", "--include-edges"].includes(arg)) continue;
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !supported.has(match[1])) throw new Error("Unknown or empty argument: " + arg + "; use --help");
}
const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes("--help")) {
  console.log("Usage: node scripts/discovery-graph.mjs [--dist=dist] [--output=/path/report.json] [--origin=https://startdebugging.net] [--cohort=/path/cohort.json] [--provenance=/path/provenance.json] [--include-edges]\nOffline rendered anchor graph; no network calls or source edits. Reports same-locale homepage click depth and contextual versus module/list incoming links.");
  process.exit(0);
}
const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cohort = option("cohort") ? JSON.parse(await fs.readFile(path.resolve(option("cohort")), "utf8")) : null;
const cohortEntries = cohort ? (cohort.urls ?? cohort) : [];
if (!Array.isArray(cohortEntries) || cohortEntries.some((entry) => typeof (typeof entry === "string" ? entry : entry?.path) !== "string")) throw new Error("Cohort must be an array of paths or an object with a urls array containing path entries");
const priorityPaths = cohortEntries.map((entry) => typeof entry === "string" ? entry : entry.path);
const provenance = option("provenance") ? JSON.parse(await fs.readFile(path.resolve(option("provenance")), "utf8")) : null;
const result = await auditDiscoveryGraph({
  distDir: path.resolve(option("dist") ?? path.join(siteRoot, "dist")),
  ...(option("origin") ? { origin: option("origin") } : {}),
  priorityPaths, provenance, includeEdges: args.includes("--include-edges"),
});
const output = option("output");
if (output) {
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(result, null, 2) + "\n");
  const { byLocale, ...summary } = result.summary;
  console.log(JSON.stringify({ output: target, ...summary, byLocale: Object.fromEntries(Object.entries(byLocale).map(([locale, { allPageDepth, ...counts }]) => [locale, counts])) }, null, 2));
} else console.log(JSON.stringify(result, null, 2));
