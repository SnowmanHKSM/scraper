const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;

// Configurações para aumentar o timeout
const SERVER_TIMEOUT = 25 * 60 * 1000; // 25 minutos

// Variáveis globais para o navegador e página
let globalBrowser = null;
let isSearching = false;

// Função para inicializar o navegador
async function initBrowser() {
  if (!globalBrowser) {
    logWithTime("Iniciando navegador...");
    globalBrowser = await puppeteer.launch({
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
  }
  return globalBrowser;
}

// Função para limpar recursos
async function cleanup() {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
    } catch (error) {
      logWithTime(`Erro ao fechar navegador: ${error.message}`);
    }
    globalBrowser = null;
  }
  isSearching = false;
}

// Configurar limpeza ao encerrar
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

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

// Função para rolar a página automaticamente
async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) {
        const previousHeight = feed.scrollHeight;
        feed.scrollTo({
          top: feed.scrollHeight,
          behavior: 'smooth'
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
        return { previousHeight, success: true };
      }
      return { success: false };
    });
    
    await sleep(2000); // Espera adicional após a rolagem
  } catch (error) {
    logWithTime(`Erro ao rolar página: ${error.message}`);
    return { success: false };
  }
}

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

// Rota de status para healthcheck
app.get("/status", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    browserActive: !!globalBrowser,
    isSearching: isSearching
  });
});

app.get("/search", async (req, res) => {
  if (isSearching) {
    return res.status(429).json({ error: "Já existe uma busca em andamento. Tente novamente em alguns minutos." });
  }

  const searchTerm = req.query.term;
  const maxResults = parseInt(req.query.max) || 100;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  // Enviar cabeçalho inicial para manter a conexão viva
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Transfer-Encoding': 'chunked',
    'Connection': 'keep-alive'
  });

  isSearching = true;
  let page;

  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    
    const browser = await initBrowser();
    page = await browser.newPage();
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

    const processedCards = new Set(); // Conjunto para controlar cards já processados
    const results = [];
    let totalScrolls = 0;
    let lastResultsCount = 0;
    let sameResultsCount = 0;
    
    while (results.length < maxResults && totalScrolls < 20 && sameResultsCount < 3) {
      // Espera os cards carregarem
      await page.waitForSelector(global.CARD_SELECTOR, { timeout: 10000 });
      
      // Pega todos os cards visíveis
      const cards = await page.$$(global.CARD_SELECTOR);
      logWithTime(`Encontrados ${cards.length} cards visíveis`);
      
      // Processa cada card
      for (const card of cards) {
        try {
          // Extrai o identificador único do card (pode ser nome + endereço)
          const nameElement = await card.$('h3.fontHeadlineLarge');
          const addressElement = await card.$('div[aria-label^="Endereço"]');
          
          const name = nameElement ? await nameElement.evaluate(el => el.textContent) : 'Nome não encontrado';
          const address = addressElement ? await addressElement.evaluate(el => el.textContent) : 'Endereço não encontrado';
          
          const cardId = `${name}|${address}`;
          
          // Verifica se já processamos este card
          if (processedCards.has(cardId)) {
            continue; // Pula para o próximo card
          }
          
          // Marca o card como processado
          processedCards.add(cardId);
          
          // Clica no card para abrir os detalhes
          await card.click();
          await sleep(RATE_LIMIT_DELAY);
          
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

          if (details.name !== "Nome não encontrado") {
            results.push(details);
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
      
      if (results.length === lastResultsCount) {
        sameResultsCount++;
      } else {
        sameResultsCount = 0;
      }
      
      lastResultsCount = results.length;
      
      // Faz rolagem apenas se não atingiu o máximo de resultados
      if (results.length < maxResults) {
        totalScrolls++;
        logWithTime(`Rolagem ${totalScrolls}`);
        await autoScroll(page);
        await sleep(RATE_LIMIT_DELAY);
      }
    }

    logWithTime(`Busca finalizada. Total de resultados: ${results.length}`);
    isSearching = false;
    return res.end(JSON.stringify({
      total: results.length,
      results: results
    }));

  } catch (error) {
    logWithTime(`Erro durante a execução: ${error.message}`);
    isSearching = false;
    
    if (page) {
      try {
        await page.close();
      } catch (e) {
        logWithTime(`Erro ao fechar página: ${e.message}`);
      }
    }
    
    // Se os headers ainda não foram enviados, envia uma resposta de erro
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message });
    } else {
      // Se os headers já foram enviados, termina a resposta com o erro
      return res.end(JSON.stringify({ error: error.message }));
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        logWithTime(`Erro ao fechar página: ${e.message}`);
      }
    }
  }
});

// Rota para reiniciar o navegador se necessário
app.post("/reset", async (req, res) => {
  try {
    await cleanup();
    await initBrowser();
    res.json({ status: "ok", message: "Navegador reiniciado com sucesso" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inicia o servidor apenas se o arquivo for executado diretamente
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const HOST = '0.0.0.0';
  
  const server = app.listen(PORT, HOST, async () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT}`);
    console.log(`Para fazer uma busca, acesse: http://${HOST}:${PORT}/search?term=sua+busca`);
    
    // Inicializa o navegador ao iniciar o servidor
    try {
      await initBrowser();
      console.log('Navegador inicializado com sucesso');
    } catch (error) {
      console.error('Erro ao inicializar navegador:', error);
    }
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
