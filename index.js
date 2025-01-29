const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require('axios');
puppeteer.use(StealthPlugin());

const app = express();
const RATE_LIMIT_DELAY = 2000;
const MAX_RETRIES = 3;

// URL do webhook do n8n
const N8N_WEBHOOK_URL = 'https://primary-production-270f.up.railway.app/webhook-test/da3a1250-7da8-4193-9e05-3c7e9bc45ba9';

function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
}

function logWithTime(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendResultsToN8N(results, searchTerm, scrollNumber, isLastBatch) {
  try {
    await axios.post(N8N_WEBHOOK_URL, {
      searchTerm,
      scrollNumber,
      results,
      isLastBatch,
      totalResults: results.length,
      timestamp: new Date().toISOString()
    });
    logWithTime(`Lote #${scrollNumber} com ${results.length} resultados enviado para n8n`);
    return true;
  } catch (error) {
    logWithTime(`Erro ao enviar lote #${scrollNumber} para n8n: ${error.message}`);
    // Tenta novamente após um breve delay
    await sleep(2000);
    try {
      await axios.post(N8N_WEBHOOK_URL, {
        searchTerm,
        scrollNumber,
        results,
        isLastBatch,
        totalResults: results.length,
        timestamp: new Date().toISOString()
      });
      logWithTime(`Lote #${scrollNumber} enviado com sucesso na segunda tentativa`);
      return true;
    } catch (retryError) {
      logWithTime(`Falha definitiva ao enviar lote #${scrollNumber}: ${retryError.message}`);
      return false;
    }
  }
}

app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;
  const maxResults = parseInt(req.query.max) || 100;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  // Responde imediatamente que começou o scraping
  res.json({ 
    status: "started", 
    message: `Iniciando scraping para: ${searchTerm}. Os resultados serão enviados via webhook.` 
  });

  let browser;
  const allResults = [];
  let processedItems = new Set();
  let currentScrollResults = [];
  let scrollNumber = 0;

  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    logWithTime("Iniciando navegador...");

    browser = await puppeteer.launch({
      headless: false,
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
    let currentBatch = [];

    async function processVisibleCards() {
      try {
        await page.waitForSelector(global.CARD_SELECTOR, { timeout: 5000 });
        
        const cards = await page.$$(global.CARD_SELECTOR);
        logWithTime(`Encontrados ${cards.length} cards visíveis`);

        let processedCount = 0;
        let seenCards = new Set(); // Para evitar processar o mesmo card mais de uma vez

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

            if (!cardId || processedItems.has(cardId) || seenCards.has(cardId)) {
              continue;
            }

            seenCards.add(cardId);

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

            // Verifica se o resultado já existe antes de adicionar
            const isDuplicate = results.some(result => {
              // Compara nome E endereço para ter certeza que é o mesmo estabelecimento
              return (
                result.name === details.name &&
                result.address === details.address
              );
            });

            if (!isDuplicate && details.name !== "Nome não encontrado") {
              currentScrollResults.push(details);
              allResults.push(details);
              processedItems.add(cardId);
              processedCount++;
              logWithTime(`Dados capturados: ${JSON.stringify(details)}`);
            } else {
              logWithTime(`Item duplicado ignorado: ${details.name}`);
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

        // Após processar todos os cards visíveis, envia os resultados desta rolagem
        if (currentScrollResults.length > 0) {
          scrollNumber++;
          const isLastBatch = !hasMoreResults || allResults.length >= maxResults;
          const sent = await sendResultsToN8N(currentScrollResults, searchTerm, scrollNumber, isLastBatch);
          if (!sent) {
            logWithTime(`Não foi possível enviar o lote #${scrollNumber}. Continuando...`);
          }
          currentScrollResults = []; // Limpa para a próxima rolagem
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

    logWithTime(`Busca finalizada. Total de resultados: ${allResults.length}`);
    await browser.close();
    logWithTime("Navegador fechado com sucesso");

  } catch (error) {
    logWithTime(`Erro durante a execução: ${error.message}`);
    if (browser) {
      await browser.close();
      logWithTime("Navegador fechado após erro");
    }
    // Não precisa retornar erro pois já respondemos no início
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Para fazer uma busca, acesse: http://localhost:${PORT}/search?term=sua+busca`);
});
