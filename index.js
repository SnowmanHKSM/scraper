const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// Função para formatar timestamp
function getTimestamp() {
  return new Date().toLocaleTimeString('pt-BR');
}

// Função para log com timestamp
function logWithTime(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

// Rota raiz
app.get("/", (req, res) => {
  res.send("Bem vindo ao Scraper Google Maps");
});

// Rota de busca no Google Maps
app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  try {
    logWithTime(`Iniciando nova busca por: ${searchTerm}`);
    logWithTime("Iniciando navegador...");
    
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080'
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Configura o cabeçalho de idioma
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9",
    });

    console.log(`Pesquisando: ${searchTerm}`);

    // Gera a URL de pesquisa do Google Maps
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle0" });

    // Aguarda o carregamento dos resultados
    await page.waitForSelector(".Nv2PK", { timeout: 30000 });

    // Função para contar resultados atuais
    const countResults = async () => {
      return await page.evaluate(() => {
        return document.querySelectorAll(".Nv2PK").length;
      });
    };

    // Função para rolar a página
    async function scrollPage() {
      await page.evaluate(() => {
        const container = document.querySelector('div[role="feed"]');
        if (container) {
          const scrollHeight = container.scrollHeight;
          container.scrollTo(0, scrollHeight);
        }
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Sistema de rolagem melhorado
    let previousResultCount = 0;
    let sameCountTimes = 0;
    let maxScrolls = 50; // Aumentamos o limite de rolagens
    let currentScroll = 0;

    console.log("Iniciando captura de resultados...");

    while (currentScroll < maxScrolls) {
      currentScroll++;
      await scrollPage();
      
      const currentResultCount = await countResults();
      console.log(`Rolagem ${currentScroll}/${maxScrolls} - Resultados encontrados: ${currentResultCount}`);

      // Se o número de resultados não aumentou
      if (currentResultCount === previousResultCount) {
        sameCountTimes++;
        // Se ficou 3 vezes sem aumentar, provavelmente chegamos ao fim
        if (sameCountTimes >= 3) {
          console.log("Número de resultados estabilizou, parando a busca...");
          break;
        }
      } else {
        sameCountTimes = 0; // Reseta o contador se encontrou novos resultados
      }

      previousResultCount = currentResultCount;
      
      // Pequena pausa extra a cada 10 rolagens para garantir carregamento
      if (currentScroll % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    logWithTime(`Iniciando extração de dados de ${previousResultCount} resultados...`);
    
    // Extrair os dados dos resultados
    const results = [];
    const elements = await page.$$('.Nv2PK');
    
    // Processa todos os elementos em lotes
    const batchSize = 5; // Processa 5 elementos por vez
    
    for (let i = 0; i < elements.length; i += batchSize) {
      const batch = elements.slice(i, i + batchSize);
      logWithTime(`Processando lote ${Math.floor(i/batchSize) + 1}/${Math.ceil(elements.length/batchSize)}`);
      
      // Processa o lote em paralelo
      const batchResults = await Promise.all(
        batch.map(async (el) => {
          try {
            // Nome
            const name = await el.$eval("h3.fontHeadlineSmall, .qBF1Pd", e => e ? e.textContent.trim() : "Nome não encontrado");
            
            // Endereço
            const address = await el.$eval('button[data-item-id*="address"], div[class*="fontBodyMedium"]', e => {
              const fullText = e.textContent.trim();
              const parts = fullText.split(/(?:Fechado|Aberto|⋅)/);
              if (parts.length > 0) {
                return parts[0].replace(/^.*?(?=R\.|Av\.|Rua|Alameda|Travessa|Praça)/i, '')
                  .replace(/Barbearia/g, '')
                  .replace(/\d+,\d+\(\d+\)/g, '')
                  .replace(/·/g, '')
                  .replace(/\s+/g, ' ')
                  .trim();
              }
              return "Endereço não encontrado";
            });

            // Telefone - Tenta pegar direto da lista primeiro
            let phone = "Telefone não encontrado";
            try {
              // Tenta pegar o telefone diretamente da lista
              const directPhone = await el.$eval('[data-tooltip*="Copiar número"], [aria-label*="Telefone"], [data-item-id*="phone"], .rogA2c', e => {
                const tooltip = e.getAttribute('data-tooltip');
                if (tooltip && tooltip.includes('Copiar número')) {
                  return tooltip.replace('Copiar número de telefone: ', '').trim();
                }
                
                const ariaLabel = e.getAttribute('aria-label');
                if (ariaLabel && (ariaLabel.includes('Telefone') || ariaLabel.includes('telefone'))) {
                  return ariaLabel.replace(/Telefone:?\s*/i, '').trim();
                }
                
                const itemId = e.getAttribute('data-item-id');
                if (itemId && itemId.includes('phone:tel:')) {
                  return itemId.split('phone:tel:')[1].trim();
                }
                
                return e.textContent.trim();
              }).catch(() => null);

              if (directPhone) {
                phone = directPhone;
              } else {
                // Se não achou direto, tenta abrir o painel
                await el.click();
                await page.waitForSelector('div[role="dialog"]', { timeout: 2000 });
                
                // Tenta pegar o telefone do painel
                const panelPhone = await page.$eval('button[data-tooltip*="Copiar número"], button[aria-label*="Telefone"], button[data-item-id*="phone"], .rogA2c', e => {
                  const tooltip = e.getAttribute('data-tooltip');
                  if (tooltip && tooltip.includes('Copiar número')) {
                    return tooltip.replace('Copiar número de telefone: ', '').trim();
                  }
                  
                  const ariaLabel = e.getAttribute('aria-label');
                  if (ariaLabel && (ariaLabel.includes('Telefone') || ariaLabel.includes('telefone'))) {
                    return ariaLabel.replace(/Telefone:?\s*/i, '').trim();
                  }
                  
                  const itemId = e.getAttribute('data-item-id');
                  if (itemId && itemId.includes('phone:tel:')) {
                    return itemId.split('phone:tel:')[1].trim();
                  }
                  
                  return e.textContent.trim();
                }).catch(() => null);

                if (panelPhone) {
                  phone = panelPhone;
                }

                // Fecha o painel
                await page.keyboard.press('Escape');
              }

              // Se encontrou um número, formata ele
              if (phone && phone !== "Telefone não encontrado") {
                const numbers = phone.replace(/[^\d+]/g, '');
                if (numbers.length >= 8) {
                  phone = numbers.replace(/^(?!55|\+55)/, '55')
                               .replace(/^(?!\+)/, '+')
                               .replace(/^(\+55)(\d{2})(\d{4,5})(\d{4})$/, '$1 $2 $3-$4');
                }
              }
            } catch (error) {
              console.error('Erro ao pegar telefone:', error);
              phone = "Telefone não encontrado";
            }

            // Website
            const website = await el.$eval('a[data-item-id*="authority"], a[data-item-id*="website"], button[data-item-id*="authority"], a[href*="http"]:not([href*="google"])', e => {
              const href = e.getAttribute('href') || e.getAttribute('data-url') || e.getAttribute('data-item-id');
              if (href && !href.includes('google.com') && !href.includes('maps.google') && !href.includes('search?')) {
                return href.split('?')[0].trim();
              }
              return "Site não encontrado";
            }).catch(() => "Site não encontrado");

            return {
              name: name.replace(/\s+/g, ' ').trim(),
              address: address.replace(/\s+/g, ' ').trim(),
              phone,
              website
            };
          } catch (error) {
            console.error('Erro ao processar resultado:', error);
            return null;
          }
        })
      );
      
      // Adiciona os resultados válidos do lote
      results.push(...batchResults.filter(r => r !== null));
      
      // Pequena pausa entre os lotes
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await browser.close();
    logWithTime("Navegador fechado com sucesso");

    // Retorna os resultados como JSON
    logWithTime(`Busca finalizada! ${results.length} resultados encontrados`);
    logWithTime("Sistema pronto para nova busca!");
    console.log("----------------------------------------");
    
    return res.json({
      term: searchTerm,
      total: results.length,
      results,
    });
  } catch (error) {
    console.error("Erro ao realizar a pesquisa:", error);
    logWithTime("Ocorreu um erro durante a busca!");
    logWithTime("Sistema pronto para nova busca!");
    console.log("----------------------------------------");
    
    return res.status(500).json({ 
      error: "Erro ao realizar a pesquisa.",
      message: error.message 
    });
  }
});

// Inicializar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("----------------------------------------");
  logWithTime(`Servidor iniciado na porta ${PORT}`);
  logWithTime("Sistema pronto para buscas!");
  console.log("----------------------------------------");
});