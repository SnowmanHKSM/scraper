const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const https = require("https");

// Ativar Stealth Mode
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 10;

let browser = null;
let page = null;
let searchResults = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 🔹 1️⃣ INICIAR O NAVEGADOR COM CONFIGURAÇÕES MAIS ESTÁVEIS
 */
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--disable-features=BlockInsecurePrivateNetworkRequests" // 🔥 EVITAR ERRO DE SSL
      ],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9",
    });

    // 🔥 PREVENIR INTERRUPÇÕES DE REDE
    page.on("error", (err) => console.error("Erro na página:", err));
    page.on("requestfailed", (req) => console.error("Falha na requisição:", req.url(), req.failure()?.errorText));
  }
}

/**
 * 🔹 2️⃣ MELHORAR A ESTABILIDADE DO EXPRESS
 */
app.use((req, res, next) => {
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=10, max=100");
  res.setHeader("Access-Control-Allow-Origin", "*"); // 🔥 EVITAR BLOQUEIOS DE CORS
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

/**
 * 🔹 3️⃣ SOLUÇÃO PARA ERRO DE SSL NO NODE.JS (TLS 1.2+)
 */
const agent = new https.Agent({
  rejectUnauthorized: false, // 🔥 IGNORAR ERROS DE SSL
  keepAlive: true, // 🔥 EVITAR CONEXÕES FECHADAS PREMATURAMENTE
});

async function getAllResults(searchTerm) {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await sleep(2000);

  const results = [];
  const processedNames = new Set();
  let previousLength = 0;
  let sameResultCount = 0;
  let totalScrolls = 0;
  const MAX_SCROLLS = 20;

  while (totalScrolls < MAX_SCROLLS) {
    const cards = await page.$$(".Nv2PK");
    console.log(`Encontrados ${cards.length} cards visíveis`);

    for (let i = previousLength; i < cards.length; i++) {
      try {
        await cards[i].click();
        await sleep(2000);

        const details = await page.evaluate(() => {
          const getTextContent = (selectors) => {
            for (const selector of selectors) {
              const element = document.querySelector(selector);
              if (element) {
                return element.textContent.trim();
              }
            }
            return null;
          };

          const name = getTextContent(["h1.DUwDvf", "div[role='heading']"]) || "Nome não encontrado";
          const address = getTextContent(["button[data-item-id*='address']"]) || "Endereço não encontrado";
          const phone = getTextContent(["button[data-item-id^='phone']"]) || "Telefone não encontrado";
          const website = getTextContent(["a[data-item-id*='website']"]) || "Site não encontrado";

          return { name, address, phone, website };
        });

        if (details.name !== "Nome não encontrado" && !processedNames.has(details.name)) {
          results.push(details);
          processedNames.add(details.name);
          console.log(`Dados capturados: ${JSON.stringify(details)}`);
        }

        await page.keyboard.press("Escape");
        await sleep(1000);
      } catch (error) {
        console.log(`Erro ao processar card ${i}: ${error.message}`);
      }
    }

    if (cards.length === previousLength) {
      sameResultCount++;
      if (sameResultCount >= 3) break;
    } else {
      sameResultCount = 0;
    }

    previousLength = cards.length;
    totalScrolls++;

    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) {
        feed.scrollTo(0, feed.scrollHeight);
      }
    });
    await sleep(2000);
  }

  return results;
}

// 🔹 Endpoint para limpar cache
app.post("/clear-cache", (req, res) => {
  searchResults.clear();
  res.json({ message: "Cache limpo com sucesso" });
});

// 🔹 Rota principal de busca
app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;
  const startIndex = parseInt(req.query.start) || 0;
  const batchSize = parseInt(req.query.batch_size) || BATCH_SIZE;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  try {
    await initBrowser();

    if (!searchResults.has(searchTerm)) {
      const allResults = await getAllResults(searchTerm);
      searchResults.set(searchTerm, allResults);
    }

    const results = searchResults.get(searchTerm);
    const batch = results.slice(startIndex, startIndex + batchSize);
    const hasMore = startIndex + batchSize < results.length;
    const nextStart = hasMore ? startIndex + batchSize : null;

    res.json({
      success: true,
      data: {
        total_results: results.length,
        current_page: Math.floor(startIndex / batchSize) + 1,
        total_pages: Math.ceil(results.length / batchSize),
        start_index: startIndex,
        batch_size: batchSize,
        has_more: hasMore,
        next_start: nextStart,
        results: batch,
      },
    });
  } catch (error) {
    console.error(`Erro durante a execução:`, error);
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
    });
  }
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Servidor rodando na porta ${PORT}`);
});
