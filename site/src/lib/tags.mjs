/**
 * Reviewed synonyms, not a list of small topics to remove. Keep distinct
 * products, versions and APIs separate (e.g. Flutter Container vs containers).
 * Canonical targets must not themselves be aliases: redirects stay one hop.
 */
/** @type {Readonly<Record<string, string>>} */
export const TAG_ALIASES = Object.freeze({
  "agent-framework": "microsoft-agent-framework",
  agentskills: "agent-skills",
  "aspnet-core": "aspnetcore",
  "aspnet-core-11": "aspnetcore-11",
  "dotnet-maui": "maui",
  efcore: "ef-core",
  "efcore-11": "ef-core-11",
  "memory-leak": "memory-leaks",
  "minimal-api": "minimal-apis",
  "node-js": "nodejs",
  spans: "span",
  vscode: "vs-code",
});

const allLanguages = (pages) => ({ en: pages, es: pages, "pt-br": pages, de: pages, ru: pages, ja: pages });

/**
 * Existing URL inventory at consolidation (2026-11-01). Keep this even after
 * source tags are rewritten: old links must continue to resolve. Counts are
 * the number of legacy pages, not current post counts. Never reduce them.
 * @type {Readonly<Record<string, Record<string, number>>>}
 */
export const LEGACY_TAG_PAGES = Object.freeze({
  "agent-framework": allLanguages(1),
  agentskills: { en: 1 },
  "aspnet-core": allLanguages(2),
  "aspnet-core-11": allLanguages(1),
  "dotnet-maui": allLanguages(2),
  efcore: allLanguages(2),
  "efcore-11": allLanguages(1),
  "memory-leak": { en: 1 },
  "minimal-api": allLanguages(1),
  "node-js": { en: 1 },
  spans: allLanguages(1),
  vscode: allLanguages(1),
});

/** @param {string} tag @returns {string} */
export function canonicalTag(tag) {
  return Object.hasOwn(TAG_ALIASES, tag) ? TAG_ALIASES[tag] : tag;
}

/** @param {string[]} tags @returns {string[]} */
export function canonicalTags(tags) {
  return [...new Set(tags.map(canonicalTag))];
}

/** @type {Record<string, string>} */
const TITLES = {
  "agent-skills": "Agent skills",
  aspnetcore: "ASP.NET Core",
  "aspnetcore-11": "ASP.NET Core 11",
  "ef-core": "EF Core",
  "ef-core-11": "EF Core 11",
  maui: ".NET MAUI",
  "memory-leaks": "Memory leaks",
  "microsoft-agent-framework": "Microsoft Agent Framework",
  "minimal-apis": "Minimal APIs",
  nodejs: "Node.js",
  span: "Span<T> and ReadOnlySpan<T>",
  "vs-code": "VS Code",
};

/** @param {string} tag @returns {string} */
export function tagTitle(tag) {
  const canonical = canonicalTag(tag);
  return Object.hasOwn(TITLES, canonical) ? TITLES[canonical] : canonical;
}

/**
 * Build canonical tag listings and redirects for the alias URLs that existed
 * in this language, including their old pagination. Counting each post once
 * prevents a post tagged with both spellings from appearing twice.
 *
 * @template {{slug: string, data: {tags?: string[], tagAliases?: string[]}}} T
 * @param {T[]} posts Newest first, already filtered to published/same-language.
 * @param {number} [pageSize]
 * @param {string} [locale]
 */
export function tagPages(posts, pageSize = 10, locale = "en") {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("Invalid tag page size");
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  /** @type {Map<string, number>} */
  const aliases = new Map();
  for (const post of posts) {
    const tags = post.data.tags ?? [];
    for (const tag of canonicalTags(tags)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(post);
    }
    // Raw tags are accepted too, for authoring tools and tests.
    for (const alias of new Set([...(post.data.tagAliases ?? []), ...tags])) {
      if (canonicalTag(alias) !== alias) aliases.set(alias, (aliases.get(alias) ?? 0) + 1);
    }
  }
  for (const [alias, locales] of Object.entries(LEGACY_TAG_PAGES)) {
    if (locales[locale] && groups.has(canonicalTag(alias))) {
      aliases.set(alias, Math.max(aliases.get(alias) ?? 0, locales[locale] * pageSize));
    }
  }

  /** @type {{slug: string, tag: string, posts: T[], totalCount: number, page: number, totalPages: number, redirect?: string}[]} */
  const pages = [];
  for (const [tag, entries] of groups) {
    const totalPages = Math.ceil(entries.length / pageSize);
    for (let page = 1; page <= totalPages; page++) {
      pages.push({
        slug: page === 1 ? tag : `${tag}/${page}`,
        tag,
        posts: entries.slice((page - 1) * pageSize, page * pageSize),
        totalCount: entries.length,
        page,
        totalPages,
      });
    }
  }
  for (const [alias, count] of aliases) {
    const tag = canonicalTag(alias);
    const canonicalPageCount = Math.ceil((groups.get(tag)?.length ?? 0) / pageSize);
    if (!canonicalPageCount) continue;
    for (let page = 1; page <= Math.ceil(count / pageSize); page++) {
      // If posts are later removed, old pagination still has a valid target.
      const targetPage = Math.min(page, canonicalPageCount);
      pages.push({
        slug: page === 1 ? alias : `${alias}/${page}`,
        tag,
        posts: [],
        totalCount: count,
        page,
        totalPages: Math.ceil(count / pageSize),
        redirect: targetPage === 1 ? tag : `${tag}/${targetPage}`,
      });
    }
  }
  return pages;
}

/** Keep redirect URLs out of the sitemap, including translated/paged tags.
 * @param {string} pathname
 */
export function isTagAliasPath(pathname) {
  const match = pathname.match(/^\/(?:es\/|pt-br\/|de\/|ru\/|ja\/)?tag\/([^/]+)(?:\/\d+)?\/?$/);
  return !!match && canonicalTag(match[1]) !== match[1];
}
