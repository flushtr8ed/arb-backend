// server.mjs — FBA-filtered deals + on-demand scorer

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const KEEPA_KEY = process.env.KEEPA_KEY;
const ARB_KEY = process.env.ARB_KEY;
const US = 1; // Amazon.com (US)

// --- Simple auth for your GPT Action (header: X-ARBSCOUT-KEY) ---
function requireKey(req, res, next) {
  const key = req.header("X-ARBSCOUT-KEY");
  if (!key || key !== ARB_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// --- Keepa Product Finder (broad; we filter post-fetch) ---
async function keepaProductFinder({ perPage = 100 } = {}) {
  const selection = {
    productType: 0,      // all products
    current_SALES: true  // must have a current rank
  };
  const url = `https://api.keepa.com/query?key=${KEEPA_KEY}&domain=${US}&selection=${encodeURIComponent(
    JSON.stringify(selection)
  )}&page=0&perPage=${perPage}`;

  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa finder error: ${JSON.stringify(j.error)}`);

  if (Array.isArray(j.asins)) return j.asins;
  if (Array.isArray(j.products)) return j.products.map(p => p.asin).filter(Boolean);
  return [];
}

// --- Keepa product lookup (with offers/stats so we can check FBA) ---
async function keepaGetProducts(asins) {
  if (!asins.length) return [];
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${US}&asin=${asins.join(
    ","
  )}&stats=90&offers=20&rating=1&history=0&buybox=1`;
  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa product error: ${JSON.stringify(j.error)}`);
  return j.products || [];
}

// --- Very light fee model (until you wire SP-API) ---
function estimateFbaFee(price) {
  const referral = price * 0.15;
  const fba = 3.5;
  const storageEst = 0.3;
  return { referral, fba, storageEst };
}

// --- Scoring + decision (loose for testing) ---
function scoreDeal({ roi, profit, dropsPerMonth, nearbyOffers, reviewOk }) {
  let s = 0;
  if (roi > 0.30) s += 30;
  if (profit > 5) s += 25;
  if ((dropsPerMonth || 0) > 5) s += 20;
  if ((nearbyOffers ?? 99) < 5) s += 15;
  if (reviewOk) s += 10;
  return s;
}
function decide({ roi, profit, nearbyOffers }) {
  if (roi > 0.30 && profit > 5 && (nearbyOffers ?? 99) < 5) return "BUY";
  if (roi > 0.15 && profit > 3) return "WATCH";
  return "PASS";
}

function linksFor(asin) {
  return {
    keepaProduct: `https://keepa.com/#!product/US/${asin}`,
    amazonDetailPage: `https://www.amazon.com/dp/${asin}`
  };
}

// --- Convert Keepa product -> deal row (FBA-aware) ---
function productToDeal(p) {
  const asin = p.asin;
  const title = p.title;

  const offers = Array.isArray(p.offers) ? p.offers : [];
  const hasFbaOffer = offers.some(o => o && o.isFBA);
  const fbaWinsBuyBox = offers.some(o => o && o.isFBA && o.isBuyBoxWinner);
  const fbaCount = (p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA ?? offers.filter(o => o.isFBA).length) || null;

  const bbCents =
    (Array.isArray(p.buyBoxPriceHistory) && p.buyBoxPriceHistory.length
      ? p.buyBoxPriceHistory[p.buyBoxPriceHistory.length - 1]
      : p.stats?.buyBoxPrice) || 0;
  const newCents = p.stats?.current_NEW || 0;
  const salePrice = (bbCents || newCents) / 100;
  if (!salePrice || !Number.isFinite(salePrice) || salePrice <= 0) {
    return { asin, title, score: 0, decision: "PASS", risks: ["No price data"], links: linksFor(asin) };
  }

  const rating = p.stats?.rating ?? 0;           // Keepa rating 0–50 (≈ stars*10)
  const reviewCount = p.stats?.reviewCount ?? 0;
  const reviewOk = rating >= 40 && reviewCount >= 20;

  const dropsPerMonth = p.stats?.drops90 ? Math.round(p.stats.drops90 / 3) : p.stats?.drops30 ?? null;

  // TEMP buy cost assumption (replace with retailer feed later)
  const buyPrice = Math.max(3, Number((salePrice * 0.35).toFixed(2)));
  const { referral, fba, storageEst } = estimateFbaFee(salePrice);
  const landed = buyPrice + 0.5 + 0.5;
  const profit = salePrice - (referral + fba + storageEst) - landed;
  const roi = landed > 0 ? profit / landed : 0;

  const score = scoreDeal({ roi, profit, dropsPerMonth, nearbyOffers: fbaCount ?? undefined, reviewOk });
  const decision = decide({ roi, profit, nearbyOffers: fbaCount ?? undefined });

  return {
    asin,
    title,
    retailer: "TBD",
    salePrice: Number(salePrice.toFixed(2)),
    buyPrice: Number(buyPrice.toFixed(2)),
    profitPerUnit: Number(profit.toFixed(2)),
    roiPct: Number((roi * 100).toFixed(2)),
    fba: { hasFbaOffer, fbaWinsBuyBox, fbaOfferCount: fbaCount },
    velocity: { dropsPerMonth, bsr: p.stats?.current_SALES ?? null },
    rating: Number((rating / 10).toFixed(1)),
    reviewCount,
    score,
    decision,
    risks: [],
    links: linksFor(asin)
  };
}

// --- Health check ---
app.get("/healthz", (_req, res) => res.send("ok"));

// --- Deals endpoint (FBA-filtered) ---
app.get("/deals/today", requireKey, async (req, res) => {
  try {
    const minScore = Number(req.query.minScore ?? 0);
    const decisionFilter = req.query.decision; // BUY/WATCH/PASS

    // 1) Broad candidates
    let asins = await keepaProductFinder({ perPage: 120 });
    console.log("[finder] ASINs:", asins.length);

    if (!asins.length) {
      console.warn("[finder] empty; using fallback ASINs");
      asins = ["B07FZ8S74R", "B08N5WRWNW", "B07PGL2ZSL", "B0BQLQ5ZDM", "B08CFSZLQ4", "B07W7QTMF4"];
    }

    // 2) Fetch details + filter to FBA + reasonable price band
    const products = await keepaGetProducts(asins.slice(0, 80));
    console.log("[product] fetched:", products.length);

    const fbaEligible = products.filter(p => {
      const hasFba =
        (p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA ?? 0) > 0 ||
        (Array.isArray(p.offers) && p.offers.some(o => o && o.isFBA));
      const bb = (Array.isArray(p.buyBoxPriceHistory) && p.buyBoxPriceHistory.length
        ? p.buyBoxPriceHistory[p.buyBoxPriceHistory.length - 1]
        : p.stats?.buyBoxPrice) || 0;
      const newPrice = p.stats?.current_NEW || 0;
      const price = (bb || newPrice) / 100;
      return hasFba && price >= 10 && price <= 80;
    });

    // 3) Build deals + apply filters
    const dealsAll = fbaEligible.map(productToDeal).sort((a, b) => b.score - a.score);
    const deals = dealsAll
      .filter(d => (decisionFilter ? d.decision === decisionFilter : true))
      .filter(d => d.score >= minScore);

    res.json({ generatedAt: new Date().toISOString(), deals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- NEW: on-demand scorer (POST /arbitrage/score) ---
app.post("/arbitrage/score", requireKey, async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: "Missing 'query' (ASIN/UPC/EAN)" });

    // For now, treat it as an ASIN; you can add Keepa's search later.
    const asin = String(query).trim().toUpperCase();
    const products = await keepaGetProducts([asin]);
    if (!products.length) return res.status(404).json({ error: `No Keepa product found for ${asin}` });

    const deal = productToDeal(products[0]);
    res.json(deal);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Start server ---
app.listen(PORT, () => console.log(`Arb backend running on ${PORT}`));

