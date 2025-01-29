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
const ITEMS_PER_PAGE = 10; // Retorna 10 resultados por vez
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
  const searchTerm = req.query.term;
  const page = parseInt(req.query.page) || 1;
  const maxResults = parseInt(req.query.max) || 100;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  // Gera uma chave única para esta busca
  const searchKey = `${searchTerm}_${maxResults}`;

  // Verifica se já temos resultados em cache
  if (searchCache.has(searchKey)) {
    const cachedResults = searchCache.get(searchKey);
    const start = (page - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const pageResults = cachedResults.slice(start, end);

    // Se não há mais resultados, indica que a paginação terminou
    if (pageResults.length === 0) {
      searchCache.delete(searchKey); // Limpa o cache
      return res.json({ 
        finished: true,
        results: [],
        totalResults: cachedResults.length,
        currentPage: page
      });
    }

    return res.json({
      finished: end >= cachedResults.length,
      results: pageResults,
      totalResults: cachedResults.length,
      currentPage: page,
      progress: Math.min(100, (end * 100) / maxResults)
    });
  }

  // Se é a primeira página, inicia o scraping
  if (page === 1) {
    let browser;
    try {
      logWithTime(`Iniciando nova busca por: ${searchTerm}`);
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu"
        ]
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

      const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
      await page.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT });

      const results = [];
      let retries = 0;

      while (results.length < maxResults && retries < MAX_RETRIES) {
        try {
          const elements = await page.$$('div[role="article"]');
          
          for (const element of elements) {
            try {
              const nameElement = await element.$('h3.fontHeadlineSmall');
              const addressElement = await element.$('[data-tooltip]');
              
              if (!nameElement || !addressElement) continue;

              const name = await nameElement.evaluate(el => el.textContent);
              const address = await addressElement.evaluate(el => el.getAttribute('data-tooltip'));

              if (!results.some(r => r.name === name && r.address === address)) {
                results.push({ name, address });

                // A cada ITEMS_PER_PAGE resultados, emite uma resposta parcial
                if (results.length % ITEMS_PER_PAGE === 0) {
                  const start = 0;
                  const end = ITEMS_PER_PAGE;
                  searchCache.set(searchKey, results);
                  
                  // Não fecha o browser ainda, continua coletando
                  return res.json({
                    finished: false,
                    results: results.slice(start, end),
                    totalResults: results.length,
                    currentPage: 1,
                    progress: Math.min(100, (results.length * 100) / maxResults)
                  });
                }
              }
            } catch (err) {
              console.error('Erro ao extrair dados:', err);
              continue;
            }
          }

          if (results.length < maxResults) {
            await page.evaluate(() => {
              const container = document.querySelector('div[role="feed"]');
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
            });
            await page.waitForTimeout(RATE_LIMIT_DELAY);
          }

        } catch (err) {
          console.error('Erro durante a extração:', err);
          retries++;
        }
      }

      await browser.close();
      
      // Armazena os resultados em cache
      searchCache.set(searchKey, results);
      
      // Retorna a primeira página de resultados
      return res.json({
        finished: results.length <= ITEMS_PER_PAGE,
        results: results.slice(0, ITEMS_PER_PAGE),
        totalResults: results.length,
        currentPage: 1,
        progress: Math.min(100, (results.length * 100) / maxResults)
      });

    } catch (error) {
      console.error('Erro geral:', error);
      if (browser) {
        await browser.close();
      }
      return res.status(500).json({ 
        error: error.message,
        finished: true
      });
    }
  } else {
    // Se não é a primeira página e não tem cache, algo deu errado
    return res.status(400).json({ 
      error: "Busca não encontrada. Inicie novamente da página 1.",
      finished: true
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
