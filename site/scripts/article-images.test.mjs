import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import rehypeRaw from "rehype-raw";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { JSDOM } from "jsdom";
import { rehypeArticleImages, articleImageWidths } from "../src/lib/rehype-article-images.mjs";

let fixture, publicDir, postPath;
before(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), "article-images-"));
  publicDir = path.join(fixture, "public");
  postPath = path.join(fixture, "src/content/blog/2026/01/example.md");
  await fs.mkdir(publicDir);
  await fs.mkdir(path.dirname(postPath), { recursive: true });
  await sharp({ create: { width: 1200, height: 600, channels: 4, background: "#123456" } })
    .png().toFile(path.join(publicDir, "screen.png"));
  await fs.copyFile(
    fileURLToPath(new URL("../public/wp-content/uploads/2019/01/animations3.gif", import.meta.url)),
    path.join(publicDir, "animation.gif"),
  );
});
after(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

async function transform(properties, parentTag = "p") {
  const image = { type: "element", tagName: "img", properties: { ...properties }, children: [] };
  const tree = { type: "root", children: [{ type: "element", tagName: parentTag, children: [image] }] };
  const file = { path: postPath, data: {}, messages: [], message(text) { this.messages.push(text); } };
  await rehypeArticleImages({ publicDir })(tree, file);
  return { properties: image.properties, file };
}

test("public screenshot imports get bounded responsive widths and a reserved aspect ratio", async () => {
  const { properties: p, file } = await transform({ src: "/screen.png", alt: "Configuration screen" });
  assert.equal(path.resolve(path.dirname(postPath), p.src), path.join(publicDir, "screen.png"));
  assert.deepEqual(file.data.astro.localImagePaths, [p.src]);
  assert.equal(p.width, 754);
  assert.equal(p.height, 377);
  assert.equal(p.format, "webp");
  assert.equal(p.quality, 90);
  assert.equal(p.loading, "lazy");
  assert.deepEqual(p.widths, [320, 640, 960, 1200]);
  assert.match(p.sizes, /100vw - 66px/);
  assert.match(p.sizes, /100vw - 86px/);
  assert.deepEqual(articleImageWidths(180), [180]);
  assert.deepEqual(articleImageWidths(4000), [320, 640, 960, 1508]);
});

test("author loading, priority, decoding, size and responsive choices survive", async () => {
  const { properties: p } = await transform({
    src: "/screen.png", alt: "Hero", loading: "eager", fetchPriority: "high",
    decoding: "sync", width: 300, sizes: "300px",
  });
  assert.equal(p.loading, "eager");
  assert.equal(p.fetchpriority, "high");
  assert.equal(p.decoding, "sync");
  assert.equal(p.width, 300);
  assert.equal(p.height, 150);
  assert.equal(p.sizes, "300px");
  const explicitSet = await transform({ src: "/screen.png", alt: "Example", srcSet: "/small.png 320w" });
  assert.equal(explicitSet.properties.src, "/screen.png");
  assert.equal(explicitSet.properties.srcSet, "/small.png 320w");
  const highOnly = await transform({ src: "/screen.png", alt: "Hero", fetchPriority: "high" });
  assert.equal(highOnly.properties.loading, "eager");
  const explicitLazy = await transform({ src: "/screen.png", alt: "Example", loading: "lazy", fetchPriority: "high" });
  assert.equal(explicitLazy.properties.loading, "lazy");
});

test("animation stays byte-identical and reserves one frame, not the entire strip", async () => {
  const gif = path.join(publicDir, "animation.gif");
  const original = await fs.readFile(gif);
  const { properties: p, file } = await transform({ src: "/animation.gif", alt: "Animated background layers" });
  assert.equal(p.src, "/animation.gif");
  assert.equal(p.width, 751);
  assert.equal(p.height, 482);
  assert.equal(p.widths, undefined);
  assert.equal(file.data.astro, undefined);
  assert.deepEqual(await fs.readFile(gif), original);
});

test("animated PNG is not flattened even when the decoder exposes only one frame", async () => {
  const png = await fs.readFile(path.join(publicDir, "screen.png"));
  // A valid animation-control chunk is enough to identify APNG; no need to
  // render or store a complete animation fixture just to test that decision.
  const data = Buffer.alloc(12);
  data.write("acTL");
  data.writeUInt32BE(2, 4);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8);
  data.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 16);
  await fs.writeFile(path.join(publicDir, "animation.png"), Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]));
  const { properties: p } = await transform({ src: "/animation.png", alt: "APNG example" });
  assert.equal(p.src, "/animation.png");
  assert.equal(p.width, 1200);
  assert.equal(p.height, 600);
  assert.equal(p.format, undefined);
});

