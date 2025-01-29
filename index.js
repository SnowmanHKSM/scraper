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

async function extractPlacesFromGoogle(searchQuery, page = 1) {
    console.log(`[${new Date().toLocaleTimeString()}] Iniciando nova busca por: ${searchQuery}`);
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080',
        ],
    });

    try {
        const page = await browser.newPage();
        
        // Configurar timeout maior para navegação
        await page.setDefaultNavigationTimeout(30000);
        await page.setDefaultTimeout(30000);
        
        // Configurar user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        
        // Ir para Google Maps
        await page.goto('https://www.google.com/maps', { waitUntil: 'networkidle0' });
        
        // Esperar e preencher campo de busca
        const searchBox = await page.waitForSelector('#searchboxinput');
        await searchBox.type(searchQuery);
        await page.keyboard.press('Enter');
        
        // Esperar carregamento dos resultados
        await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
        
        // Aguardar um momento para carregar resultados
        await page.waitForTimeout(2000);
        
        // Rolar para carregar mais resultados
        for(let i = 0; i < 3; i++) {
            await page.evaluate(() => {
                const feed = document.querySelector('div[role="feed"]');
                if (feed) {
                    feed.scrollTop = feed.scrollHeight;
                }
            });
            await page.waitForTimeout(1000);
        }
        
        // Extrair dados
        const results = await page.evaluate(() => {
            const items = document.querySelectorAll('div[role="article"]');
            return Array.from(items).map(item => {
                try {
                    const title = item.querySelector('div[role="heading"]')?.textContent || '';
                    const rating = item.querySelector('span[role="img"]')?.getAttribute('aria-label') || '';
                    const address = Array.from(item.querySelectorAll('div[class] div[class]'))
                        .map(div => div.textContent)
                        .find(text => text.includes('·') || text.includes(',')) || '';
                        
                    return {
                        title: title.trim(),
                        rating: rating.replace('Classificação: ', '').trim(),
                        address: address.split('·').pop()?.trim() || address.trim()
                    };
                } catch (err) {
                    console.error('Erro ao extrair dados do item:', err);
                    return null;
                }
            }).filter(item => item && item.title);
        });

        console.log(`[${new Date().toLocaleTimeString()}] Busca finalizada. Total de resultados: ${results.length}`);
        
        // Retornar página específica de resultados
        const itemsPerPage = 10;
        const startIndex = (page - 1) * itemsPerPage;
        const paginatedResults = results.slice(startIndex, startIndex + itemsPerPage);
        
        return {
            results: paginatedResults,
            total: results.length,
            page: page,
            totalPages: Math.ceil(results.length / itemsPerPage)
        };

    } catch (error) {
        console.error('Erro durante a extração:', error);
        return {
            results: [],
            total: 0,
            page: page,
            totalPages: 0,
            error: error.message
        };
    } finally {
        await browser.close();
    }
}

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

  const result = await extractPlacesFromGoogle(searchTerm, page);
  
  // Armazena os resultados em cache
  searchCache.set(searchKey, result.results);
  
  // Retorna a primeira página
  return res.json(result.results);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
