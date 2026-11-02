import { readFile } from "node:fs/promises";

// Astro 5.17.1 can persist an older content snapshot when saves overlap:
// https://github.com/withastro/astro/issues/15672
// Serialize the public data writer BEFORE it captures the current state.
// Asset/module import writers are deliberately outside this workaround.
// Remove this helper after upgrading to an Astro release with a verified fix.
const PATCHED = Symbol.for("start-debugging.astro-content-store.serialized");
const SUPPORTED_VERSION = "5.17.1";

function requireSupportedVersion(version) {
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Review or remove the Astro content-store workaround before using Astro ${version}; it was verified against ${SUPPORTED_VERSION}.`,
    );
  }
}

export function serializeContentStoreWrites(Store, version) {
  requireSupportedVersion(version);
  const prototype = Store.prototype;
  if (Object.hasOwn(prototype, PATCHED)) return;
  const write = prototype.writeToDisk;
  if (typeof write !== "function") {
    throw new Error("Astro MutableDataStore.writeToDisk is unavailable; review the content-store workaround.");
  }

  const pending = new WeakMap();
  prototype.writeToDisk = function (...args) {
    const previous = pending.get(this) ?? Promise.resolve();
    // A failed save must reach its caller without poisoning subsequent saves.
    const next = previous.catch(() => {}).then(() => write.apply(this, args));
    pending.set(this, next);
    const release = () => {
      if (pending.get(this) === next) pending.delete(this);
    };
    next.then(release, release);
    return next;
  };
  Object.defineProperty(prototype, PATCHED, { value: true });
}

export async function installAstroContentStoreWorkaround() {
  const packageUrl = new URL(import.meta.resolve("astro/package.json"));
  const { version } = JSON.parse(await readFile(packageUrl, "utf8"));
  requireSupportedVersion(version);
  const { MutableDataStore } = await import(
    new URL("./dist/content/mutable-data-store.js", packageUrl).href
  );
  serializeContentStoreWrites(MutableDataStore, version);
}