test("remote, picture and decorative images retain their source and semantics", async () => {
  const remote = await transform({
    src: "https://example.invalid/screenshot.png", alt: "Remote example",
    width: 80, height: 40, loading: "eager", fetchPriority: "high", decoding: "sync",
  });
  assert.equal(remote.properties.src, "https://example.invalid/screenshot.png");
  assert.equal(remote.properties.width, 80);
  assert.equal(remote.properties.loading, "eager");
  assert.equal(remote.properties.fetchpriority, "high");
  assert.equal(remote.properties.decoding, "sync");
  assert.equal(remote.file.messages.length, 0);
  const picture = await transform({ src: "/screen.png", alt: "Art-directed picture" }, "picture");
  assert.equal(picture.properties.src, "/screen.png");
  const decorative = await transform({ src: "/screen.png", alt: "" });
  assert.equal(decorative.properties.alt, "");
  assert.equal(decorative.properties.src, "/screen.png");
  assert.equal(decorative.properties.width, 1200);
});

test("missing files are reported and public URLs cannot read outside public", async () => {
  const missing = await transform({ src: "/missing.png", alt: "Missing" });
  assert.equal(missing.properties.src, "/missing.png");
  assert.match(missing.file.messages[0], /Unable to read local image/);
  await fs.copyFile(path.join(publicDir, "screen.png"), path.join(fixture, "outside.png"));
  await fs.symlink(path.join(fixture, "outside.png"), path.join(publicDir, "symlink.png"));
  for (const src of ["/../outside.png", "/%2e%2e/outside.png", "/symlink.png", "//example.invalid/image.png"]) {
    const { properties: p, file } = await transform({ src, alt: "Example" });
    assert.equal(p.src, src);
    assert.equal(p.width, undefined);
    assert.equal(file.data.astro, undefined);
  }
});

test("Astro Markdown integration handles linked/reference images and explicit HTML attributes", async () => {
  const processor = await createMarkdownProcessor({
    syntaxHighlight: false,
    rehypePlugins: [rehypeRaw, [rehypeArticleImages, { publicDir }]],
  });
  const result = await processor.render([
    '[![Setup screen](/screen.png)](/screen.png)',
    '![Second view][screen]',
    '[screen]: /screen.png',
    '<img src="/screen.png" alt="Above-fold example" loading="eager" fetchpriority="high" decoding="sync">',
    '<img src="https://example.invalid/remote.png" alt="Remote" loading="eager" fetchpriority="high">',
    '```html\n<img src="/missing.png" alt="Code example">\n```',
  ].join('\n\n'), { fileURL: pathToFileURL(postPath) });
  assert.equal(result.metadata.localImagePaths.length, 1);
  const document = new JSDOM(result.code).window.document;
  assert.equal(document.querySelector("a").getAttribute("href"), "/screen.png");
  const images = [...document.querySelectorAll("img")];
  assert.equal(images.length, 4);
  const optimized = images.slice(0, 3).map((img) => JSON.parse(img.getAttribute("__ASTRO_IMAGE_")));
  assert.equal(optimized[0].alt, "Setup screen");
  assert.equal(optimized[1].alt, "Second view");
  assert.equal(optimized[2].loading, "eager");
  assert.equal(optimized[2].fetchpriority, "high");
  assert.equal(optimized[2].decoding, "sync");
  assert.equal(images[3].getAttribute("fetchpriority"), "high");
  assert.equal(images[3].getAttribute("loading"), "eager");
  assert.match(document.querySelector("pre").textContent, /\/missing.png/);
});

