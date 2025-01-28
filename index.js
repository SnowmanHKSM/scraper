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
    
    async function scrapeGoogleMaps(searchTerm) {
      let browser;
      try {
        // Configurações do navegador
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080'
          ]
        });

        const page = await browser.newPage();
        
        // Configurações da página
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        // Configura o cabeçalho de idioma
        await page.setExtraHTTPHeaders({
          "Accept-Language": "pt-BR,pt;q=0.9",
        });

        // Gera a URL de pesquisa do Google Maps
        const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
        
        console.log('Navegando para:', url);
        
        // Aumenta o timeout para 30 segundos e adiciona opções de navegação
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: 30000
        });

        // Aguarda um pouco para garantir que a página carregou completamente
        await page.waitForTimeout(2000);

        console.log('Aguardando resultados...');
        
        // Aguarda elementos específicos da página do Google Maps
        await page.waitForSelector('.Nv2PK', { timeout: 30000 });

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
        const results = await page.evaluate(() => {
          const elements = document.querySelectorAll(".Nv2PK");
          return Array.from(elements).map((el) => {
            // Nome do estabelecimento
            const nameElement = el.querySelector("h3.fontHeadlineSmall, .qBF1Pd");
            const name = nameElement ? nameElement.textContent.trim() : "Nome não encontrado";

            // Endereço - Limpando e organizando
            let address = "Endereço não encontrado";
            const addressElement = el.querySelector('button[data-item-id*="address"], div[class*="fontBodyMedium"]');
            if (addressElement) {
              const fullText = addressElement.textContent.trim();
              // Separando o endereço das informações adicionais
              const parts = fullText.split(/(?:Fechado|Aberto|⋅)/);
              if (parts.length > 0) {
                // Remove nome do estabelecimento e informações extras
                address = parts[0].replace(/^.*?(?=R\.|Av\.|Rua|Alameda|Travessa|Praça)/i, '')
                  .replace(/Barbearia/g, '')
                  .replace(/\d+,\d+\(\d+\)/g, '')  // Remove avaliações (ex: 4,8(271))
                  .replace(/·/g, '')
                  .replace(/\s+/g, ' ')
                  .trim();
              }
            }

            // Telefone - Usando data-item-id com phone:tel
            let phone = "Telefone não encontrado";
            const phoneButton = el.querySelector('button[data-item-id*="phone:tel"]');
            if (phoneButton) {
              const phoneId = phoneButton.getAttribute('data-item-id');
              if (phoneId) {
                const phoneNumber = phoneId.split('phone:tel:')[1];
                if (phoneNumber) {
                  phone = phoneNumber;
                }
              }
            }

            // Website - Melhorando a captura
            let website = "Site não encontrado";
            const websiteElements = [
              ...el.querySelectorAll('a[data-item-id*="authority"]'),
              ...el.querySelectorAll('a[data-item-id*="website"]'),
              ...el.querySelectorAll('button[data-item-id*="authority"]'),
              ...el.querySelectorAll('a[href*="http"]:not([href*="google"])')
            ];
            
            for (const element of websiteElements) {
              const href = element.getAttribute('href') || 
                          element.getAttribute('data-url') || 
                          element.getAttribute('data-item-id');
              
              if (href && 
                  !href.includes('google.com') && 
                  !href.includes('maps.google') &&
                  !href.includes('search?')) {
                website = href.split('?')[0].trim();
                break;
              }
            }

            // Retorna os dados organizados
            return {
              name: name.replace(/\s+/g, ' ').trim(),
              address: address.replace(/\s+/g, ' ').trim(),
              phone,
              website: website.replace(/\s+/g, ' ').trim()
            };
          });
        });

        await browser.close();
        logWithTime("Navegador fechado com sucesso");

        // Retorna os resultados como JSON
        logWithTime(`Busca finalizada! ${results.length} resultados encontrados`);
        logWithTime("Sistema pronto para nova busca!");
        console.log("----------------------------------------");
        
        return { results };
      } catch (error) {
        console.error('Erro durante a execução:', error);
        return { error: error.message };
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (error) {
            console.error('Erro ao fechar o navegador:', error);
          }
        }
      }
    }

    const result = await scrapeGoogleMaps(searchTerm);
    if (result.error) {
      return res.status(500).json({ 
        error: "Erro ao realizar a pesquisa.",
        message: result.error 
      });
    }

    return res.json({
      term: searchTerm,
      total: result.results.length,
      results: result.results,
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
