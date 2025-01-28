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

        // Telefone - Nova implementação
        let phone = "Telefone não encontrado";
        const phoneButton = el.querySelector('button[data-item-id^="phone"]');
        if (phoneButton) {
          const phoneText = phoneButton.getAttribute("aria-label");
          if (phoneText) {
            phone = phoneText.replace(/^Telefone:\s*/, "").trim();
            
            // Se encontrou o telefone, formata ele
            if (phone !== "Telefone não encontrado") {
              const numbers = phone.replace(/[^\d]/g, '');
              if (numbers.length >= 10) {
                const formatted = numbers.replace(/^(?!55)/, '55')
                                       .replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '+55 $1 $2-$3');
                if (formatted.length >= 16) {
                  phone = formatted;
                }
              }
            }
          }
        }

        // Se não encontrou pelo método principal, tenta pelos métodos alternativos
        if (phone === "Telefone não encontrado") {
          const phoneElements = [
            ...el.querySelectorAll('button[data-tooltip*="Ligar"]'),
            ...el.querySelectorAll('button[aria-label*="telefone"]'),
            ...el.querySelectorAll('[data-item-id*="phone"]')
          ];

          for (const phoneEl of phoneElements) {
            let phoneText = phoneEl.getAttribute('aria-label') || 
                           phoneEl.getAttribute('data-item-id') || 
                           phoneEl.textContent;
            
            if (phoneText) {
              const numbers = phoneText.replace(/[^\d]/g, '');
              if (numbers.length >= 10) {
                const formatted = numbers.replace(/^(?!55)/, '55')
                                       .replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '+55 $1 $2-$3');
                if (formatted.length >= 16) {
                  phone = formatted;
                  break;
                }
              }
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