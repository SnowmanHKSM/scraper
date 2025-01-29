const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cors = require('cors');
const https = require('https');
puppeteer.use(StealthPlugin());

// Configurar agent HTTPS com SSL flexível
const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 3000000,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 3000000
});

const app = express();

// Tratamento especial para OPTIONS
app.options('*', cors());

// Configurações CORS mais permissivas
app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: '*',
  exposedHeaders: '*',
  credentials: true,
  maxAge: 86400,
  preflightContinue: true
}));

// Parser para JSON com limite aumentado
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configurações
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;
const TIMEOUT = 45 * 60 * 1000; // 45 minutos em milissegundos

// Configurar headers padrão
app.use((req, res, next) => {
  // Headers para manter a conexão viva
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=2700000');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  // Remover headers de segurança restritivos
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Strict-Transport-Security');
  res.removeHeader('X-Content-Type-Options');
  
  // Configurar timeout da resposta
  res.setTimeout(TIMEOUT, () => {
    logWithTime('Requisição ainda em processamento...');
  });
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
}

function logWithTime(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Função para normalizar strings para comparação
function normalizeString(str) {
  return str.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Função para verificar se um resultado é duplicado
function isDuplicate(newResult, existingResults) {
  const normalizedNewName = normalizeString(newResult.name);
  const normalizedNewAddress = normalizeString(newResult.address);

  return existingResults.some(result => {
    const normalizedName = normalizeString(result.name);
    const normalizedAddress = normalizeString(result.address);

    return normalizedName === normalizedNewName || 
           normalizedAddress === normalizedNewAddress;
  });
}

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

// Rota de health check para o Railway
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
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
      headless: "new",
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
    // Configurar timeout da página
    await page.setDefaultNavigationTimeout(TIMEOUT);
    await page.setDefaultTimeout(TIMEOUT);
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9',
    });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2" });
    
    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        // Tenta diferentes seletores que podem indicar que os resultados carregaram
        const selectors = [
          'div[role="article"]',
          '.Nv2PK',
          'a[href^="https://www.google.com/maps/place"]',
          'div[jsaction*="mouseover:pane.proxy"]'
        ];
        
        for (const selector of selectors) {
          try {
            await page.waitForSelector(selector, { timeout: 10000 });
            logWithTime(`Resultados encontrados usando seletor: ${selector}`);
            // Se encontrou um seletor válido, ajusta o seletor global
            global.CARD_SELECTOR = selector;
            break;
          } catch (e) {
            continue;
          }
        }
        
        if (!global.CARD_SELECTOR) {
          throw new Error("Nenhum seletor válido encontrado");
        }
        
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
      try {
        await page.waitForSelector(global.CARD_SELECTOR, { timeout: 5000 });
        
        const cards = await page.$$(global.CARD_SELECTOR);
        logWithTime(`Encontrados ${cards.length} cards visíveis`);

        let processedCount = 0;

        for (let i = 0; i < cards.length && results.length < maxResults; i++) {
          try {
            const isValid = await page.evaluate(card => {
              return card.isConnected && document.contains(card);
            }, cards[i]).catch(() => false);

            if (!isValid) {
              continue;
            }

            // Tenta diferentes maneiras de obter o ID do card
            const cardId = await page.evaluate(card => {
              const nameElement = card.querySelector('div[role="heading"]') || 
                                card.querySelector('.qBF1Pd') ||
                                card.querySelector('.fontHeadlineSmall');
              return nameElement ? nameElement.textContent : null;
            }, cards[i]);

            if (!cardId || processedItems.has(cardId)) {
              continue;
            }

            // Tenta diferentes maneiras de clicar no card
            try {
              await cards[i].click();
            } catch (clickError) {
              // Se falhar, tenta clicar usando JavaScript
              await page.evaluate(card => {
                card.click();
              }, cards[i]);
            }
            
            await sleep(2000);

            const details = await page.evaluate(() => {
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

            if (details.name !== "Nome não encontrado" && !isDuplicate(details, results)) {
              results.push(details);
              processedItems.add(cardId);
              processedCount++;
              logWithTime(`Dados capturados: ${JSON.stringify(details)}`);
            }

            try {
              await page.keyboard.press('Escape');
              await sleep(1000);
            } catch (navError) {
              logWithTime(`Erro ao navegar de volta: ${navError.message}`);
              await page.reload({ waitUntil: "networkidle2" });
              await page.waitForSelector(global.CARD_SELECTOR, { timeout: 5000 });
            }

            await sleep(RATE_LIMIT_DELAY);
          } catch (cardError) {
            logWithTime(`Erro ao processar card: ${cardError.message}`);
            continue;
          }
        }

        return processedCount;
      } catch (error) {
        logWithTime(`Erro ao processar cards: ${error.message}`);
        return 0;
      }
    }

    async function scrollPage() {
      try {
        const scrollResult = await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) {
            const previousHeight = feed.scrollHeight;
            feed.scrollTo({
              top: feed.scrollHeight,
              behavior: 'smooth'
            });
            return { previousHeight, success: true };
          }
          return { success: false };
        });
        
        await sleep(2000);
        return scrollResult;
      } catch (error) {
        logWithTime(`Erro ao rolar página: ${error.message}`);
        return { success: false };
      }
    }

    // Loop principal: rola e processa
    let totalProcessed = 0;
    const maxScrolls = 20;

    for (let scrollCount = 0; scrollCount < maxScrolls && results.length < maxResults; scrollCount++) {
      logWithTime(`Rolagem ${scrollCount + 1}`);
      const scrollResult = await scrollPage();

      if (!scrollResult.success) {
        logWithTime("Feed não encontrado. Tentando novamente...");
        await sleep(3000);
        continue;
      }

      await sleep(5000); // Espera mais tempo após a rolagem

      const processedNow = await processVisibleCards();
      if (processedNow) totalProcessed += processedNow;

      if (results.length >= maxResults) {
        logWithTime("Limite máximo de resultados atingido.");
        break;
      }

      // Verifica se há mais resultados para carregar
      const currentCardCount = await page.$$(global.CARD_SELECTOR);
      if (currentCardCount.length === 0) {
        logWithTime("Nenhum resultado encontrado. Finalizando.");
        break;
      }

      // Tenta clicar no botão "Ver mais resultados" se existir
      try {
        const moreResultsButton = await page.$('button[jsaction*="pane.paginationSection.nextPage"]');
        if (moreResultsButton) {
          logWithTime("Clicando em 'Ver mais resultados'...");
          await moreResultsButton.click();
          await sleep(3000);
          continue;
        }
      } catch (error) {
        // Ignora erro se não encontrar o botão
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

// Inicia o servidor
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Para fazer uma busca, acesse: http://localhost:${PORT}/search?term=sua+busca`);
});

// Configurar timeout do servidor
server.timeout = TIMEOUT;
server.keepAliveTimeout = 3000000; // 50 minutos
server.headersTimeout = 3100000; // 51 minutos e 40 segundos

// Tratamento de erros do servidor
server.on('error', (error) => {
  console.error('Erro no servidor:', error);
});

// Tratamento de encerramento gracioso
process.on('SIGTERM', async () => {
  console.log('Recebido sinal SIGTERM. Encerrando graciosamente...');
  if (browser) {
    await browser.close();
  }
  server.close(() => {
    console.log('Servidor encerrado');
    process.exit(0);
  });
});

// Exporta o app para testes
module.exports = app;
