// Rehype plugin: inject an in-article AdSense slot before the 2nd top-level
// <h2> of a blog post. Skipped when:
//   - the post has fewer than 3 top-level <h2> headings (too short to justify
//     a mid-content ad)
//   - the markdown file is not a blog post (pillar pages, etc.)
//
// The AdSense JS auto-discovers the resulting <ins class="adsbygoogle"> when
// the deferred bundle finally loads — no client-side push() needed.

import { ADSENSE_CLIENT, ADSENSE_SLOT_IN_ARTICLE } from "./adsense.mjs";

export function rehypeInjectAd() {
  return (tree, file) => {
    if (!isBlogPost(file)) return;
    if (!Array.isArray(tree.children)) return;

    const h2Indices = [];
    tree.children.forEach((node, i) => {
      if (node.type === "element" && node.tagName === "h2") h2Indices.push(i);
    });

    if (h2Indices.length < 3) return;

    const insertAt = h2Indices[1];
    tree.children.splice(insertAt, 0, makeAdNode());
  };
}

function isBlogPost(file) {
  const p = file && file.path ? String(file.path) : "";
  if (!p) return false;
  // Match both POSIX and Windows path separators.
  return /[\\/]content[\\/]blog[\\/]/.test(p);
}

function makeAdNode() {
  return {
    type: "element",
    tagName: "aside",
    properties: {
      className: ["adslot", "adslot-in-article"],
      "aria-label": "Advertisement",
    },
    children: [
      {
        type: "element",
        tagName: "span",
        properties: { className: ["adslot-label", "muted"] },
        children: [{ type: "text", value: "Advertisement" }],
      },
      {
        type: "element",
        tagName: "ins",
        properties: {
          className: ["adsbygoogle"],
          style: "display:block; text-align:center;",
          "data-ad-client": ADSENSE_CLIENT,
          "data-ad-slot": ADSENSE_SLOT_IN_ARTICLE,
          "data-ad-format": "fluid",
          "data-ad-layout": "in-article",
        },
        children: [],
      },
    ],
  };
}
