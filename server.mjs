import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const KEEPA_KEY = process.env.KEEPA_KEY;
const ARB_KEY = process.env.ARB_KEY; // must match the key you set in your GPT Action

if (!KEEPA_KEY) { console.error("Missing KEEPA_KEY env var"); process.exit(1); }
if (!ARB_KEY) { console.error("Missing ARB_KEY env var"); process.exit(1); }

const US = 1;
const round2 = n => Math.round(n * 100) / 100;

function estimateFbaFee({ lengthCm, widthCm, heightCm, weightGrams, price }) {
  const referral = price * 0.15;
  const sizeSurcharge = (lengthCm * widthCm * heightCm) / 5000 > 1 ? 1.0 : 0.5;
  const weightKg = weightGrams ? weightGrams / 1000 : 0.3;
  const fba = 3.5 + sizeSurcharge + Math.max(0, weightKg - 0.3) * 0.6;
  const storage = 0.15;
  return { referral: round2(referral), fba: round2(fba), storageEst: round2(storage) };
}

function scoreDeal({ roi, profit, dropsPerMonth, priceVol, nearbyOffers, reviewOk, matchOk }) {
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const roiNorm = clamp01(roi / 0.5);
  const profitNorm = clamp01(profit / 10);
  const velocity = clamp01((dropsPerMonth || 0) / 25);
  const stability = 1 - clamp01((priceVol || 0) / 0.25);
  const comp = 1 - clamp01((nearbyOffers || 0) / 10);
  const review = reviewOk ? 1 : 0;
  const match = matchOk ? 1 : 0;

  return Math.round(100 * (
    roiNorm * 0.25 +
    profitNorm * 0.20 +
    velocity * 0.15 +
    stability * 0.10 +
    comp * 0.10 +
    match * 0.05 +
    review * 0.05 +
    0.10
  ));
}

function decide({ roi, profit, nearbyOffers, gated = false }) {
  if (gated) return "PASS";
  if (roi >= 0.30 && profit >= 4 && (nearbyOffers ?? 0) <= 6) return "BUY";
  return "WATCH";
}

async function keepaProductFinder({ minDropsPerMonth = 12, maxRank = 120000, minBuyBox = 16, maxResults = 40 }) {
  const finder = {
    drops: { min: minDropsPerMonth },
    buyBox: { min: minBuyBox * 100 },
    salesRank: { max: maxRank },
    current_SALES: true
  };
  const url = `https://api.keepa.com/query?key=${KEEPA_KEY}&domain=${US}&selection=${encodeURIComponent(JSON.stringify(finder))}&page=0&perPage=${maxResults}`;
  const j = await fetch(url, { timeout: 25000 }).then(r => r.json());
  if (j.error) throw new Error(`Keepa finder error: ${JSON.stringify(j.error)}`);
  return j.asins || [];
}

async function keepaGetProducts(asins) {
  if (!asins.length) return [];
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${US}&asin=${asins.join(",")}&stats=180&offers=20&rating=1&history=1&buybox=1`;
  const j = await fetch(url, { timeout: 25000 }).then(r => r.json());
  if (j.error) throw new Error(`Keepa product error: ${JSON.stringify(j.error)}`);
  return j.products || [];
}

function productToDeal(p) {
  const asin = p.asin;
  const title = p.title;
  const rating = p.stats?.rating;
  const reviewCount = p.stats?.reviewCount;
  const bb = (p.buyBoxPriceHistory?.slice(-1)[0] ?? p.stats?.buyBoxPrice ?? 0) / 100;
  const bsr = p.stats?.current_SALES ?? null;
  const dropsPerMonth = p.stats?.drops90 ? Math.round((p.stats.drops90) / 3) : (p.stats?.drops30 ?? null);
  const priceVol = p.stats?.priceVariance ?? 0.12;

  const dims = {
    lengthCm: p.itemLength ? p.itemLength / 10 : 20,
    widthCm: p.itemWidth ? p.itemWidth / 10 : 10,
    heightCm: p.itemHeight ? p.itemHeight / 10 : 5,
    weightGrams: p.itemWeight ? p.itemWeight : 300
  };
  const fees = estimateFbaFee({ ...dims, price: bb });
  const buyPrice = Math.max(5, round2(bb * 0.35)); // TODO: replace with real retailer price
  const landed = buyPrice + 0.5 + 0.5;
  const profit = bb - (fees.referral + fees.fba + fees.storageEst) - landed;
  const roi = landed > 0 ? profit / landed : 0;

  const nearbyOffers = p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA;
  const reviewOk = (rating ?? 0) >= 4.0 && (reviewCount ?? 0) >= 50;

  const score = scoreDeal({ roi, profit, dropsPerMonth, priceVol, nearbyOffers, reviewOk, matchOk: true });
  const decision = decide({ roi, profit, nearbyOffers });

  return {
    asin,
    title,
    retailer: "TBD",
    buyPrice: round2(buyPrice),
    salePrice: round2(bb),
    profitPerUnit: round2(profit),
    roiPct: round2(roi * 100),
    velocity: { bsr, dropsPerMonth },
    competitionNearby: nearbyOffers ?? null,
    risks: [],
    score,
    decision,
    links: {
      keepaProduct: `https://keepa.com/#!product/US/${asin}`,
      amazonDetailPage: `https://www.amazon.com/dp/${asin}`
    }
  };
}

function requireKey(req, res, next) {
  if (req.header("X-ARBSCOUT-KEY") !== ARB_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/deals/today", requireKey, async (req, res) => {
  try {
    const minScore = Number(req.query.minScore ?? 70);
    const decisionFilter = req.query.decision;
    const asins = await keepaProductFinder({});
    const products = await keepaGetProducts(asins.slice(0, 40));
    const deals = products.map(productToDeal)
      .filter(d => d.score >= minScore)
      .filter(d => (decisionFilter ? d.decision === decisionFilter : true))
      .sort((a, b) => b.score - a.score);

    res.json({ generatedAt: new Date().toISOString(), deals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/arbitrage/score", requireKey, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing 'query' (ASIN/UPC/EAN)" });
    const products = await keepaGetProducts([query]);
    if (!products.length) return res.json({ decision: "PASS", score: 0, riskNotes: ["No Keepa product found"] });
    const deal = productToDeal(products[0]);
    res.json(deal);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`Arb backend listening on ${PORT}`));
