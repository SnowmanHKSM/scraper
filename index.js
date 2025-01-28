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
    
    const results = [];
    
    // Pega todos os elementos da lista
    const elements = await page.$$('.Nv2PK');
    
    // Processa cada elemento
    for (let i = 0; i < elements.length; i++) {
      try {
        const el = elements[i];
        
        // Scroll para o elemento
        await el.evaluate(e => e.scrollIntoView());
        await page.waitForTimeout(500);
        
        // Nome do estabelecimento
        const name = await el.$eval('.qBF1Pd', el => el.textContent.trim())
          .catch(() => "Nome não encontrado");
        
        // Clica no elemento para abrir os detalhes
        await el.click();
        await page.waitForTimeout(2000);
        
        // Endereço
        const address = await page.$eval('button[data-item-id*="address"]', el => el.textContent.trim())
          .catch(() => "Endereço não encontrado");
        
        // Telefone
        const phone = await page.$eval('button[data-item-id*="phone"]', el => {
          return el.textContent.trim()
            .replace(/^\+55\s*/, '')
            .replace(/[\(\)]/g, '');
        }).catch(() => "Telefone não encontrado");
        
        // Website
        const website = await page.$eval('a[aria-label*="Visitar site"], a[aria-label*="Visit site"]', el => el.href)
          .catch(() => "Site não encontrado");
        
        // Avaliação
        const rating = await el.$eval('.MW4etd', el => el.textContent.trim())
          .catch(() => "Sem avaliação");
        
        // Número de avaliações
        const reviews = await el.$eval('.UY7F9', el => el.textContent.replace(/[()]/g, "").trim())
          .catch(() => "0");
        
        // Horário
        const hours = await page.$eval('button[data-item-id*="oh"]', el => {
          return el.textContent.trim()
            .split('·')[0]
            .replace(/\s+•\s+/g, ' ')
            .replace(/\s+⋅\s+/g, ' ');
        }).catch(() => "Horário não disponível");
        
        // Volta para a lista
        await page.click('button[jsaction*="pane.place.backToList"]')
          .catch(() => console.log('Erro ao voltar para a lista'));
        
        await page.waitForTimeout(1000);
        
        // Adiciona o resultado
        results.push({
          name,
          address,
          phone,
          website,
          rating,
          reviews,
          hours
        });
        
        logWithTime(`Processado item ${i + 1} de ${elements.length}: ${name}`);
        
      } catch (error) {
        console.error('Erro ao processar item:', error);
        continue;
      }
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
