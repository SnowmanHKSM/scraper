const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 10;

let browser = null;
let page = null;
let processedItems = new Set(); // Movido para escopo global para manter entre requisições

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  }
}

async function processSearch(searchTerm, startIndex, batchSize) {
  await initBrowser();

  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
  if (startIndex === 0) {
    await page.goto(url, { waitUntil: "networkidle2" });
    processedItems.clear(); // Limpa os itens processados apenas quando começa uma nova busca
  }

  const results = [];

  async function processVisibleCards() {
    try {
      await page.waitForSelector(".Nv2PK", { timeout: 5000 });
      const cards = await page.$$(".Nv2PK");
      console.log(`Encontrados ${cards.length} cards visíveis`);

      let processedInThisBatch = 0;

      for (let i = 0; i < cards.length && processedInThisBatch < batchSize; i++) {
        try {
          const cardId = await page.evaluate((card) => {
            const nameElement = card.querySelector('div[role="heading"]') || 
                              card.querySelector('.fontHeadlineSmall');
            return nameElement ? nameElement.textContent.trim() : null;
          }, cards[i]);

          if (!cardId || processedItems.has(cardId)) {
            continue;
          }

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

          if (!results.some((result) => result.name === details.name && result.address === details.address)) {
            results.push(details);
            processedItems.add(cardId);
            processedInThisBatch++;
            console.log(`Dados capturados: ${JSON.stringify(details)}`);
          }

          await page.keyboard.press("Escape");
          await sleep(1000);
        } catch (cardError) {
          console.log(`Erro ao processar card: ${cardError.message}`);
          continue;
        }
      }

      return processedInThisBatch;
    } catch (error) {
      console.log(`Erro ao processar cards: ${error.message}`);
      return 0;
    }
  }

  async function scrollPage() {
    try {
      const previousHeight = await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          const height = feed.scrollHeight;
          feed.scrollBy(0, height);
          return height;
        }
        return 0;
      });
      
      await sleep(3000);
      
      const newHeight = await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        return feed ? feed.scrollHeight : 0;
      });
      
      return newHeight > previousHeight;
    } catch (error) {
      console.log(`Erro ao rolar página: ${error.message}`);
      return false;
    }
  }

  // Rola até encontrar novos resultados ou atingir o limite
  let scrollCount = 0;
  const maxScrolls = 10;
  
  while (results.length < batchSize && scrollCount < maxScrolls) {
    console.log(`Rolagem ${scrollCount + 1}`);
    const hasMore = await scrollPage();
    await processVisibleCards();
    
    if (!hasMore) {
      break;
    }
    
    scrollCount++;
  }

  const next = results.length === batchSize
    ? `/search?term=${encodeURIComponent(searchTerm)}&start=${startIndex + batchSize}&batch_size=${batchSize}`
    : null;

  return { 
    start: startIndex, 
    batch_size: batchSize, 
    results,
    next,
    total_processed: processedItems.size
  };
}

app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;
  const startIndex = parseInt(req.query.start) || 0;
  const batchSize = parseInt(req.query.batch_size) || BATCH_SIZE;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  try {
    const data = await processSearch(searchTerm, startIndex, batchSize);
    res.json(data);
  } catch (error) {
    console.log(`Erro durante a execução: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
