// يجمع العناوين من خلاصات RSS في feeds.json ويكتب data.json. بدون أي مكتبات خارجية (Node 20+).
// اختياري: لو وُجد ANTHROPIC_API_KEY يضيف «في دقيقة» و«ماذا يعني لك» لأهم الأخبار.
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const MAX_AGE_H = 36;      // تجاهل ما هو أقدم من ذلك
const PER_SECTION = 14;    // عدد الأخبار في كل قسم
const PER_SOURCE = 3;      // حد أقصى لكل مصدر داخل القسم، لضمان التنوع
const TIMEOUT_MS = 15000;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};

// يقبل RSS 2.0 و RDF و Atom
export function parseFeed(xml, fallbackName = "") {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const out = [];
  for (const b of blocks) {
    let title = decode(tag(b, "title"));
    let url = decode(tag(b, "link"));
    if (!url) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = m ? decode(m[1]) : "";
    }
    const dateRaw = decode(tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "updated") || tag(b, "published"));
    const t = Date.parse(dateRaw);
    // المصدر المسمّى في feeds.json له الأولوية؛ وسم <source> يُستخدم فقط مع خلاصات أخبار جوجل
    let source = fallbackName || decode(tag(b, "source"));
    // أخبار جوجل تكتب «العنوان - المصدر»
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    if (!title || !/^https?:\/\//i.test(url) || !source) continue;
    out.push({ title, url, source, time: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return out;
}

const norm = (s) => s.replace(/[ً-ْـ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

export function pick(items, now = Date.now()) {
  const seen = new Set();
  const perSource = new Map();
  const fresh = items
    .filter((i) => i.time && now - Date.parse(i.time) < MAX_AGE_H * 3600e3 && Date.parse(i.time) <= now + 3600e3)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const out = [];
  for (const i of fresh) {
    const key = norm(i.title).split(" ").slice(0, 8).join(" ");
    if (seen.has(key)) continue;
    const n = perSource.get(i.source) || 0;
    if (n >= PER_SOURCE) continue;
    seen.add(key);
    perSource.set(i.source, n + 1);
    out.push(i);
    if (out.length >= PER_SECTION) break;
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (compatible; MogazBot/1.0; RSS reader)", accept: "application/rss+xml, application/xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

async function aiEnrich(sections) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const list = [];
  sections.forEach((s) => s.items.slice(0, 5).forEach((it) => list.push({ id: list.length, sec: s.title, it })));
  const prompt =
    "هذه عناوين أخبار اليوم من مصادر عربية. اعتمد على العناوين فقط ولا تضف أي واقعة أو رقم غير موجود فيها. " +
    "أخرج JSON فقط بهذا الشكل: {\"minute\":[\"...\"],\"impacts\":{\"رقم الخبر\":\"...\"}}. " +
    "minute: من 3 إلى 4 جمل قصيرة محايدة تلخص أهم ما في اليوم. " +
    "impacts: لأهم 8 أخبار على الأكثر، جملة واحدة تشرح لماذا يهم الخبر فرداً أو مستثمراً في مصر، بدون توصية شراء أو بيع وبدون رأي سياسي.\n\n" +
    list.map((x) => `${x.id} [${x.sec}] ${x.it.title} (${x.it.source})`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "claude-haiku-5-5",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error("AI HTTP " + res.status);
    const j = await res.json();
    const text = (j.content || []).map((c) => c.text || "").join("");
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    for (const [id, imp] of Object.entries(parsed.impacts || {})) {
      const x = list[+id];
      if (x && typeof imp === "string") x.it.impact = imp.slice(0, 300);
    }
    return Array.isArray(parsed.minute) ? parsed.minute.filter((m) => typeof m === "string").slice(0, 4) : null;
  } catch (e) {
    console.warn("AI skipped:", e.message);
    return null;
  }
}

async function main() {
  const cfg = JSON.parse(await readFile(new URL("feeds.json", ROOT), "utf8"));
  const failed = [];
  const sections = [];
  const trusted = cfg.trusted || [];
  for (const s of cfg.sections) {
    const results = await Promise.all(
      s.feeds.map(async (f) => {
        try {
          let items = parseFeed(await fetchText(f.url), f.name);
          if (!items.length) throw new Error("no items");
          if (!f.name && trusted.length) items = items.filter((i) => trusted.some((t) => i.source.includes(t)));
          return items;
        } catch (e) {
          failed.push({ section: s.id, feed: f.name || new URL(f.url).hostname, error: String(e.message || e) });
          return [];
        }
      })
    );
    const items = pick(results.flat());
    console.log(`${s.id}: ${items.length} items from ${new Set(items.map((i) => i.source)).size} sources`);
    sections.push({ id: s.id, title: s.title, items });
  }
  if (failed.length) console.warn("Failed feeds:", JSON.stringify(failed, null, 1));

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (total < 8) {
    // لا نستبدل بيانات جيدة ببيانات شبه فارغة
    console.error(`Only ${total} items collected; keeping previous data.json.`);
    process.exit(1);
  }
  const minute = await aiEnrich(sections);
  const data = { updated: new Date().toISOString(), minute: minute || [], sections, failed };
  await writeFile(new URL("data.json", ROOT), JSON.stringify(data, null, 1) + "\n");
  console.log(`Wrote data.json with ${total} items.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
