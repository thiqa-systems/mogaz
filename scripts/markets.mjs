// أسعار الأسواق: مصادر مجانية بدون مفاتيح. كل رقم مستقل؛ لو فشل مصدر نحتفظ بآخر قيمة ناجحة مع وقتها.
const UA = { "user-agent": "Mozilla/5.0 (compatible; MogazBot/1.0)", accept: "application/json" };
const OZ = 31.1034768; // جرام في الأونصة

async function getJSON(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ياهو فاينانس (غير رسمي): السعر الحالي وإغلاق اليوم السابق
async function yahoo(symbol) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const r = j.chart?.result?.[0];
  if (!r) throw new Error("no result");
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((x) => typeof x === "number");
  const price = r.meta?.regularMarketPrice ?? closes.at(-1);
  const prev = closes.length >= 2 ? closes.at(-2) : r.meta?.chartPreviousClose;
  if (typeof price !== "number") throw new Error("no price");
  const t = r.meta?.regularMarketTime ? new Date(r.meta.regularMarketTime * 1000).toISOString() : new Date().toISOString();
  return { price, prev: typeof prev === "number" ? prev : null, asOf: t, source: "Yahoo Finance" };
}

// بدائل احتياطية
const fallbacks = {
  gold: async () => {
    const j = await getJSON("https://api.gold-api.com/price/XAU");
    return { price: j.price, prev: null, asOf: j.updatedAt || new Date().toISOString(), source: "gold-api.com" };
  },
  usdegp: async () => {
    const j = await getJSON("https://open.er-api.com/v6/latest/USD");
    if (!j.rates?.EGP) throw new Error("no EGP");
    return { price: j.rates.EGP, prev: null, asOf: new Date(j.time_last_update_unix * 1000).toISOString(), source: "ExchangeRate-API" };
  },
  btc: async () => {
    const j = await getJSON("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
    const p = j.bitcoin?.usd, c = j.bitcoin?.usd_24h_change;
    return { price: p, prev: typeof c === "number" ? p / (1 + c / 100) : null, asOf: new Date().toISOString(), source: "CoinGecko" };
  },
};

// الترتيب هنا هو ترتيب الظهور في التطبيق
export const ITEMS = [
  { id: "usdegp", name: "الدولار / جنيه", yahoo: "EGP=X", unit: "ج.م", digits: 2 },
  { id: "gold21", name: "ذهب عيار 21 (تقديري)", derived: true, unit: "ج.م/جرام", digits: 0 },
  { id: "gold24", name: "ذهب عيار 24 (تقديري)", derived: true, unit: "ج.م/جرام", digits: 0 },
  { id: "gold", name: "الذهب عالمياً", yahoo: "GC=F", unit: "$/أونصة", digits: 0 },
  { id: "egx30", name: "البورصة المصرية EGX30", yahoo: "^CASE30", unit: "نقطة", digits: 0 },
  { id: "eurusd", name: "اليورو / دولار", yahoo: "EURUSD=X", unit: "$", digits: 4 },
  { id: "brent", name: "خام برنت", yahoo: "BZ=F", unit: "$/برميل", digits: 2 },
  { id: "sp500", name: "S&P 500", yahoo: "^GSPC", unit: "نقطة", digits: 0 },
  { id: "btc", name: "بيتكوين", yahoo: "BTC-USD", unit: "$", digits: 0 },
];

const pct = (p, prev) => (typeof prev === "number" && prev ? ((p - prev) / prev) * 100 : null);

export async function fetchMarkets(prevList = []) {
  const prevById = new Map(prevList.map((m) => [m.id, m]));
  const raw = {};
  const errors = [];
  await Promise.all(
    ITEMS.filter((i) => !i.derived).map(async (it) => {
      try {
        raw[it.id] = await yahoo(it.yahoo);
      } catch (e) {
        if (fallbacks[it.id]) {
          try { raw[it.id] = await fallbacks[it.id](); return; } catch (e2) { errors.push(`${it.id}: ${e.message} / ${e2.message}`); return; }
        }
        errors.push(`${it.id}: ${e.message}`);
      }
    })
  );

  // الذهب المحلي = السعر العالمي ÷ جرامات الأونصة × النقاء × سعر الدولار (بدون مصنعية أو فرق سوق)
  if (raw.gold && raw.usdegp) {
    for (const [id, purity] of [["gold21", 0.875], ["gold24", 0.999]]) {
      const f = (x) => (x / OZ) * purity;
      const price = f(raw.gold.price) * raw.usdegp.price;
      const prev = raw.gold.prev && raw.usdegp.prev ? f(raw.gold.prev) * raw.usdegp.prev : null;
      raw[id] = { price, prev, asOf: raw.gold.asOf, source: "محسوب من سعر الذهب العالمي وسعر الدولار" };
    }
  }

  const out = ITEMS.map((it) => {
    const r = raw[it.id];
    if (r && typeof r.price === "number" && isFinite(r.price)) {
      return { id: it.id, name: it.name, unit: it.unit, value: +r.price.toFixed(it.digits), change: (c => c === null ? null : +c.toFixed(2))(pct(r.price, r.prev)), asOf: r.asOf, source: r.source };
    }
    const old = prevById.get(it.id);
    return old ? { ...old, stale: true } : null;
  }).filter(Boolean);
  return { markets: out, errors };
}
