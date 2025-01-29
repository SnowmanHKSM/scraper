const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cors = require('cors');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// Cache para armazenar resultados das buscas
const searchCache = new Map();

// Configurações
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const ITEMS_PER_PAGE = 10;
const TIMEOUT = 45 * 60 * 1000;

function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
}

function logWithTime(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/search", async (req, res) => {
  try {
    const searchTerm = req.query.term;
    const page = parseInt(req.query.page) || 1;
    const maxResults = parseInt(req.query.max) || 100;

    if (!searchTerm) {
      return res.status(400).json([]);
    }

    // Gera uma chave única para esta busca
    const searchKey = `${searchTerm}_${maxResults}`;

    // Verifica se já temos resultados em cache
    if (searchCache.has(searchKey)) {
      const cachedResults = searchCache.get(searchKey);
      const start = (page - 1) * ITEMS_PER_PAGE;
      const end = start + ITEMS_PER_PAGE;
      const pageResults = cachedResults.slice(start, end);

      // Se não há mais resultados, retorna array vazio
      if (pageResults.length === 0) {
        searchCache.delete(searchKey);
        return res.json([]);
      }

      logWithTime(`Retornando página ${page} do cache para: ${searchTerm}`);
      return res.json(pageResults);
    }

    // Se não é a primeira página e não tem cache, retorna vazio
    if (page > 1) {
      return res.json([]);
    }

    // Inicia o scraping
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const browserPage = await browser.newPage();
    await browserPage.setViewport({ width: 1920, height: 1080 });
    await browserPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await browserPage.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT });

    const results = [];
    let retries = 0;

    while (results.length < maxResults && retries < MAX_RETRIES) {
      try {
        const elements = await browserPage.$$('div[role="article"]');
        let newResults = 0;
        
        for (const element of elements) {
          try {
            const nameElement = await element.$('h3.fontHeadlineSmall');
            const addressElement = await element.$('[data-tooltip]');
            
            if (!nameElement || !addressElement) continue;

            const name = await nameElement.evaluate(el => el.textContent);
            const address = await addressElement.evaluate(el => el.getAttribute('data-tooltip'));

            if (!results.some(r => r.name === name && r.address === address)) {
              results.push({ name, address });
              newResults++;
              logWithTime(`Encontrado: ${name}`);
            }
          } catch (err) {
            console.error('Erro ao extrair dados:', err);
            continue;
          }
        }

        // Se não encontrou novos resultados, tenta mais algumas vezes
        if (newResults === 0) {
          retries++;
        }

        // Scroll para carregar mais resultados
        if (results.length < maxResults) {
          await browserPage.evaluate(() => {
            const container = document.querySelector('div[role="feed"]');
            if (container) {
              container.scrollTop = container.scrollHeight;
            }
          });
          await browserPage.waitForTimeout(RATE_LIMIT_DELAY);
        }

      } catch (err) {
        console.error('Erro durante a extração:', err);
        retries++;
      }
    }

    await browser.close();
    logWithTime(`Busca finalizada. Total de resultados: ${results.length}`);
    
    // Armazena os resultados em cache
    searchCache.set(searchKey, results);
    
    // Retorna a primeira página
    return res.json(results.slice(0, ITEMS_PER_PAGE));

  } catch (error) {
    console.error('Erro geral:', error);
    return res.json([]);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
