import fs from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

export async function readExampleManifest(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  const seen = new Set();
  for (const item of manifest) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug) || seen.has(item.slug)) throw new Error("Invalid example slug");
    seen.add(item.slug);
    if (!Array.isArray(item.files) || !item.files.length || new Set(item.files).size !== item.files.length)
      throw new Error("Example must contain an explicit, unique file list");
    for (const file of item.files) {
      if (typeof file !== "string" || file.split(/[\\/]/).some((part) => !part || part.startsWith(".")) || path.isAbsolute(file))
        throw new Error("Invalid example file path");
    }
  }
  return manifest;
}

export async function buildExampleArchive(directory, example, licenseFile) {
  const root = await fs.realpath(path.join(directory, example.slug));
  const entries = {};
  const add = (name, bytes) => {
    entries[`${example.slug}/${name}`] = [new Uint8Array(bytes), { mtime: new Date("2000-01-01T00:00:00Z") }];
  };
  for (const name of example.files) {
    const filename = await fs.realpath(path.join(root, name));
    if (!filename.startsWith(root + path.sep)) throw new Error("Example file escapes its source directory");
    add(name, await fs.readFile(filename));
  }
  add("LICENSE", await fs.readFile(licenseFile));
  add("VERIFICATION.md", await fs.readFile(path.join(directory, "VERIFICATION.md")));
  if (example.slug !== "react-native-two-columns") add("NuGet.Config", await fs.readFile(path.join(directory, "NuGet.Config")));
  return zipSync(entries, { level: 9 });
}
