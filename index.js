const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const SERVER_TIMEOUT = 25 * 60 * 1000; // 25 minutos

// Configurar timeouts do servidor
app.use((req, res, next) => {
  res.setTimeout(SERVER_TIMEOUT, () => {
    logWithTime('Requisição ainda em processamento...');
  });
  
  // Configurar headers para CORS e keep-alive
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=' + Math.floor(SERVER_TIMEOUT/1000));
  
  next();
});

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

// Rota de status para healthcheck
app.get("/status", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;
  const maxResults = parseInt(req.query.max) || 100;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  let browser;
  const processedItems = new Set(); // Para controlar duplicatas

  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2" });

    // Espera os resultados carregarem
    await page.waitForSelector('div[role="article"]', { timeout: 10000 })
      .then(() => logWithTime(`Resultados encontrados usando seletor: div[role="article"]`))
      .catch(() => {
        throw new Error("Não foi possível carregar os resultados");
      });

    const results = [];
    let noNewResultsCount = 0;
    const maxScrolls = 20;

    for (let scrollCount = 0; scrollCount < maxScrolls && results.length < maxResults && noNewResultsCount < 3; scrollCount++) {
      const cards = await page.$$('div[role="article"]');
      logWithTime(`Encontrados ${cards.length} cards visíveis`);

      for (const card of cards) {
        try {
          // Extrai um identificador único do card
          const nameElement = await card.$('h3.fontHeadlineLarge');
          const name = nameElement ? await nameElement.evaluate(el => el.textContent.trim()) : '';
          const addressElement = await card.$('div[aria-label^="Endereço"]');
          const address = addressElement ? await addressElement.evaluate(el => el.textContent.trim()) : '';
          
          const cardId = `${name}|${address}`;
          
          if (processedItems.has(cardId)) {
            continue;
          }
          
          processedItems.add(cardId);

          await card.click();
          await sleep(RATE_LIMIT_DELAY);

          const data = await page.evaluate(() => {
            const getTextContent = (selectors) => {
              for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element) {
                  const text = element.textContent.trim();
                  if (text) return text;
                }
              }
              return null;
            };

            const nameSelectors = [
              'h1.DUwDvf',
              'div[role="heading"]',
              '.fontHeadlineLarge',
              '.qBF1Pd'
            ];

            const addressSelectors = [
              'button[data-item-id*="address"]',
              'div[data-item-id*="address"]',
              '.rogA2c',
              '.rlpyBL'
            ];

            const phoneSelectors = [
              'button[data-item-id^="phone"]',
              'div[data-item-id^="phone"]',
              '.rogA2c span',
              'span[aria-label*="telefone"]'
            ];

            const websiteSelectors = [
              'a[data-item-id*="authority"]',
              'a[data-item-id*="website"]',
              'a[aria-label*="site"]',
              'a.rogA2c'
            ];

            const name = getTextContent(nameSelectors) || "Nome não encontrado";
            const address = getTextContent(addressSelectors) || "Endereço não encontrado";
            
            // Tratamento especial para telefone
            let phone = null;
            for (const selector of phoneSelectors) {
              const element = document.querySelector(selector);
              if (element) {
                phone = element.getAttribute("aria-label")?.replace("Telefone: ", "")?.trim() ||
                       element.textContent.trim();
                if (phone) break;
              }
            }
            phone = phone || "Telefone não encontrado";

            // Tratamento especial para website
            let website = null;
            for (const selector of websiteSelectors) {
              const element = document.querySelector(selector);
              if (element && element.href) {
                website = element.href;
                break;
              }
            }
            website = website || "Site não encontrado";

            return { name, address, phone, website };
          });

          if (data.name !== "Nome não encontrado") {
            results.push(data);
            logWithTime(`Dados capturados: ${JSON.stringify(data)}`);
          }

          // Fecha o card atual
          await page.keyboard.press('Escape');
          await sleep(1000);

        } catch (cardError) {
          logWithTime(`Erro ao processar card: ${cardError.message}`);
          continue;
        }

        if (results.length >= maxResults) {
          break;
        }
      }

      if (results.length >= maxResults) {
        break;
      }

      // Rola a página
      logWithTime(`Rolagem ${scrollCount + 1}`);
      
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollTo(0, feed.scrollHeight);
        }
      });

      await sleep(3000);

      // Verifica se novos resultados foram carregados
      const newCards = await page.$$('div[role="article"]');
      if (newCards.length === cards.length) {
        noNewResultsCount++;
      } else {
        noNewResultsCount = 0;
      }
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

// Inicia o servidor apenas se o arquivo for executado diretamente
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const HOST = '0.0.0.0';
  
  const server = app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT}`);
    console.log(`Para fazer uma busca, acesse: http://${HOST}:${PORT}/search?term=sua+busca`);
  });

  // Configurar timeout do servidor
  server.timeout = SERVER_TIMEOUT;
  
  // Tratamento de erros do servidor
  server.on('error', (error) => {
    console.error('Erro no servidor:', error);
  });
}

// Exporta o app para poder ser usado em testes ou por outros módulos
module.exports = app;
