const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();

// Aumenta o timeout do servidor
app.use((req, res, next) => {
  res.setTimeout(300000); // 5 minutos
  next();
});

// Configurações
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const PAGE_TIMEOUT = 30000;

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
  const results = [];
  let browser;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

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
        "--no-first-run",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-notifications",
        "--disable-offer-store-unmasked-wallet-cards",
        "--disable-popup-blocking",
        "--disable-print-preview",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-speech-api",
        "--disable-sync",
        "--disable-translate",
        "--disable-voice-input",
        "--ignore-certificate-errors",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--safebrowsing-disable-auto-update",
        "--no-experiments",
        "--no-pings",
        "--js-flags=--max-old-space-size=460",
        "--memory-pressure-off",
        "--disable-dev-profile"
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      ignoreHTTPSErrors: true,
      pipe: true,
      dumpio: true,
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    });

    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    
    // Limita o uso de recursos
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Limpa listeners e cache periodicamente
    const clearMemory = async () => {
      if (page && !page.isClosed()) {
        await page.evaluate(() => {
          window.gc && window.gc();
          performance.clearResourceTimings();
        });
      }
    };

    setInterval(clearMemory, 30000);

    await page.setDefaultTimeout(PAGE_TIMEOUT);
    await page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    
    // Tenta carregar a página várias vezes se necessário
    let pageLoaded = false;
    for (let attempt = 0; attempt < 3 && !pageLoaded; attempt++) {
      try {
        await page.goto(url, { 
          waitUntil: ["networkidle0", "domcontentloaded"],
          timeout: PAGE_TIMEOUT 
        });
        pageLoaded = true;
      } catch (error) {
        logWithTime(`Tentativa ${attempt + 1} de carregar a página falhou: ${error.message}`);
        await sleep(2000);
      }
    }

    if (!pageLoaded) {
      throw new Error("Não foi possível carregar a página após várias tentativas");
    }

    // Espera os resultados aparecerem
    await page.waitForSelector(".Nv2PK", { timeout: PAGE_TIMEOUT });
    
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

          // Tenta clicar no card
          await Promise.race([
            cards[i].click(),
            page.evaluate(card => card.click(), cards[i])
          ]).catch(async () => {
            // Se falhar, tenta clicar pelo href
            const href = await cards[i].evaluate(el => {
              const link = el.querySelector('a');
              return link ? link.href : null;
            });
            if (href) {
              await page.goto(href, { waitUntil: "networkidle0" });
            }
          });

          // Espera os detalhes carregarem
          await Promise.race([
            page.waitForSelector("h1.DUwDvf", { timeout: 5000 }),
            page.waitForSelector("h1.fontHeadlineLarge", { timeout: 5000 })
          ]);

          // Captura os detalhes
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
          // Tenta voltar à lista em caso de erro
          try {
            await page.goto(url, { waitUntil: "networkidle0" });
            await page.waitForSelector(".Nv2PK", { timeout: 5000 });
          } catch (navError) {
            logWithTime(`Erro ao navegar: ${navError.message}`);
          }
        }

        await sleep(RATE_LIMIT_DELAY);
      }
    }

    // Loop principal: processa os cards visíveis
    let previousHeight = 0;
    let sameHeightCount = 0;
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts && results.length < maxResults; attempt++) {
      await processVisibleCards();

      // Rola a página
      const currentHeight = await page.evaluate(() => {
        const container = document.querySelector('div[role="feed"]');
        if (container) {
          const previousHeight = container.scrollHeight;
          container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth'
          });
          return previousHeight;
        }
        return 0;
      });

      await sleep(2000);

      if (currentHeight === previousHeight) {
        sameHeightCount++;
        if (sameHeightCount >= 3) {
          logWithTime("Fim da rolagem atingido");
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
    return res.status(500).json({ 
      error: error.message,
      results: results // Retorna resultados parciais mesmo em caso de erro
    });
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

server.timeout = 300000; // 5 minutos
server.keepAliveTimeout = 300000;
server.headersTimeout = 301000;
