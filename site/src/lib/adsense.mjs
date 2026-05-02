// AdSense client + slot configuration. Single source of truth, imported by
// both the AdSlot component (Astro renders these into <ins> tags at request
// time) and the rehype-inject-ad plugin (which splices in-article slots into
// post HTML at build time).
//
// Slot IDs come from the AdSense console (Ads → By ad unit). They are public
// (every visitor sees them in view-source as data-ad-slot=…) so we hardcode
// them here rather than wiring through env vars — keeps local dev, preview
// builds, and CI all in sync with no extra config.
//
// Kept as .mjs (not .ts) because astro.config.mjs's rehype plugin chain loads
// rehype-inject-ad.mjs via Node's plain ESM loader, which does not handle TS.
// The file has no actual types to lose by being .mjs.

export const ADSENSE_CLIENT = "ca-pub-1537458730659685";
export const ADSENSE_SLOT_TOP = "1130774528";
export const ADSENSE_SLOT_IN_ARTICLE = "7504611185";
