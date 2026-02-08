import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getPublishedBlogPosts } from "../lib/blog";

export async function GET(context: APIContext) {
  const posts = await getPublishedBlogPosts();

  return rss({
    title: "Start Debugging",
    description: "Programming-related thoughts.",
    site: context.site!.toString(),
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description ?? "",
      pubDate: post.data.pubDate,
      link: `/${post.slug}/`,
    })),
  });
}
