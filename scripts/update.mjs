// يجمع العناوين من خلاصات RSS في feeds.json ويكتب data.json. بدون أي مكتبات خارجية (Node 20+).
// اختياري: لو وُجد مفتاح Gemini يضيف «في دقيقة» و«ماذا يعني لك» لأهم الأخبار.
import { readFile, writeFile } from "node:fs/promises";
import { fetchMarkets } from "./markets.mjs";

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

const AR_MONTHS = { "يناير": 0, "فبراير": 1, "مارس": 2, "أبريل": 3, "ابريل": 3, "مايو": 4, "يونيو": 5, "يوليو": 6, "أغسطس": 7, "اغسطس": 7, "سبتمبر": 8, "أكتوبر": 9, "اكتوبر": 9, "نوفمبر": 10, "ديسمبر": 11 };
const toLatinDigits = (s) => s.replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x660);
// فرق توقيت القاهرة عن UTC في لحظة معينة (يراعي التوقيت الصيفي)
function cairoOffsetMs(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(utcMs)).map((p) => [p.type, +p.value]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}
// يقبل الصيغ القياسية، وصيغة مثل «السبت، 14 نوفمبر 2026 02:19 م» على أنها بتوقيت القاهرة
export function parseDate(raw = "") {
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return t;
  const m = toLatinDigits(raw).match(/(\d{1,2})\s+([\u0600-\u06FF]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([صم])?/);
  if (!m || AR_MONTHS[m[2]] === undefined) return NaN;
  let h = +m[4] % 12;
  if (m[7] === "م") h += 12;
  if (!m[7]) h = +m[4];
  const asUtc = Date.UTC(+m[3], AR_MONTHS[m[2]], +m[1], h, +m[5], +(m[6] || 0));
  return asUtc - cairoOffsetMs(asUtc);
}

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
    const t = parseDate(dateRaw);
    // بنج يضع الرابط الحقيقي داخل معامل url في رابط إعادة التوجيه
    if (/bing\.com\/news\/apiclick/i.test(url)) {
      try { const real = new URL(url).searchParams.get("url"); if (real) url = real; } catch {}
    }
    // المصدر المسمّى في feeds.json له الأولوية؛ وإلا وسم <source> (جوجل) أو <News:Source> (بنج)
    let source = fallbackName || decode(tag(b, "source")) || decode(tag(b, "News:Source")).replace(/\s+on MSN$/i, "");
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
  let status = 0;
  for (const accept of ["application/rss+xml, application/xml, text/xml, */*", "*/*"]) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; MogazBot/1.0; RSS reader)", accept },
    });
    if (res.ok) return res.text();
    status = res.status;
  }
  throw new Error("HTTP " + status);
}

// ---------- الذكاء الاصطناعي (Gemini) ----------
// المفاتيح من أسرار GitHub: GEMINI_API_KEY و GEMINI_API_KEY_2 (الثاني احتياطي عند نفاد الحصة).
// النموذج: GEMINI_MODEL إن وُجد، وإلا يجرّب القائمة بالترتيب حتى يجد نموذجاً متاحاً.
const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"];
const AI_MIN_GAP_MIN = 20; // أقل فاصل بين طلبين للذكاء الاصطناعي، لتوفير الحصة المجانية

export function buildPrompt(list) {
  return (
    "هذه عناوين أخبار من مصادر عربية في آخر ساعات. اعتمد على العناوين فقط، ولا تضف أي واقعة أو رقم أو اسم غير موجود فيها. " +
    'أخرج JSON فقط بهذا الشكل: {"minute":["..."],"impacts":{"رقم الخبر":"..."}}. ' +
    "minute: من 3 إلى 4 جمل قصيرة ومحايدة بالعربية البسيطة تلخص أهم ما في الأخبار. " +
    "impacts: لأهم 10 أخبار على الأكثر، جملة واحدة تشرح لماذا يهم الخبر فرداً أو مستثمراً في مصر، بدون توصية شراء أو بيع، وبدون رأي سياسي، وبدون تأكيد اتهام غير منسوب لمصدره.\n\n" +
    list.map((x) => `${x.id} [${x.sec}] ${x.it.title} (${x.it.source})`).join("\n")
  );
}

export function parseAI(text, list) {
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  let n = 0;
  for (const [id, imp] of Object.entries(parsed.impacts || {})) {
    const x = list[+id];
    if (x && typeof imp === "string" && imp.trim()) { x.it.impact = imp.trim().slice(0, 300); n++; }
  }
  const minute = Array.isArray(parsed.minute) ? parsed.minute.filter((m) => typeof m === "string" && m.trim()).slice(0, 4) : [];
  return { minute, n };
}

