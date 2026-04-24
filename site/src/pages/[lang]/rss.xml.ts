import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import {
  getPublishedBlogPosts,
  isLocale,
  LOCALES,
  urlPathForPost,
  type Locale,
} from "../../lib/blog";

export async function getStaticPaths() {
  // One RSS file per non-English locale. English stays at `/rss.xml`.
  return LOCALES.filter((l) => l !== "en").map((lang) => ({
    params: { lang },
    props: { lang },
  }));
}

export async function GET(context: APIContext) {
  const lang = (context.params.lang ?? "") as string;
  if (!isLocale(lang) || lang === "en") {
    return new Response("Not found", { status: 404 });
  }
  const locale = lang as Locale;
  const posts = await getPublishedBlogPosts(locale);

  return rss({
    title: `Start Debugging (${locale})`,
    description: "Programming-related thoughts.",
    site: context.site!.toString(),
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description ?? "",
      pubDate: post.data.pubDate,
      link: urlPathForPost(post),
    })),
  });
}
