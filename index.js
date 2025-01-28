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

    async function processVisibleCards() {
      const cards = await page.$$(".Nv2PK");
      logWithTime(`Encontrados ${cards.length} cards visíveis`);

      for (let i = 0; i < cards.length && results.length < maxResults; i++) {
        try {
          // Rola até o card
          await page.evaluate((card) => {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, cards[i]);
          
          await sleep(1000);

          // Tenta clicar no card com múltiplas estratégias
          let clicked = false;
          try {
            await cards[i].click();
            clicked = true;
          } catch (error) {
            try {
              await page.evaluate(card => card.click(), cards[i]);
              clicked = true;
            } catch (error2) {
              try {
                const selector = await cards[i].evaluate(el => {
                  const link = el.querySelector('a');
                  return link ? link.href : null;
                });
                if (selector) {
                  await page.goto(selector, { waitUntil: 'networkidle0' });
                  clicked = true;
                }
              } catch (error3) {
                throw new Error('Não foi possível clicar no card de nenhuma forma');
              }
            }
          }

          if (!clicked) {
            continue;
          }

          // Espera os detalhes carregarem
          await Promise.race([
            page.waitForSelector("h1.DUwDvf", { timeout: 5000 }),
            page.waitForSelector("h1.fontHeadlineLarge", { timeout: 5000 })
          ]);

          // Captura os detalhes com múltiplos seletores
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

            const name = getTextContent([
              "h1.DUwDvf",
              "h1.fontHeadlineLarge",
              ".DUwDvf"
            ]) || "Nome não encontrado";

            const address = getTextContent([
              'button[data-item-id*="address"]',
              'div[data-item-id*="address"]',
              '.rogA2c',
              '.address'
            ]) || "Endereço não encontrado";
            
            const phone = getTextContent([
              'button[data-item-id^="phone"]',
              'div[data-item-id^="phone"]',
              '.phone'
            ]) || "Telefone não encontrado";

            const websiteElement = 
              document.querySelector('a[data-item-id*="authority"]') ||
              document.querySelector('a[data-item-id*="website"]') ||
              document.querySelector('a[data-tooltip="Abrir site"]');
            
            const website = websiteElement ? websiteElement.href : "Site não encontrado";

            return { name, address, phone, website };
          });

          logWithTime(`Dados capturados: ${JSON.stringify(details)}`);
          results.push(details);

          // Volta para a lista
          await page.goBack({ waitUntil: "networkidle0" });
          await page.waitForSelector(".Nv2PK", { timeout: 5000 });

        } catch (error) {
          logWithTime(`Erro ao processar card ${i}: ${error.message}`);
          try {
            const isOnList = await page.$(".Nv2PK");
            if (!isOnList) {
              await page.goBack({ waitUntil: "networkidle0" });
              await page.waitForSelector(".Nv2PK", { timeout: 5000 });
            }
          } catch (navError) {
            logWithTime(`Erro ao navegar de volta: ${navError.message}`);
            // Tenta recarregar a página em caso de erro
            await page.reload({ waitUntil: "networkidle0" });
          }
        }

        await sleep(RATE_LIMIT_DELAY);
      }
    }

    async function scrollPage() {
      return await page.evaluate(() => {
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
