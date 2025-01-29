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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

app.get("/search", async (req, res) => {
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

  let browser;
  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9',
    });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT });

    const results = [];
    let retries = 0;

    while (results.length < maxResults && retries < MAX_RETRIES) {
      try {
        await page.waitForSelector('div[role="article"]', { timeout: 5000 });
        
        const items = await page.evaluate(() => {
          const elements = document.querySelectorAll('div[role="article"]');
          return Array.from(elements).map(element => {
            const nameEl = element.querySelector('h3.fontHeadlineSmall');
            const addressEl = element.querySelector('[data-tooltip]');
            
            return {
              name: nameEl ? nameEl.textContent.trim() : "Nome não encontrado",
              address: addressEl ? addressEl.getAttribute('data-tooltip').trim() : "Endereço não encontrado"
            };
          });
        });

        for (const item of items) {
          if (!results.some(r => r.name === item.name && r.address === item.address)) {
            results.push(item);
            logWithTime(`Encontrado: ${item.name}`);
          }
        }

        if (results.length >= maxResults) {
          break;
        }

        // Scroll para carregar mais resultados
        const scrolled = await page.evaluate(() => {
          const container = document.querySelector('div[role="feed"]');
          if (container) {
            const previousHeight = container.scrollHeight;
            container.scrollTop = container.scrollHeight;
            return previousHeight !== container.scrollHeight;
          }
          return false;
        });

        if (!scrolled) {
          retries++;
        }

        await sleep(RATE_LIMIT_DELAY);

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
    if (browser) {
      await browser.close();
    }
    return res.json([]);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
