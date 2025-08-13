// server.mjs — FBA-filtered deals (drop-in)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const KEEPA_KEY = process.env.KEEPA_KEY;
const ARB_KEY = process.env.ARB_KEY;
const US = 1; // Amazon.com

// ----- simple auth for your GPT Action -----
function requireKey(req, res, next) {
  const key = req.header("X-ARBSCOUT-KEY");
  if (!key || key !== ARB_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ----- Keepa Product Finder (very broad; we’ll filter post-fetch) -----
async function keepaProductFinder({ perPage = 80 } = {}) {
  // ultra-broad selection to guarantee ASINs; we filter for FBA later
  const selection = {
    productType: 0,          // all products
    current_SALES: true,     // has a current rank
    // keep it broad; we’ll constrain by FBA + price later
  };

  const url = `https://api.keepa.com/query?key=${KEEPA_KEY}&domain=${US}&selection=${encodeURIComponent(
    JSON.stringify(selection)
  )}&page=0&perPage=${perPage}`;

  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa finder error: ${JSON.stringify(j.error)}`);
  // Newer Keepa responses may return just ASINs; normalize to array of ASINs
  if (Array.isArray(j.asins)) return j.asins;
  if (Array.isArray(j.products)) return j.products.map(p => p.asin).filter(Boolean);
  return [];
}

// ----- Keepa product lookup with offers (so we can filter to FBA) -----
async function keepaGetProducts(asins) {
  if (!asins.length) return [];
  // Ask Keepa for offers + stats; that’s where FBA info lives
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${US}&asin=${asins.join(
    ","
  )}&stats=90&offers=20&rating=1&history=0&buybox=1`;
  const j = await fetch(url).then(r => r.json());
  if (j.error) throw new Error(`Keepa product error: ${JSON.stringify(j.error)}`);
  return j.products || [];
}

// ----- very light fee model (placeholder until SP-API fees) -----
function estimateFbaFee(price) {
  const referral = price * 0.15;
  const fba = 3.5;
  const storageEst = 0.3;
  return { referral, fba, storageEst };
}

// ----- scoring & decision (still loose for testing) -----
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

// ----- convert Keepa product -> deal, with FBA assumptions -----
function productToDeal(p) {
  const asin = p.asin;
  const title = p.title;

  // Build a quick view of offers so we can test FBA conditions
  const offers = Array.isArray(p.offers) ? p.offers : [];
  const hasFbaOffer = offers.some(o => o && o.isFBA);
  const fbaWinsBuyBox = offers.some(o => o && o.isFBA && o.isBuyBoxWinner);
  const fbaNearbyCount =
    (p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA ?? offers.filter(o => o.isFBA).length) || null;

  // prefer buy box price, else current NEW price (prices are cents)
  const bbCents =
    (Array.isArray(p.buyBoxPriceHistory) && p.buyBoxPriceHistory.length
      ? p.buyBoxPriceHistory[p.buyBoxPriceHistory.length - 1]
      : p.stats?.buyBoxPrice) || 0;
  const newCents = p.stats?.current_NEW || 0;
  const salePrice = (bbCents || newCents) / 100;

  // If no usable sale price, skip quietly
  if (!salePrice || !Number.isFinite(salePrice) || salePrice <= 0) {
    return { asin, title, score: 0, decision: "PASS", risks: ["No price data"], links: linksFor(asin) };
  }

  // TEMP: buy price assumption until you wire retailer feeds
  const buyPrice = Math.max(3, Number((salePrice * 0.35).toFixed(2)));

  // velocity proxies
  const dropsPerMonth = p.stats?.drops90 ? Math.round(p.stats.drops90 / 3) : p.stats?.drops30 ?? null;
  const rating = p.stats?.rating ?? 0;
  const reviewCount = p.stats?.reviewCount ?? 0;
  const reviewOk = rating >= 4 && reviewCount >= 20;

  // fees & unit economics
  const { referral, fba, storageEst } = estimateFbaFee(salePrice);
  const landed = buyPrice + 0.5 + 0.5;
  const profit = salePrice - (referral + fba + storageEst) - landed;
  const roi = landed > 0 ? profit / landed : 0;

  const score = scoreDeal({
    roi,
    profit,
    dropsPerMonth,
    nearbyOffers: fbaNearbyCount ?? undefined,
    reviewOk
  });
  const decision = decide({ roi, profit, nearbyOffers: fbaNearbyCount ?? undefined });

  return {
    asin,
    title,
    retailer: "TBD",
    salePrice: Number(salePrice.toFixed(2)),
    buyPrice: Number(buyPrice.toFixed(2)),
    profitPerUnit: Number(profit.toFixed(2)),
    roiPct: Number((roi * 100).toFixed(2)),
    fba: {
      hasFbaOffer,
      fbaWinsBuyBox,
      fbaOfferCount: fbaNearbyCount
    },
    velocity: { dropsPerMonth, bsr: p.stats?.current_SALES ?? null },
    rating: Number((rating / 10).toFixed(1)), // Keepa rating is 0–50 (5.0 * 10)
    reviewCount,
    score,
    decision,
    risks: [],
    links: linksFor(asin)
  };
}

function linksFor(asin) {
  return {
    keepaProduct: `https://keepa.com/#!product/US/${asin}`,
    amazonDetailPage: `https://www.amazon.com/dp/${asin}`
  };
}

// ----- /deals/today with FBA filters -----
app.get("/deals/today", requireKey, async (req, res) => {
  try {
    const minScore = Number(req.query.minScore ?? 0);
    const decisionFilter = req.query.decision; // BUY/WATCH/PASS

    // 1) Pull a broad batch of candidates
    let asins = await keepaProductFinder({ perPage: 100 });
    console.log("[finder] got ASINs:", asins.length);

    // fallback if completely empty (guaranteed UI output while testing)
    if (!asins.length) {
      console.warn("[finder] empty; using fallback ASINs");
      asins = ["B07FZ8S74R", "B08N5WRWNW", "B07PGL2ZSL", "B0BQLQ5ZDM", "B08CFSZLQ4", "B07W7QTMF4"];
    }

    // 2) Fetch offer/price details
    const products = await keepaGetProducts(asins.slice(0, 80));
    console.log("[product] fetched:", products.length);

    // 3) FBA-specific filtering:
    //    - must have at least 1 FBA offer (stats or offers array)
    //    - require sale price between $10 and $80 (tune as you like)
    const fbaEligible = products.filter(p => {
      const hasFbaOffer =
        (p.stats?.offerCountFBA ?? p.stats?.offerCountNewFBA ?? 0) > 0 ||
        (Array.isArray(p.offers) && p.offers.some(o => o && o.isFBA));
      const bbCents =
        (Array.isArray(p.buyBoxPriceHistory) && p.buyBoxPriceHistory.length
          ? p.buyBoxPriceHistory[p.buyBoxPriceHistory.length - 1]
          : p.stats?.buyBoxPrice) || 0;
      const newCents = p.stats?.current_NEW || 0;
      const price = (bbCents || newCents) / 100;
      return hasFbaOffer && price >= 10 && price <= 80;
    });

    // 4) Build deals + apply score/decision/filters
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

// health
app.get("/healthz", (_req, res) => res.send("ok"));

// start
app.listen(PORT, () => console.log(`Arb backend (FBA-filtered) running on ${PORT}`));
