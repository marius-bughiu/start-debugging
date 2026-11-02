import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import { serializeJsonLd } from "../src/lib/json-ld.mjs";

function elements(root, tagName) {
  const result = [];
  const walk = (node) => {
    if (node.tagName === tagName) result.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  return result;
}

test("JSON-LD containing HTML examples stays in one inert script and round-trips intact", () => {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [{
      "@type": "Question", name: "How do I load the script?",
      acceptedAnswer: { "@type": "Answer", text: '<script src="_framework/blazor.server.js"></script> <!-- <script> --> </ScRiPt><script id="injected">alert(1)</script>' },
    }],
  };
  const dom = parse(`<html><head><script type="application/ld+json">${serializeJsonLd(data)}</script></head><body><p>After metadata</p></body></html>`);
  const scripts = elements(dom, "script");
  assert.equal(scripts.length, 1, "code in JSON data must not create additional script elements");
  assert.deepEqual(JSON.parse(scripts[0].childNodes[0].value), data);
  assert.equal(elements(dom, "p")[0].childNodes[0].value, "After metadata");
});

test("JSON-LD preserves Unicode, quotes, ampersands, and ordinary article metadata", () => {
  const data = { "@type": "BlogPosting", headline: 'C# List<T> & "JSON" — 日本語', url: "https://example.test/?a=1&b=2", answer: "\u2028\u2029", count: 0, optional: null };
  assert.deepEqual(JSON.parse(serializeJsonLd(data)), data);
});
