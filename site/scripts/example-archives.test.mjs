import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { readExampleManifest, buildExampleArchive } from "../src/lib/example-archives.mjs";

const directory = fileURLToPath(new URL("../../examples/", import.meta.url));
test("all article downloads contain their complete declared source and license, without build outputs", async () => {
  const manifest = await readExampleManifest(directory);
  assert.equal(manifest.length, 5);
  for (const example of manifest) {
    const bytes = await buildExampleArchive(directory, example, path.join(directory, "../LICENSE"));
    const zip = unzipSync(bytes);
    for (const name of example.files) {
      assert.deepEqual(Buffer.from(zip[`${example.slug}/${name}`]), await fs.readFile(path.join(directory, example.slug, name)));
    }
    assert.match(strFromU8(zip[`${example.slug}/LICENSE`]), /MIT License/);
    assert.match(strFromU8(zip[`${example.slug}/VERIFICATION.md`]), /Windows execution and real desktop capture were not performed/);
    assert(!Object.keys(zip).some((name) => /\/(?:bin|obj|node_modules|\.expo|dist)\//.test(name)));
    assert.deepEqual(bytes, await buildExampleArchive(directory, example, path.join(directory, "../LICENSE")), "archive should be deterministic");
  }
});
test("manifest and archive paths cannot include arbitrary files outside an example", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "example-archive-"));
  try {
    await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify([{ slug: "sample", files: ["../secret"] }]));
    await assert.rejects(readExampleManifest(temporary));
    await fs.mkdir(path.join(temporary, "sample"));
    await fs.writeFile(path.join(temporary, "outside"), "not an example");
    await fs.symlink(path.join(temporary, "outside"), path.join(temporary, "sample", "link"));
    await assert.rejects(buildExampleArchive(temporary, { slug: "sample", files: ["link"] }, path.join(directory, "../LICENSE")));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