async function callGemini(prompt) {
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (!keys.length) return { error: "no keys" };
  const models = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : DEFAULT_MODELS;
  const errors = [];
  for (const model of models) {
    for (let k = 0; k < keys.length; k++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          signal: AbortSignal.timeout(60000),
          headers: { "content-type": "application/json", "x-goog-api-key": keys[k] },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 2500 },
          }),
        });
        if (res.ok) {
          const j = await res.json();
          const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
          if (!text) throw new Error("empty response");
          return { text, model, key: k + 1 };
        }
        errors.push(`${model} key${k + 1}: HTTP ${res.status}`);
        if (res.status === 404 || res.status === 400) break; // النموذج غير متاح: جرّب النموذج التالي
        // 429 (حصة) أو 401/403 (مفتاح): جرّب المفتاح التالي
      } catch (e) {
        errors.push(`${model} key${k + 1}: ${e.message}`);
      }
    }
  }
  return { error: errors.join("; ") };
}

async function main() {
  const cfg = JSON.parse(await readFile(new URL("feeds.json", ROOT), "utf8"));
  let prev = {};
  try { prev = JSON.parse(await readFile(new URL("data.json", ROOT), "utf8")); } catch {}
  const prevByUrl = new Map();
  // الخبر نفسه قد يظهر في أكثر من قسم: نحتفظ بأقدم seen وبأي impact موجود
  (prev.sections || []).forEach((s) =>
    (s.items || []).forEach((i) => {
      const o = prevByUrl.get(i.url);
      if (!o) return prevByUrl.set(i.url, { ...i });
      if (i.impact && !o.impact) o.impact = i.impact;
      if (i.seen && (!o.seen || i.seen < o.seen)) o.seen = i.seen;
    })
  );

  const failed = [];
  const sections = [];
  const trusted = cfg.trusted || [];
  const nowIso = new Date().toISOString();
  const usedUrls = new Set(); // الخبر يظهر في أول قسم فقط
  const excludeRe = cfg.exclude?.length ? new RegExp(cfg.exclude.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")) : null;
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
    // أخبار التشغيل السابق لنفس القسم تدخل كمرشحين، فلا يفرغ القسم لو تعطّل مصدر مؤقتاً
    const carried = (prev.sections || []).find((p) => p.id === s.id)?.items || [];
    const fetchedUrls = new Set(results.flat().map((i) => i.url));
    const pool = [...results.flat(), ...carried.filter((i) => !fetchedUrls.has(i.url))]
      .filter((i) => !usedUrls.has(i.url) && !(excludeRe && excludeRe.test(i.title)));
    const items = pick(pool).map((i) => {
      usedUrls.add(i.url);
      const old = prevByUrl.get(i.url);
      // seen: أول مرة ظهر فيها الخبر عندنا (لعلامة «جديد»). impact: يُحتفظ به من التشغيل السابق.
      return { ...i, seen: old?.seen || nowIso, ...(old?.impact ? { impact: old.impact } : {}) };
    });
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

  let minute = prev.minute || [];
  let ai = prev.ai || null;
  const list = [];
  sections.forEach((s) => s.items.slice(0, 5).forEach((it) => list.push({ id: list.length, sec: s.title, it })));
  const needs = list.some((x) => !x.it.impact);
  const lastAt = ai?.at ? Date.parse(ai.at) : 0;
  const due = Date.now() - lastAt > AI_MIN_GAP_MIN * 60e3;
  if (needs && due && (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2)) {
    const r = await callGemini(buildPrompt(list));
    if (r.text) {
      try {
        const out = parseAI(r.text, list);
        if (out.minute.length) minute = out.minute;
        ai = { at: nowIso, model: r.model, key: r.key, impacts: out.n };
        console.log(`AI ok: ${r.model} (key ${r.key}), ${out.n} impacts`);
      } catch (e) {
        ai = { ...(ai || {}), error: "bad JSON: " + e.message, errorAt: nowIso };
        console.warn("AI parse failed:", e.message);
      }
    } else {
      ai = { ...(ai || {}), error: r.error, errorAt: nowIso };
      console.warn("AI failed:", r.error);
    }
  } else {
    console.log(`AI skipped (new items: ${needs}, gap ok: ${due})`);
  }

  const { markets, errors: marketErrors } = await fetchMarkets(prev.markets || []);
  if (marketErrors.length) console.warn("Market errors:", marketErrors.join("; "));
  console.log(`Markets: ${markets.filter((m) => !m.stale).length} fresh, ${markets.filter((m) => m.stale).length} stale`);
  let indicators = [];
  try { indicators = JSON.parse(await readFile(new URL("indicators.json", ROOT), "utf8")).items || []; } catch {}

  const data = { updated: nowIso, minute, ai, markets, indicators, sections, failed, marketErrors };
  await writeFile(new URL("data.json", ROOT), JSON.stringify(data, null, 1) + "\n");
  console.log(`Wrote data.json with ${total} items.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
