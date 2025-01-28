const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;

// Configurações globais
const SERVER_TIMEOUT = 25 * 60 * 1000; // 25 minutos
let globalBrowser = null;
let isSearching = false;

// Função para inicializar o navegador
async function initBrowser() {
  if (!globalBrowser) {
    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Iniciando navegador...`);
    globalBrowser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
      ],
    });
  }
  return globalBrowser;
}

// Função para limpar recursos
async function cleanup() {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
    } catch (error) {
      console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Erro ao fechar navegador: ${error.message}`);
    }
    globalBrowser = null;
  }
  isSearching = false;
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Middleware para configurar timeout do servidor
app.use((req, res, next) => {
  res.setTimeout(SERVER_TIMEOUT, () => {
    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Requisição ainda em processamento...`);
  });

  // Configuração de headers para CORS e keep-alive
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", `timeout=${Math.floor(SERVER_TIMEOUT / 1000)}`);

  next();
});

// Função auxiliar para aguardar
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

app.get("/search", async (req, res) => {
  if (isSearching) {
    return res.status(429).json({ error: "Já existe uma busca em andamento. Tente novamente em alguns minutos." });
  }

  const searchTerm = req.query.term;
  const maxResults = parseInt(req.query.max) || 100;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  isSearching = true;
  let page;

  try {
    const browser = await initBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2" });

    // Espera carregar resultados
    await page.waitForSelector(".Nv2PK", { timeout: 30000 });

    const results = [];
    const processedItems = new Set();

    async function processCards() {
      const cards = await page.$$(".Nv2PK");
      console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Encontrados ${cards.length} cards visíveis`);

      for (let i = 0; i < cards.length && results.length < maxResults; i++) {
        const cardId = await page.evaluate((card) => card.textContent.trim(), cards[i]);

        if (processedItems.has(cardId)) {
          continue; // Ignora cards já processados
        }

        try {
          await cards[i].click();
          await page.waitForSelector("h1.DUwDvf", { timeout: 5000 });

          const details = await page.evaluate(() => {
            const name = document.querySelector("h1.DUwDvf")?.textContent?.trim() || "Nome não encontrado";
            const address = document.querySelector('button[data-item-id*="address"]')?.textContent?.trim() || "Endereço não encontrado";
            const phone = document
              .querySelector('button[data-item-id^="phone"]')
              ?.getAttribute("aria-label")
              ?.replace("Telefone: ", "")
              ?.trim() || "Telefone não encontrado";
            const website = document.querySelector('a[data-item-id*="authority"]')?.href || "Site não encontrado";

            return { name, address, phone, website };
          });

          results.push(details);
          processedItems.add(cardId);
          console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Capturado: ${JSON.stringify(details)}`);

          // Volta para a lista
          await page.goBack({ waitUntil: "networkidle2" });
        } catch (error) {
          console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Erro ao processar card ${i + 1}: ${error.message}`);
        }

        await sleep(RATE_LIMIT_DELAY); // Aguarda para evitar bloqueio
      }
    }

    let attempts = 0;

    while (results.length < maxResults && attempts < 20) {
      await processCards();

      const previousHeight = await page.evaluate(() => document.querySelector('div[role="feed"]').scrollHeight);
      await page.evaluate(() => {
        const container = document.querySelector('div[role="feed"]');
        if (container) container.scrollTo(0, container.scrollHeight);
      });

      await sleep(2000);

      const newHeight = await page.evaluate(() => document.querySelector('div[role="feed"]').scrollHeight);
      if (newHeight === previousHeight) {
        console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Altura estabilizou, finalizando...`);
        break;
      }

      attempts++;
    }

    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Busca finalizada. Total de resultados: ${results.length}`);
    res.json({ total: results.length, results });
  } catch (error) {
    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Erro durante a busca: ${error.message}`);
    res.status(500).json({ error: error.message });
  } finally {
    isSearching = false;
    if (page) await page.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
