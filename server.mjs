import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const KEEPA_KEY = process.env.KEEPA_KEY;
const ARB_KEY = process.env.ARB_KEY;

// Simple auth middleware for your API key
app.use((req, res, next) => {
  const clientKey = req.headers["x-arbscout-key"];
  if (clientKey !== ARB_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/deals", async (req, res) => {
  try {
    // Broader Keepa finder params for guaranteed results
    const finderParams = {
      domainId: 1,                      // Amazon.com (US)
      productType: 0,                    // All products
      minCurrentPrice: 1000,             // Min $10 (price in cents)
      maxCurrentPrice: 5000,             // Max $50 (price in cents)
      minPriceReductionPercent: 20,      // At least 20% off
      sort: [["priceReductionPercent", "desc"]],
      page: 0
    };

    const keepaUrl = `https://api.keepa.com/query?key=${KEEPA_KEY}&domain=1&selection=${encodeURIComponent(JSON.stringify(finderParams))}`;

    const response = await fetch(keepaUrl);
    const data = await response.json();

    if (!data.products || data.products.length === 0) {
      return res.json({ deals: [], note: "No products found" });
    }

    // Map products to a simpler format
    const deals = data.products.map(p => ({
      asin: p.asin,
      title: p.title,
      price: p.buyBoxSellerId ? p.buyBoxPrice / 100 : p.currentPrice / 100,
      url: `https://www.amazon.com/dp/${p.asin}`
    }));

    res.json({ deals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching deals" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

