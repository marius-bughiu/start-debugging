import path from "node:path";
import type { APIRoute, GetStaticPaths } from "astro";
import { readExampleManifest, buildExampleArchive } from "../../lib/example-archives.mjs";

export const prerender = true;
const directory = path.resolve(process.cwd(), "../examples");

export const getStaticPaths: GetStaticPaths = async () =>
  (await readExampleManifest(directory)).map((example) => ({ params: { slug: example.slug }, props: { example } }));

export const GET: APIRoute = async ({ props }) => {
  const bytes = await buildExampleArchive(directory, props.example, path.resolve(directory, "../LICENSE"));
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${props.example.slug}.zip"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
};
