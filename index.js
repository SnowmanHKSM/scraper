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
    const results = await page.evaluate(() => {
      const elements = document.querySelectorAll(".Nv2PK");
      return Array.from(elements).map((el) => {
        // Nome do estabelecimento
        const name = el.querySelector(".qBF1Pd")?.textContent.trim()
          .replace(/\s+/g, ' ') || "Nome não encontrado";
        
        // Endereço - procura pelo botão que contém o endereço
        let address = "Endereço não encontrado";
        const addressButton = el.querySelector('button[data-item-id*="address"]');
        if (addressButton) {
          const addressDiv = addressButton.querySelector('.Io6YTe');
          if (addressDiv) {
            address = addressDiv.textContent.trim()
              .replace(/^(Barbearia|Barber\s*Shop|Salão)[\s·]*/, '')
              .replace(/·/g, '')
              .replace(/\s+/g, ' ')
              .trim();
          }
        }

        // Telefone - usando o seletor data-item-id específico para telefone
        let phone = "Telefone não encontrado";
        const phoneButton = el.querySelector('button[data-item-id*="phone:tel"]');
        if (phoneButton) {
          const phoneDiv = phoneButton.querySelector('.Io6YTe');
          if (phoneDiv) {
            const phoneText = phoneDiv.textContent.trim();
            if (phoneText) {
              // Limpa e formata o número
              const cleanPhone = phoneText
                .replace(/[^\d]/g, '')  // Remove tudo exceto números
                .replace(/^(?!55)/, '55');  // Adiciona 55 se não existir
              
              // Formata como +55 DD XXXX-XXXX
              if (cleanPhone.length >= 11) {
                const parts = [
                  '+' + cleanPhone.slice(0, 2),  // +55
                  cleanPhone.slice(2, 4),        // DDD
                  cleanPhone.slice(4, 8),        // Primeira parte
                  cleanPhone.slice(8, 12)        // Segunda parte
                ];
                phone = `${parts[0]} ${parts[1]} ${parts[2]}-${parts[3]}`;
              }
            }
          }
        }

        // Website - procura primeiro pelo botão específico do website
        let website = "Site não encontrado";
        const websiteButton = el.querySelector('button[data-item-id*="authority"]');
        if (websiteButton) {
          const websiteDiv = websiteButton.querySelector('.Io6YTe');
          if (websiteDiv) {
            website = websiteDiv.textContent.trim();
          }
        }

        // Se não encontrou pelo botão, procura por links
        if (website === "Site não encontrado") {
          const links = el.querySelectorAll('a[data-item-id*="website"], a[href*="http"]');
          for (const link of links) {
            const href = link.getAttribute('href');
            if (href && 
                !href.includes('google.com') && 
                !href.includes('maps.google') &&
                !href.includes('search?')) {
              website = href.split('?')[0];
              break;
            }
          }
        }

        return {
          name,
          address,
          phone,
          website
        };
      });
    });

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
