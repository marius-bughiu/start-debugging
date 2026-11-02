import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { parse } from "devalue";
import { serializeContentStoreWrites } from "../src/lib/astro-content-store.mjs";

const astroPackageUrl = new URL(import.meta.resolve("astro/package.json"));
const { version } = JSON.parse(await fs.readFile(astroPackageUrl, "utf8"));
const { MutableDataStore } = await import(
  new URL("./dist/content/mutable-data-store.js", astroPackageUrl).href
);

// Run the real installed writer with an in-memory filesystem. The first read
// pauses an atomic save so mutations and additional saves overlap deterministically.
async function fixture(run) {
  const originals = Object.fromEntries(
    ["readFile", "writeFile", "rename", "mkdir"].map((key) => [key, fs[key]]),
  );
  const files = new Map();
  const file = new URL(`file:///__astro_content_store_test__/${crypto.randomUUID()}.json`);
  const stores = [];
  let release;
  let started;
  let firstRead = true;
  let failNextWrite = false;
  const blocked = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  try {
    fs.mkdir = async () => {};
    fs.readFile = async (path) => {
      if (firstRead) {
        firstRead = false;
        started();
        await blocked;
      }
      if (!files.has(String(path))) throw new Error("ENOENT");
      return files.get(String(path));
    };
    fs.writeFile = async (path, data) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("simulated write failure");
      }
      files.set(String(path), data);
    };
    fs.rename = async (from, to) => {
      files.set(String(to), files.get(String(from)));
      files.delete(String(from));
    };
    const makeStore = async (patched = true) => {
      const url = stores.length ? new URL(`${stores.length}.json`, file) : file;
      const store = await MutableDataStore.fromFile(url);
      // Keep each test's prototype isolated while retaining the real private slots.
      if (patched) {
        class TestStore extends MutableDataStore {}
        serializeContentStoreWrites(TestStore, version);
        Object.setPrototypeOf(store, TestStore.prototype);
      }
      stores.push(store);
      return { store, url };
    };
    await run({
      makeStore, ready, release,
      failNextWrite: () => { failNextWrite = true; },
      persisted: (url = file) => parse(files.get(String(url))),
    });
  } finally {
    release();
    await Promise.all(stores.map((store) => store.waitUntilSaveComplete()));
    for (const [key, original] of Object.entries(originals)) fs[key] = original;
  }
}

test("unwrapped Astro writer reproduces stale persisted state", async () => {
  await fixture(async ({ makeStore, ready, release, persisted }) => {
    const { store } = await makeStore(false);
    store.set("blog", "article", { revision: "old" });
    const first = store.writeToDisk();
    await ready;
    store.set("blog", "article", { revision: "corrected" });
    await store.writeToDisk();
    release();
    await first;
    await store.waitUntilSaveComplete();
    assert.equal(store.get("blog", "article").revision, "corrected");
    assert.equal(persisted().get("blog").get("article").revision, "old");
  });
});

test("serialized saves retain mutations, deletions and multiple queued writes", async () => {
  await fixture(async ({ makeStore, ready, release, persisted }) => {
    const { store } = await makeStore();
    store.set("blog", "removed", { revision: "old" });
    const first = store.writeToDisk();
    await ready;
    store.delete("blog", "removed");
    store.set("blog", "article", { revision: "second" });
    const second = store.writeToDisk();
    store.set("blog", "article", { revision: "latest" });
    const third = store.writeToDisk();
    const flushed = store.waitUntilSaveComplete();
    release();
    await Promise.all([first, second, third, flushed]);
    assert.equal(persisted().get("blog").has("removed"), false);
    assert.equal(persisted().get("blog").get("article").revision, "latest");
  });
});

test("separate stores do not block one another", async () => {
  await fixture(async ({ makeStore, ready, release, persisted }) => {
    const { store: firstStore } = await makeStore();
    firstStore.set("blog", "article", { revision: "first" });
    const first = firstStore.writeToDisk();
    await ready;
    const { store: secondStore, url } = await makeStore();
    secondStore.set("blog", "article", { revision: "independent" });
    await secondStore.writeToDisk();
    assert.equal(persisted(url).get("blog").get("article").revision, "independent");
    release();
    await first;
  });
});

test("a rejected save reaches its caller and the queue recovers", async () => {
  await fixture(async ({ makeStore, ready, release, persisted, failNextWrite }) => {
    const { store } = await makeStore();
    store.set("blog", "article", { revision: "old" });
    failNextWrite();
    const first = store.writeToDisk();
    const rejected = assert.rejects(first, /UnknownFilesystemError|simulated write failure|unknown filesystem/i);
    await ready;
    store.set("blog", "article", { revision: "recovered" });
    const second = store.writeToDisk();
    release();
    await rejected;
    await second;
    assert.equal(persisted().get("blog").get("article").revision, "recovered");
  });
});

test("installation is idempotent and rejects unreviewed Astro versions", () => {
  class TestStore extends MutableDataStore {}
  serializeContentStoreWrites(TestStore, version);
  const installed = TestStore.prototype.writeToDisk;
  serializeContentStoreWrites(TestStore, version);
  assert.equal(TestStore.prototype.writeToDisk, installed);
  assert.throws(() => serializeContentStoreWrites(TestStore, "6.0.0"), /Review or remove/);
  assert.throws(() => serializeContentStoreWrites(TestStore, "5.18.2"), /Review or remove/);
  assert.throws(() => serializeContentStoreWrites(class {}, version), /writeToDisk is unavailable/);
});
