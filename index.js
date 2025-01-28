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
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--lang=pt-BR",
        "--start-maximized"
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
        const name = el.querySelector(".qBF1Pd")?.textContent.trim() || "Nome não encontrado";
        
        // Endereço - procura especificamente pelo endereço
        let address = "Endereço não encontrado";
        const addressElements = Array.from(el.querySelectorAll('.W4Efsd'));
        for (const element of addressElements) {
          const text = element.textContent.trim();
          // Procura por padrões típicos de endereço (rua, avenida, etc)
          if (text.match(/^(R\.|Rua|Av\.|Avenida|Al\.|Alameda|Rod\.|Rodovia|Travessa|Praça)/i)) {
            address = text;
            break;
          }
        }
        
        // Telefone - procura especificamente por padrões de telefone
        let phone = "Telefone não encontrado";
        const phoneElements = Array.from(el.querySelectorAll('button[data-tooltip], .W4Efsd'));
        for (const element of phoneElements) {
          const text = element.textContent.trim();
          // Procura por padrões de telefone ((51), +55, etc)
          if (text.match(/(\+55|^\(\d{2}\)|\d{2})\s?\d{4,5}-?\d{4}/)) {
            phone = text.match(/(\+55|^\(\d{2}\)|\d{2})\s?\d{4,5}-?\d{4}/)[0];
            break;
          }
        }
        
        // Site
        let website = "Site não encontrado";
        const websiteElement = el.querySelector('a[data-tooltip*="site"]') || 
                             el.querySelector('a[data-item-id*="authority"]') ||
                             el.querySelector('a[href*="http"]');
        if (websiteElement && websiteElement.href) {
          website = websiteElement.href;
        }
        
        // Avaliação
        const rating = el.querySelector(".MW4etd")?.textContent.trim() || "Sem avaliação";
        
        // Número de avaliações
        const reviews = el.querySelector(".UY7F9")?.textContent.replace(/[()]/g, "").trim() || "0";

        // Horário de funcionamento
        let hours = "Horário não disponível";
        const hoursElements = Array.from(el.querySelectorAll('.W4Efsd, [data-tooltip]'));
        for (const element of hoursElements) {
          const text = element.textContent.trim();
          if (text.match(/(Aberto|Fechado|Fecha|Abre)\s/i)) {
            hours = text;
            break;
          }
        }

        return {
          name,
          address,
          phone,
          website,
          rating,
          reviews,
          hours
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
