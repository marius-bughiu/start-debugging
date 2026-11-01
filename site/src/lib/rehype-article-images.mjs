import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Match the reading area inside the 792px article panel: subtract its padding
// and borders, as well as the main container gutters on smaller viewports.
// Original public files remain available for links to full-size screenshots.
const ARTICLE_WIDTH = 754;
const CANDIDATE_WIDTHS = [320, 640, 960, ARTICLE_WIDTH * 2];
const RASTER_FORMATS = new Set(["jpeg", "png", "webp"]);
const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const metadataCache = new Map();

function isAnimatedPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) return false;
    if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
    offset += length + 12;
  }
  return false;
}

export function articleImageSizes(width) {
  return `(max-width: 640px) min(calc(100vw - 66px), ${width}px), (max-width: 840px) min(calc(100vw - 86px), ${width}px), ${width}px`;
}

export function articleImageWidths(width) {
  const max = Math.min(width, ARTICLE_WIDTH * 2);
  return [...new Set([...CANDIDATE_WIDTHS.filter((value) => value < max), max])];
}

function walk(node, visit, parent) {
  visit(node, parent);
  for (const child of node.children ?? []) walk(child, visit, node);
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function localPublicPath(src, publicDir) {
  // Never fetch remote images, data URLs, or protocol-relative URLs.
  if (typeof src !== "string" || !src.startsWith("/") || src.startsWith("//")) return;
  const pathname = src.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return;
  const resolved = path.resolve(publicDir, `.${decoded}`);
  if (!resolved.startsWith(publicDir + path.sep)) return;
  return resolved;
}

async function readMetadata(filename, publicDir) {
  // Symlinks cannot turn an article URL into a read outside public/.
  const real = await fs.realpath(filename);
  const realPublic = await fs.realpath(publicDir);
  if (!real.startsWith(realPublic + path.sep)) return;
  const stat = await fs.stat(real);
  const key = `${real}:${stat.size}:${stat.mtimeMs}`;
  let pending = metadataCache.get(key);
  if (!pending) {
    pending = fs.readFile(real).then(async (bytes) => {
      const metadata = await sharp(bytes, { animated: true }).metadata();
      // Sharp reports the total strip height for animated images. Reserve one
      // frame's space, not the combined height of every frame.
      const width = metadata.autoOrient?.width ?? metadata.width;
      const height = metadata.pages > 1
        ? metadata.pageHeight
        : metadata.autoOrient?.height ?? metadata.height;
      return { ...metadata, width, height, animated: metadata.pages > 1 || isAnimatedPng(bytes) };
    });
    metadataCache.set(key, pending);
    pending.catch(() => metadataCache.delete(key));
  }
  return pending;
}

/**
 * Run after rehype-raw and before Astro's built-in rehypeImages pass.
 * Register public images as local Astro imports without changing Markdown URLs.
 * Astro then emits/caches WebP variants using its normal build image pipeline.
 *
 * Authors may use an HTML <img loading="eager" fetchpriority="high"> for a
 * measured above-fold/LCP image. We preserve explicit loading, decoding, sizes,
 * and srcset choices; no first-image heuristic is applied.
 */
export function rehypeArticleImages({ publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  publicDir = path.resolve(publicDir);
  return async (tree, file) => {
    if (!/[\\/]content[\\/]blog[\\/]/.test(String(file?.path ?? ""))) return;
    const images = [];
    walk(tree, (node, parent) => {
      if (node.type === "element" && node.tagName === "img") images.push({ node, parent });
    });
    await Promise.all(images.map(async ({ node, parent }) => {
      const props = node.properties ??= {};
      // HAST uses fetchPriority while Astro's image options use fetchpriority.
      if (props.fetchPriority !== undefined) {
        props.fetchpriority ??= props.fetchPriority;
        delete props.fetchPriority;
      }
      props.loading ??= props.fetchpriority === "high" ? "eager" : "lazy";
      props.decoding ??= "async";

      const originalSrc = props.src;
      const filename = localPublicPath(originalSrc, publicDir);
      if (!filename) return;
      let metadata;
      try {
        metadata = await readMetadata(filename, publicDir);
      } catch (error) {
        file.message?.(`Unable to read local image ${originalSrc}: ${error.code ?? error.message}`);
        return;
      }
      if (!metadata?.width || !metadata?.height) return;

      const width = positiveNumber(props.width);
      const height = positiveNumber(props.height);
      props.width = width ?? (height ? Math.round(height * metadata.width / metadata.height) : metadata.width);
      props.height = height ?? (width ? Math.round(width * metadata.height / metadata.width) : metadata.height);

      // Keep animation bytes untouched, along with SVGs and author picture/srcset
      // markup. Query/fragment URLs may carry author-specific semantics.
      // Astro 5's content renderer omits empty attributes on optimized images.
      // Keep deliberate alt="" on the native <img>, where it stays accessible.
      // Its image JSON transport also leaves apostrophes/ampersands encoded,
      // then escapes them again. Keep affected author attributes on the native
      // element until that upstream serialization behavior is corrected.
      const needsNativeAttributes = Object.values(props).some((value) =>
        typeof value === "string" && /['&]/.test(value));
      if (!RASTER_FORMATS.has(metadata.format) || metadata.animated || props.alt === "" ||
          needsNativeAttributes ||
          parent?.tagName === "picture" || props.srcSet || props.srcset ||
          /[?#]/.test(originalSrc)) return;

      // Relative imports are what Astro's Markdown image pass recognizes.
      const relative = path.relative(path.dirname(String(file.path)), filename).split(path.sep).join("/");
      props.src = relative.startsWith(".") ? relative : `./${relative}`;
      file.data ??= {};
      file.data.astro ??= {};
      file.data.astro.localImagePaths ??= [];
      if (!file.data.astro.localImagePaths.includes(props.src)) {
        file.data.astro.localImagePaths.push(props.src);
      }
      const displayWidth = Math.min(width ?? metadata.width, ARTICLE_WIDTH);
      if (!width && !height) {
        props.width = displayWidth;
        props.height = Math.round(displayWidth * metadata.height / metadata.width);
      }
      props.widths = articleImageWidths(metadata.width);
      props.sizes ??= articleImageSizes(displayWidth);
      props.format = "webp";
      props.quality = 90;
    }));
  };
}
