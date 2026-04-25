// Schema.org JSON-LD extractors for AI-search optimization.
//
// Extracts FAQPage / HowTo blocks from a post's markdown body, keyed off the
// `template` frontmatter field. Both Google's Rich Results and AI surfaces
// (Perplexity, ChatGPT Search, Google AI Overviews) preferentially cite
// content with explicit Q→A or step structure.
//
// The extractors are deliberately conservative: if the body doesn't match the
// expected template shape, return null and the page falls back to plain
// BlogPosting JSON-LD.

export type Faq = { question: string; answer: string };
export type HowToStep = { name: string; text: string };

// Strip markdown formatting from a section so the JSON-LD answer reads as
// plain text. Preserves inline code by unwrapping backticks.
function plainText(md: string): string {
  let out = md;
  // Fenced code blocks → keep content but drop the fences and language tag.
  out = out.replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, (_m, body) => body.trim());
  // Inline code: drop backticks.
  out = out.replace(/`([^`]+)`/g, "$1");
  // Bold / italic / strikethrough: drop markers, keep text.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/_([^_]+)_/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  // Markdown links → keep text only.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Images: drop entirely.
  out = out.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  // Block quotes: drop the `> ` prefix.
  out = out.replace(/^> ?/gm, "");
  // Reference-style images and links left over: best-effort cleanup.
  out = out.replace(/^\[[^\]]+\]:\s*\S+.*$/gm, "");
  // Collapse whitespace.
  out = out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

// Split markdown into sections keyed by H2 heading. Anything before the first
// H2 is returned as the lead paragraph. Headings deeper than H2 stay inside
// their parent section.
function splitByH2(body: string): { lead: string; sections: { heading: string; body: string }[] } {
  const lines = body.split(/\r?\n/);
  let lead = "";
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), body: "" };
    } else if (current) {
      current.body += line + "\n";
    } else {
      lead += line + "\n";
    }
  }
  if (current) sections.push(current);
  return { lead: lead.trim(), sections };
}

// Drop the `## Sources` / `## Related` tail sections — they don't belong in a
// FAQ and they bloat the JSON-LD payload. Match leniently on heading text.
function isTailSection(heading: string): boolean {
  const h = heading.toLowerCase().trim();
  return (
    h === "sources" ||
    h === "source" ||
    h === "related" ||
    h === "related posts" ||
    h === "see also" ||
    h === "further reading"
  );
}

// FAQPage extraction for `template: error-page` posts.
//
// The template enforces:
//   H1 (the error verbatim) → page name (handled outside this fn)
//   TL;DR fix paragraph     → first FAQ answer, paired with "How do I fix this?"
//   The error in context    → skipped (preformatted, not Q/A)
//   ## Why this happens     → "Why does this happen?"
//   ## Minimal repro        → skipped (code-only, not Q/A)
//   ## Fix, in detail       → skipped if TL;DR already covered it; included
//                             only when neither "fix" nor TL;DR is empty
//   ## Gotchas / variants   → "What are common variants of this error?"
//   ## Related / Sources    → dropped
//
// Returns null when the body doesn't have at least one usable Q/A pair so the
// caller can skip emission rather than ship malformed schema.
export function extractFaqFromMarkdown(
  body: string,
  pageTitle: string,
): Faq[] | null {
  const { lead, sections } = splitByH2(body);
  const faqs: Faq[] = [];

  // First Q/A: the TL;DR paragraph paired with a synthesized question. The
  // template guarantees the lead is the answer.
  const leadAnswer = plainText(lead);
  if (leadAnswer.length >= 20) {
    faqs.push({
      question: `How do I fix "${pageTitle.replace(/^Fix:\s*/i, "").trim()}"?`,
      answer: leadAnswer,
    });
  }

  for (const s of sections) {
    if (isTailSection(s.heading)) continue;
    const answer = plainText(s.body);
    if (answer.length < 20) continue;

    const h = s.heading.toLowerCase();
    let question: string;
    if (h.startsWith("why")) {
      question = "Why does this happen?";
    } else if (h.startsWith("gotcha") || h.includes("variant")) {
      question = "What are common variants of this error?";
    } else if (h.startsWith("fix") && faqs.length > 0) {
      // TL;DR already gave the answer; fold the detailed fix as a follow-up.
      question = "What's the full fix?";
    } else if (h.startsWith("minimal repro") || h.startsWith("repro")) {
      // Repro sections are code-only; not useful as a Q/A pair.
      continue;
    } else if (h === "the error in context" || h.startsWith("the error")) {
      continue;
    } else {
      // Use the heading itself as the question if we don't have a synonym.
      question = s.heading.endsWith("?") ? s.heading : `${s.heading}?`;
    }

    faqs.push({ question, answer });
  }

  return faqs.length >= 2 ? faqs : null;
}

// HowTo extraction for `template: how-to` and `template: migration` posts.
//
// Looks for a numbered list inside a "## Migration steps" / "## Steps" /
// "## How to ..." section. Each list item becomes a HowToStep. If no
// numbered-list section is found, falls back to using H2 sections (excluding
// tail sections) as steps.
//
// Returns null when fewer than 2 steps are extractable.
export function extractHowToFromMarkdown(body: string): HowToStep[] | null {
  const { sections } = splitByH2(body);

  // Strategy 1: find a step-list section and parse its numbered items.
  const stepSection = sections.find((s) => {
    const h = s.heading.toLowerCase();
    return (
      h.includes("step") ||
      h.startsWith("how to") ||
      h.startsWith("procedure") ||
      h.startsWith("instructions")
    );
  });

  if (stepSection) {
    const steps = parseNumberedList(stepSection.body);
    if (steps.length >= 2) return steps;
  }

  // Strategy 2: any numbered list anywhere in the doc.
  const allSteps = parseNumberedList(body);
  if (allSteps.length >= 2) return allSteps;

  // Strategy 3: fall back to H2 sections themselves as steps. Skip tail
  // sections and skip the TL;DR-equivalent first section.
  const h2Steps: HowToStep[] = sections
    .filter((s) => !isTailSection(s.heading))
    .map((s) => ({
      name: s.heading,
      text: plainText(s.body).slice(0, 500),
    }))
    .filter((s) => s.text.length >= 20);

  return h2Steps.length >= 2 ? h2Steps : null;
}

// Parse `1. foo\n2. bar` lists. The first line of each item is the step name;
// subsequent indented lines (until the next numbered item) are the body.
function parseNumberedList(body: string): HowToStep[] {
  const steps: HowToStep[] = [];
  const lines = body.split(/\r?\n/);
  let current: { name: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (m) {
      if (current) {
        steps.push({ name: current.name, text: plainText(current.body).slice(0, 500) });
      }
      current = { name: plainText(m[1]).slice(0, 110), body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) {
    steps.push({ name: current.name, text: plainText(current.body).slice(0, 500) });
  }
  return steps.filter((s) => s.name.length > 0);
}

// Build a FAQPage JSON-LD object. The caller decides whether to emit it.
export function buildFaqPageJsonLd(faqs: Faq[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

// Build a HowTo JSON-LD object. The caller decides whether to emit it.
export function buildHowToJsonLd(args: {
  name: string;
  description?: string;
  steps: HowToStep[];
  url: string;
  image?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: args.name,
    step: args.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
    url: args.url,
  };
  if (args.description) out.description = args.description;
  if (args.image) out.image = args.image;
  return out;
}
