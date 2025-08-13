import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const KEEPA_KEY = process.env.KEEPA_KEY;
const ARB_KEY = process.env.ARB_KEY;
const US = 1; // Keepa domain ID for Amazon.com

// --- Middleware to require API key ---
function requireKey(req, res, next) {
  const key = req.header("X-ARBSCOUT-KEY");
  if (!key || key !== ARB_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Keepa Product Finder ---
async function keepaProductFinder({
  minDropsPerMonth = 0,
  maxRank = 500000,
  minBuyBox = 5,
  maxResults = 100
}) {
  const finder = {
    drops: { min: minDropsPerMonth },
    salesRank: { max: maxRank },
    buyBox: { min: minBuyBox * 100 },
    current_SALES: true
  };

  const url = `https://api.keepa.com/query?key=${KEEPA_KEY}&domain=${US}&selection=${encodeURIComponent(
    JSON.stringify(finder)
  )}&page=0&perPage=${maxResults}`;

  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa finder error: ${JSON.stringify(j.error)}`);

  console.log("[finder] selection:", finder, "returned asins:", j.asins?.length || 0);
  return j.asins || [];
}

// --- Keepa Product Lookup ---
async function keepaGetProducts(asins) {
  if (!asins.length) return [];
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${US}&asin=${asins.join(",")}&stats=90`;
  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa product error: ${JSON.stringify(j.error)}`);
  return j.products || [];
}

// --- Fee Estimator ---
function estimateFbaFee({ lengthCm, widthCm, heightCm, weightGrams, price }) {
  const referral = price * 0.15;
  const fba = 3.5;
  const storageEst = 0.5;
  return { referral, fba, storageEst };
}

// --- Scoring ---
function scoreDeal({ roi, profit, dropsPerMonth, priceVol, nearbyOffers, reviewOk, matchOk }) {
  let score = 0;
  if (roi > 0.3) score += 30;
  if (profit > 5) score += 25;
  if (dropsPerMonth > 5) score += 20;
  if (priceVol < 0.15) score += 10;
  if ((nearbyOffers ?? 99) < 5) score += 10;
  if (reviewOk) score += 5;
  if (!matchOk) score -= 20;
  return score;
}

function decide({ roi, profit, nearbyOffers }) {
  if (roi > 0.3 && profit > 5 && (nearbyOffers ?? 99) < 5) return "BUY";
  if (roi > 0.15 && profit > 3) return "WATCH";
  return "PASS";
}

// --- Convert product to deal object ---
function productToDeal(p) {
  const asin = p.asin;
  const title = p.title;

  const buyBoxFromHist = Array.isArray(p.buyBoxPriceHistory) && p.buyBoxPriceHistory.length
    ? p.buyBoxPriceHistory[p.buyBoxPriceHistory.length - 1] / 100
    : null;
  const bbStat = (p.stats?.buyBoxPrice ?? 0) / 100;
  const bb = buyBoxFromHist || bbStat || (p.stats?.current_BUYBOX ?? 0) / 100 || (p.stats?.current_NEW ?? 0) / 100;

  if (!bb || !Number.isFinite(bb) || bb <= 0) {
    return {
      asin, title,
      retailer: "TBD",
      buyPrice: 0, salePrice: 0, profitPerUnit: 0, roiPct: 0,
      velocity: { bsr: null, dropsPerMonth: null },
      competitionNearby: null,
      risks: ["No price data"], score: 0, decision: "WATCH",
      links: { keepaProduct: `https://keepa.com/#!product/US/${asin}`, amazonDetailPage: `https://www.amazon.com/dp/${asin}` }
    };
  }

  const rating = p.stats?.rating;
  const reviewCount = p.stats?.reviewCount;
  const bsr = p.stats?.current_SALES ?? null;
  const dropsPerMonth = p.stats?.drops90 ? Math.round(p.stats.drops90 / 3) : (p.stats?.drops30 ?? null);
  const priceVol = p.stats?.priceVariance ?? 0.12;

  const dims = {
    lengthCm: p.itemLength ? p.itemLength / 10 : 20,
    widthCm: p.itemWidth ? p.itemWidth / 10 : 10,
    heightCm: p.itemHeight ? p.itemHeight / 10 : 5,
    weightGrams: p.itemWeight ? p.itemWeight : 300
  };
  const fees = estimateFbaFee({ ...dims, price: bb });

  const buyPrice = Math.max(3, Math.round(bb * 0.35 * 100) / 100);
  const landed = buyPrice + 0.5 + 0.5;
  const profit = bb - (fees.referral + fees.fba + fees.storageEst) - landed;
  const roi = landed > 0 ? profit / landed : 0;

  const nearbyOffers = p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA;
  const reviewOk = (rating ?? 0) >= 4 && (reviewCount ?? 0) >= 20;

  const score = scoreDeal({ roi, profit, dropsPerMonth, priceVol, nearbyOffers, reviewOk, matchOk: true });
  const decision = decide({ roi, profit, nearbyOffers });

  return {
    asin, title,
    retailer: "TBD",
    buyPrice, salePrice: bb,
    profitPerUnit: Math.round(profit * 100) / 100,
    roiPct: Math.round(roi * 10000) / 100,
    velocity: { bsr, dropsPerMonth },
    competitionNearby: nearbyOffers ?? null,
    risks: [],
    score, decision,
    links: {
      keepaProduct: `https://keepa.com/#!product/US/${asin}`,
      amazonDetailPage: `https://www.amazon.com/dp/${asin}`
    }
  };
}

// --- Routes ---
app.get("/healthz", (req, res) => res.send("ok"));

app.get("/deals/today", requireKey, async (req, res) => {
  try {
    const minScore = Number(req.query.minScore ?? 0);
    const decisionFilter = req.query.decision;

    const asins = await keepaProductFinder({
      minDropsPerMonth: 0,
      maxRank: 500000,
      minBuyBox: 5,
      maxResults: 100
    });

    const products = await keepaGetProducts(asins.slice(0, 80));
    const deals = products.map(productToDeal)
      .filter(d => (decisionFilter ? d.decision === decisionFilter : true))
      .filter(d => Number.isFinite(d.score))
      .sort((a, b) => b.score - a.score);

    res.json({
      generatedAt: new Date().toISOString(),
      deals: deals.filter(d => d.score >= minScore)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
