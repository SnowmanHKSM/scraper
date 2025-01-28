const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
const RATE_LIMIT_DELAY = 2000; // Delay between card processing
const MAX_RETRIES = 3; // Maximum number of retries for failed operations

function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
}

function logWithTime(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

// Sleep utility function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;
  const maxResults = parseInt(req.query.max) || 100; // Limit number of results

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  let browser;

  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    logWithTime("Iniciando navegador...");

    browser = await puppeteer.launch({
      headless: "new",
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
      // Aguarda um pouco para o DOM estabilizar
      await sleep(2000);

      // Usa evaluateHandle para manter a referência aos elementos
      const cardsHandle = await page.evaluateHandle(() => {
        return document.querySelectorAll('.Nv2PK');
      });
      
      const cards = await page.evaluate(cardsHandle => {
        return Array.from(cardsHandle).map(card => {
          const name = card.querySelector('div.qBF1Pd')?.textContent?.trim();
          return { element: card, name };
        });
      }, cardsHandle);

      logWithTime(`Encontrados ${cards.length} cards visíveis`);

      for (let i = 0; i < cards.length && results.length < maxResults; i++) {
        try {
          // Verifica se já processamos este card pelo nome
          if (processedItems.has(cards[i].name)) {
            continue;
          }

          // Scroll suave até o elemento
          await page.evaluate((index) => {
            const cards = document.querySelectorAll('.Nv2PK');
            if (cards[index]) {
              cards[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, i);

          await sleep(1000);

          // Tenta clicar no card usando evaluate
          const clicked = await page.evaluate((index) => {
            const cards = document.querySelectorAll('.Nv2PK');
            if (cards[index]) {
              cards[index].click();
              return true;
            }
            return false;
          }, i);

          if (!clicked) {
            throw new Error('Card não encontrado para clique');
          }

          // Aguarda o carregamento dos detalhes
          await page.waitForSelector("h1.DUwDvf", { timeout: 5000 });
          await sleep(1000);

          // Captura os detalhes
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

          if (details.name !== "Nome não encontrado") {
            logWithTime(`Dados capturados: ${JSON.stringify(details)}`);
            results.push(details);
            processedItems.add(details.name);
          }

          // Volta para a lista
          await page.goBack({ waitUntil: "networkidle0" });
          await page.waitForSelector(".Nv2PK", { timeout: 5000 });
          await sleep(1000);

        } catch (error) {
          logWithTime(`Erro ao processar card ${i + 1}: ${error.message}`);
          try {
            const isOnList = await page.$(".Nv2PK");
            if (!isOnList) {
              await page.goBack({ waitUntil: "networkidle0" });
              await page.waitForSelector(".Nv2PK", { timeout: 5000 });
              await sleep(1000);
            }
          } catch (navError) {
            logWithTime(`Erro ao navegar de volta: ${navError.message}`);
          }
        }
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
      
      // Aguarda mais tempo para o carregamento no modo headless
      await sleep(3000);
      return scrollResult;
    }

    // Loop principal: rola e processa
    let previousHeight = 0;
    let sameHeightCount = 0;
    const maxAttempts = 15;
    let lastProcessedCount = 0;
    let noNewResultsCount = 0;

    for (let attempt = 0; attempt < maxAttempts && results.length < maxResults; attempt++) {
      const beforeCount = results.length;
      await processVisibleCards();
      const afterCount = results.length;
      
      // Se não encontrou novos resultados
      if (afterCount === beforeCount) {
        noNewResultsCount++;
        if (noNewResultsCount >= 2) {
          logWithTime("Nenhum novo resultado encontrado após múltiplas tentativas, finalizando...");
          break;
        }
      } else {
        noNewResultsCount = 0;
      }

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
        if (sameHeightCount >= 2) {
          logWithTime("Altura estabilizou, finalizando...");
          break;
        }
      } else {
        sameHeightCount = 0;
      }

      previousHeight = currentHeight;
      lastProcessedCount = afterCount;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
