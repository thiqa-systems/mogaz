// فحص لمرة واحدة: يجرّب كل خلاصة مرشّحة ويكتب النتيجة في tools/feed-check.json
import { readFile, writeFile } from "node:fs/promises";
import { parseFeed } from "../scripts/update.mjs";
const list = JSON.parse(await readFile(new URL("candidates.json", import.meta.url), "utf8"));
const out = await Promise.all(list.map(async ([sec, name, url]) => {
  const r = { sec, name, url };
  for (const accept of ["application/rss+xml, application/xml, text/xml, */*", "*/*"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (compatible; MogazBot/1.0; RSS reader)", accept } });
      r.status = res.status;
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseFeed(xml, name);
      const firstItem = (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/i) || [""])[0];
      r.rawDates = (firstItem.match(/<(pubDate|dc:date|updated|published)[^>]*>[\s\S]*?<\/\1>/gi) || []).slice(0, 2);
      r.rawSource = (firstItem.match(/<[^>]*source[^>]*>[\s\S]*?<\/[^>]*source>/i) || [""])[0].slice(0, 200);
      r.rawLink = (firstItem.match(/<link[^>]*>[\s\S]*?<\/link>|<link[^>]*\/>/i) || [""])[0].slice(0, 300);
      const times = items.map((i) => Date.parse(i.time)).filter(Number.isFinite);
      r.items = items.length;
      r.fresh24h = times.filter((t) => Date.now() - t < 24 * 3600e3).length;
      r.newest = times.length ? new Date(Math.max(...times)).toISOString() : null;
      r.sample = items.slice(0, 3).map((i) => i.title + " | " + i.source);
      r.accept = accept;
      break;
    } catch (e) { r.error = String(e.message || e); }
  }
  return r;
}));
await writeFile(new URL("feed-check.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(out.map((r) => `${r.status ?? "ERR"} ${String(r.fresh24h ?? "-").padStart(3)}/${String(r.items ?? "-").padEnd(3)} ${r.name}`).join("\n"));
