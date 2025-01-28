const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();

// Configurações de timeout
app.use((req, res, next) => {
  res.setTimeout(300000); // 5 minutos
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=300');
  next();
});

const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;

function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
}

function logWithTime(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;
  const maxResults = parseInt(req.query.max) || 100;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  let browser;

  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    logWithTime("Iniciando navegador...");

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-zygote",
        "--single-process",
        "--no-first-run"
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent and language
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9',
    });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle0" });
    
    // Wait for results with retry mechanism
    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        await page.waitForSelector(".Nv2PK", { timeout: 30000 });
        break;
      } catch (error) {
        retries++;
        if (retries === MAX_RETRIES) throw error;
        logWithTime(`Tentativa ${retries} de ${MAX_RETRIES} para carregar resultados...`);
        await sleep(2000);
      }
    }

    const results = [];
    let processedItems = new Set();

    async function processVisibleCards() {
      const cards = await page.$$(".Nv2PK");
      logWithTime(`Encontrados ${cards.length} cards visíveis`);

      for (let i = 0; i < cards.length && results.length < maxResults; i++) {
        try {
          // Verifica se já processamos este card
          const cardId = await page.evaluate(el => el.dataset.cardId || el.textContent, cards[i]);
          if (processedItems.has(cardId)) {
            continue;
          }

          // Rola até o card com smooth scrolling
          await page.evaluate((card) => {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, cards[i]);
          
          await sleep(RATE_LIMIT_DELAY);

          // Tenta clicar no card com retry mechanism
          let clickSuccess = false;
          for (let retry = 0; retry < MAX_RETRIES && !clickSuccess; retry++) {
            try {
              await cards[i].click();
              clickSuccess = true;
            } catch (error) {
              if (retry === MAX_RETRIES - 1) throw error;
              await sleep(1000);
            }
          }

          await page.waitForSelector("h1.DUwDvf", { timeout: 5000 });

          // Captura os detalhes com verificações mais robustas
          const details = await page.evaluate(() => {
            const getTextContent = (selector) => {
              const element = document.querySelector(selector);
              return element ? element.textContent.trim() : null;
            };

            const name = getTextContent("h1.DUwDvf") || "Nome não encontrado";
            const address = document.querySelector('button[data-item-id*="address"]')?.textContent?.trim() || 
                           document.querySelector('div[data-item-id*="address"]')?.textContent?.trim() ||
                           "Endereço não encontrado";
            
            const phone = document.querySelector('button[data-item-id^="phone"]')?.getAttribute("aria-label")?.replace("Telefone: ", "")?.trim() || 
                         document.querySelector('div[data-item-id^="phone"]')?.textContent?.trim() ||
                         "Telefone não encontrado";
            
            const website = document.querySelector('a[data-item-id*="authority"]')?.href || 
                           document.querySelector('a[data-item-id*="website"]')?.href ||
                           "Site não encontrado";

            return { name, address, phone, website };
          });

          logWithTime(`Dados capturados: ${JSON.stringify(details)}`);
          results.push(details);
          processedItems.add(cardId);

          // Volta para a lista com retry mechanism
          let backSuccess = false;
          for (let retry = 0; retry < MAX_RETRIES && !backSuccess; retry++) {
            try {
              await page.goBack({ waitUntil: "networkidle0" });
              await page.waitForSelector(".Nv2PK", { timeout: 5000 });
              backSuccess = true;
            } catch (error) {
              if (retry === MAX_RETRIES - 1) throw error;
              await sleep(1000);
            }
          }

        } catch (error) {
          logWithTime(`Erro ao processar card ${i + 1}: ${error.message}`);
          try {
            const isOnList = await page.$(".Nv2PK");
            if (!isOnList) {
              await page.goBack({ waitUntil: "networkidle0" });
              await page.waitForSelector(".Nv2PK", { timeout: 5000 });
            }
          } catch (navError) {
            logWithTime(`Erro ao navegar de volta: ${navError.message}`);
          }
        }

        // Rate limiting between cards
        await sleep(RATE_LIMIT_DELAY);
      }
    }

    async function scrollPage() {
      const scrollResult = await page.evaluate(() => {
        const container = document.querySelector('div[role="feed"]');
        if (container) {
          const previousHeight = container.scrollHeight;
          container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth'
          });
          return { previousHeight, success: true };
        }
        return { success: false };
      });
      
      await sleep(2000);
      return scrollResult;
    }

    // Loop principal: rola e processa
    let previousHeight = 0;
    let sameHeightCount = 0;
    const maxAttempts = 15;

    for (let attempt = 0; attempt < maxAttempts && results.length < maxResults; attempt++) {
      await processVisibleCards();

      const scrollResult = await scrollPage();
      if (!scrollResult.success) {
        logWithTime("Não foi possível encontrar o container de rolagem");
        break;
      }

      const currentHeight = await page.evaluate(() => {
        const container = document.querySelector('div[role="feed"]');
        return container ? container.scrollHeight : document.documentElement.scrollHeight;
      });

      if (currentHeight === previousHeight) {
        sameHeightCount++;
        if (sameHeightCount >= 3) {
          logWithTime("Altura estabilizou, finalizando...");
          break;
        }
      } else {
        sameHeightCount = 0;
      }

      previousHeight = currentHeight;
    }

    logWithTime(`Busca finalizada. Total de resultados: ${results.length}`);
    await browser.close();
    logWithTime("Navegador fechado com sucesso");

    return res.json({
      total: results.length,
      results: results
    });

  } catch (error) {
    logWithTime(`Erro durante a execução: ${error.message}`);
    if (browser) {
      await browser.close();
      logWithTime("Navegador fechado após erro");
    }
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Configura timeout do servidor
server.timeout = 300000; // 5 minutos
server.keepAliveTimeout = 300000;
server.headersTimeout = 301000;
