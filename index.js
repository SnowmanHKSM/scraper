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
let currentSearchTerm = null;
let totalProcessed = 0;

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

async function scrollToBottom() {
  await page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (feed) {
      feed.scrollTo(0, feed.scrollHeight);
    }
  });
  await sleep(2000);
}

async function processSearch(searchTerm, startIndex, batchSize) {
  await initBrowser();

  // Se for uma nova busca ou se mudou o termo, reinicia tudo
  if (searchTerm !== currentSearchTerm) {
    currentSearchTerm = searchTerm;
    totalProcessed = 0;
    
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2" });
    await sleep(2000);
  }
  // Se estiver voltando para o início, recarrega a página
  else if (startIndex < totalProcessed) {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2" });
    await sleep(2000);
    totalProcessed = 0;
  }

  const results = [];
  
  // Rola até encontrar novos cards
  while (true) {
    const cards = await page.$$(".Nv2PK");
    console.log(`Encontrados ${cards.length} cards visíveis (Processados: ${totalProcessed}, Alvo: ${startIndex + batchSize})`);
    
    if (cards.length > startIndex) {
      break;
    }
    
    await scrollToBottom();
  }

  // Processa os cards do lote atual
  const cards = await page.$$(".Nv2PK");
  const startCard = startIndex;
  const endCard = Math.min(startIndex + batchSize, cards.length);

  for (let i = startCard; i < endCard; i++) {
    try {
      // Verifica se o card ainda está válido
      const isValid = await page.evaluate(card => {
        return card.isConnected && document.contains(card);
      }, cards[i]);

      if (!isValid) continue;

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

      if (details.name !== "Nome não encontrado") {
        results.push(details);
        totalProcessed++;
        console.log(`Dados capturados: ${JSON.stringify(details)}`);
      }

      await page.keyboard.press("Escape");
      await sleep(1000);
    } catch (error) {
      console.log(`Erro ao processar card ${i}: ${error.message}`);
      continue;
    }
  }

  const hasMore = cards.length > endCard;
  const next = hasMore ? `/search?term=${encodeURIComponent(searchTerm)}&start=${startIndex + results.length}&batch_size=${batchSize}` : null;

  return {
    searchTerm,
    start: startIndex,
    batch_size: batchSize,
    results,
    next,
    total_processed: totalProcessed,
    visible_cards: cards.length
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
