const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();

const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 10; // Define o tamanho do lote de dados

let browser = null; // Manter uma única instância do navegador
let page = null;

// 🔥 Função sleep corrigida
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
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
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
  await initBrowser(); // Garante que o navegador está aberto

  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
  if (startIndex === 0) {
    await page.goto(url, { waitUntil: "networkidle2" });
  }

  const results = [];
  let processedItems = new Set();

  async function processVisibleCards() {
    try {
      await page.waitForSelector(".Nv2PK", { timeout: 5000 });

      const cards = await page.$$(".Nv2PK");
      console.log(`Encontrados ${cards.length} cards visíveis`);

      let seenCards = new Set();

      for (let i = startIndex; i < cards.length && results.length < batchSize; i++) {
        try {
          const cardId = await page.evaluate((card) => card.textContent.trim(), cards[i]);

          if (!cardId || processedItems.has(cardId) || seenCards.has(cardId)) {
            continue;
          }

          seenCards.add(cardId);
          await cards[i].click();
          await sleep(2000); // 🔥 Sleep corrigido

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
            console.log(`Dados capturados: ${JSON.stringify(details)}`);
          }

          await page.keyboard.press("Escape");
          await sleep(1000);
        } catch (cardError) {
          console.log(`Erro ao processar card: ${cardError.message}`);
          continue;
        }
      }
    } catch (error) {
      console.log(`Erro ao processar cards: ${error.message}`);
    }
  }

  async function scrollPage() {
    try {
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollBy(0, feed.scrollHeight);
        }
      });
      await sleep(3000);
    } catch (error) {
      console.log(`Erro ao rolar página: ${error.message}`);
    }
  }

  for (let i = 0; i < Math.ceil(startIndex / batchSize); i++) {
    console.log(`Rolagem ${i + 1}`);
    await scrollPage();
  }

  await processVisibleCards();

  // Criando link de próxima página para n8n continuar a busca
  const next =
    results.length === batchSize
      ? `https://scraper-production-87ef.up.railway.app/search?term=${searchTerm}&start=${startIndex + batchSize}&batch_size=${batchSize}`
      : null;

  return { start: startIndex, batch_size: batchSize, results, next };
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