test("a real Astro build emits public-image variants and preserves final HTML attributes", async () => {
  await fs.writeFile(path.join(fixture, "package.json"), '{"type":"module"}\n');
  await fs.symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), path.join(fixture, "node_modules"), "dir");
  const configModule = import.meta.resolve("astro/config");
  const rawModule = import.meta.resolve("rehype-raw");
  const imageModule = new URL("../src/lib/rehype-article-images.mjs", import.meta.url).href;
  await fs.writeFile(path.join(fixture, "astro.config.mjs"), `
    import { defineConfig } from ${JSON.stringify(configModule)};
    import rehypeRaw from ${JSON.stringify(rawModule)};
    import { rehypeArticleImages } from ${JSON.stringify(imageModule)};
    export default defineConfig({
      cacheDir: ${JSON.stringify(path.join(fixture, ".astro-cache"))},
      vite: { cacheDir: ${JSON.stringify(path.join(fixture, ".vite-cache"))} },
      markdown: { rehypePlugins: [rehypeRaw, [rehypeArticleImages, { publicDir: ${JSON.stringify(publicDir)} }]] }
    });
  `);
  await fs.writeFile(postPath, [
    '---\ntitle: Image integration fixture\n---',
    '[![Default screenshot](/screen.png)](/screen.png)',
    '<img src="/screen.png" alt="Priority screenshot" loading="eager" fetchpriority="high" decoding="sync">',
    '<img src="https://example.invalid/remote.png" alt="Remote screenshot" loading="eager" fetchpriority="high">',
    '![Animated layers](/animation.gif)',
    '![](/screen.png)',
    "![Developer's setup](/screen.png)",
    '![A & B](/screen.png)',
    '![Choose "Web" template](/screen.png)',
    '![Width < 600 > 300](/screen.png)',
    '![Literal &amp;copy; label](/screen.png)',
    '<img src="/screen.png" alt="Safe alt" title="Editor\'s &amp; view">',
  ].join('\n\n'));
  await fs.mkdir(path.join(fixture, "src/pages"));
  await fs.writeFile(path.join(fixture, "src/content.config.ts"), `
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = { blog: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/blog' }) }) };
`);
  await fs.writeFile(path.join(fixture, "src/pages/index.astro"), `---
import { getCollection, render } from 'astro:content';
const [entry] = await getCollection('blog');
const { Content } = await render(entry);
---
<html lang="en"><body><article><Content /></article></body></html>
`);
  const astroCLI = fileURLToPath(new URL("../node_modules/astro/astro.js", import.meta.url));
  await promisify(execFile)(process.execPath, [astroCLI, "build", "--root", fixture], {
    cwd: fixture, timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
  const dist = path.join(fixture, "dist");
  const document = new JSDOM(await fs.readFile(path.join(dist, "index.html"), "utf8")).window.document;
  const [normal, priority, remote, animation, decorative, ...textCases] = document.querySelectorAll("article img");
  assert.equal(normal.getAttribute("alt"), "Default screenshot");
  assert.equal(normal.getAttribute("loading"), "lazy");
  assert.equal(normal.getAttribute("width"), "754");
  assert.equal(normal.getAttribute("height"), "377");
  assert.match(normal.getAttribute("src"), /^\/_astro\/.+\.webp$/);
  for (const candidate of normal.getAttribute("srcset").split(", ")) {
    const [src, descriptor] = candidate.split(" ");
    const metadata = await sharp(path.join(dist, src)).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, Number(descriptor.slice(0, -1)));
    assert.equal(metadata.width / metadata.height, 2);
  }
  assert.equal(priority.getAttribute("alt"), "Priority screenshot");
  assert.equal(priority.getAttribute("loading"), "eager");
  assert.equal(priority.getAttribute("fetchpriority"), "high");
  assert.equal(priority.getAttribute("decoding"), "sync");
  assert.equal(remote.getAttribute("src"), "https://example.invalid/remote.png");
  assert.equal(remote.getAttribute("loading"), "eager");
  assert.equal(remote.getAttribute("fetchpriority"), "high");
  assert.equal(animation.getAttribute("src"), "/animation.gif");
  assert.equal(animation.getAttribute("height"), "482");
  assert.deepEqual(await fs.readFile(path.join(dist, "animation.gif")), await fs.readFile(path.join(publicDir, "animation.gif")));
  assert.equal(decorative.getAttribute("alt"), "");
  assert.equal(decorative.getAttribute("src"), "/screen.png");
  assert.deepEqual(textCases.map((img) => img.getAttribute("alt")), [
    "Developer's setup", "A & B", 'Choose "Web" template', "Width < 600 > 300", "Literal &copy; label", "Safe alt",
  ]);
  assert.equal(textCases.at(-1).getAttribute("title"), "Editor's & view");
  for (const img of textCases) {
    assert.ok(Number(img.getAttribute("width")) > 0);
    assert.ok(Number(img.getAttribute("height")) > 0);
  }
  // Plain double quotes are decoded by Astro's transport and can still use
  // responsive variants; the other cases must retain exact author text.
  assert.match(textCases[2].getAttribute("src"), /^\/_astro\/.+\.webp$/);
  assert.equal(document.querySelector("a").getAttribute("href"), "/screen.png");
});
