// Pulls the latest posts from the portfolio RSS feed and rewrites the
// README section between the BLOG-POST-LIST markers.
import { readFileSync, writeFileSync } from "node:fs";

const FEED_URL = "https://milanbeherazyx.github.io/rss.xml";
const README_PATH = new URL("../../README.md", import.meta.url);
const MAX_POSTS = 4;

const decodeEntities = (str) =>
  str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return "";
  return decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
}

async function main() {
  const res = await fetch(FEED_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch feed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, MAX_POSTS)
    .map((m) => {
      const block = m[1];
      return {
        title: extractTag(block, "title"),
        link: extractTag(block, "link"),
      };
    })
    .filter((post) => post.title && post.link);

  if (items.length === 0) {
    console.log("No posts found in feed; leaving README unchanged.");
    return;
  }

  const listMarkdown = items
    .map((post) => `- [${post.title}](${post.link})`)
    .join("\n");

  const readme = readFileSync(README_PATH, "utf8");
  const startMarker = "<!-- BLOG-POST-LIST:START -->";
  const endMarker = "<!-- BLOG-POST-LIST:END -->";
  const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);

  if (!pattern.test(readme)) {
    throw new Error("Blog post markers not found in README.md");
  }

  const updated = readme.replace(
    pattern,
    `${startMarker}\n${listMarkdown}\n${endMarker}`
  );

  if (updated === readme) {
    console.log("Blog section already up to date.");
    return;
  }

  writeFileSync(README_PATH, updated);
  console.log(`Updated blog section with ${items.length} post(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
