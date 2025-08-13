import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const KEEPA_KEY = process.env.KEEPA_KEY;
const ARB_KEY = process.env.ARB_KEY;
const US = 1; // Amazon.com

if (!KEEPA_KEY) console.error("WARNING: KEEPA_KEY not set");
if (!ARB_KEY) console.error("WARNING: ARB_KEY not set");

// -------- Auth middleware (GPT Action header) --------
function requireKey(req, res, next) {
  const key = req.header("X-ARBSCOUT-KEY");
  if (!key || key !== ARB_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// -------- Keepa Product Finder (very loose for testing) --------
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

// -------- Keepa product lookup --------
async function keepaGetProducts(asins) {
  if (!asins.length) return [];
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${US}&asin=${asins.join(",")}&stats=90&buybox=1&rating=1`;
  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa product error: ${JSON.stringify(j.error)}`);
  return j.products || [];
}

// -------- Very simple fee estimate (placeholder) --------
function estimateFbaFee({ price }) {
  const referral = price * 0.15;
  const fba = 3.5;
  const storageEst = 0.3;
  return { referral, fba, storageEst };
}

// -------- Scoring + decision (loose for testing) --------
function scoreDeal({ roi, profit, dropsPerMonth, nearbyOffers, reviewOk }) {
  let score = 0;
  if (roi > 0.30) score += 30;
  if (profit > 5) score += 25;
  if ((dropsPerMonth || 0) > 5) score += 20;
  if ((nearbyOffers ?? 99) < 5) score += 15;
  if (reviewOk) score += 10;
  return score;
}
function decide({ roi, profit, nearbyOffers }) {
  if (roi > 0.30 && profit > 5 && (nearbyOffers ?? 99) < 5) return "BUY";
  if (roi > 0.15 && profit > 3) return "WATCH";
  return "PASS";
}

// -------- Transform Keepa product -> deal row --------
function productToDeal(p) {
  const asin = p.asin;
  const title = p.title;

  // sale price from buy box or stats
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

  const { referral, fba, storageEst } = estimateFbaFee({ price: bb });

  // TEMP buy price assumption until retailer feeds are added
  const buyPrice = Math.max(3, Math.round(bb * 0.35 * 100) / 100);
  const landed = buyPrice + 0.5 + 0.5;
  const profit = bb - (referral + fba + storageEst) - landed;
  const roi = landed > 0 ? profit / landed : 0;

  const nearbyOffers = p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA;
  const reviewOk = (rating ?? 0) >= 4 && (reviewCount ?? 0) >= 20;

  const score = scoreDeal({ roi, profit, dropsPerMonth, nearbyOffers, reviewOk });
  const decision = decide({ roi, profit, nearbyOffers });

  return {
    asin, title,
    retailer: "TBD",
    buyPrice: Number(buyPrice.toFixed(2)),
    salePrice: Number(bb.toFixed(2)),
    profitPerUnit: Number(profit.toFixed(2)),
    roiPct: Number((roi * 100).toFixed(2)),
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

// -------- Routes --------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/deals/today", requireKey, async (req, res) => {
  try {
    const minScore = Number(req.query.minScore ?? 0);
    const decisionFilter = req.query.decision;

    // 1) Try finder
    let asins = await keepaProductFinder({
      minDropsPerMonth: 0,
      maxRank: 500000,
      minBuyBox: 5,
      maxResults: 100
    });

    console.log("[/deals/today] finder returned", asins.length, "ASINs");

    // 2) Fallback if finder is empty (ensures you see rows)
    if (!asins || asins.length === 0) {
      console.warn("[/deals/today] using fallback ASINs");
      asins = [
        "B07FZ8S74R", // Fire TV Stick 4K
        "B08N5WRWNW", // Echo Dot (4th Gen)
        "B07PGL2ZSL", // Apple AirPods 2
        "B0BQLQ5ZDM", // Anker Charger
        "B08CFSZLQ4", // Samsung 980 SSD
        "B07W7QTMF4"  // Logitech MX Master 3
      ];
    }

    // 3) Get product details and build deals
    const products = await keepaGetProducts(asins.slice(0, 30));
    console.log("[/deals/today] keepaGetProducts returned", products.length, "products");

    const dealsAll = products.map(productToDeal)
      .filter(d => Number.isFinite(d.score))
      .sort((a, b) => b.score - a.score);

    const deals = dealsAll
      .filter(d => (decisionFilter ? d.decision === decisionFilter : true))
      .filter(d => d.score >= minScore);

    res.json({ generatedAt: new Date().toISOString(), deals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// -------- Start --------
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
