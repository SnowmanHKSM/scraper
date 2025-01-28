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
    
    for (const el of elements) {
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
        }).catch(() => "Endereço não encontrado");

        // Telefone - Clicando no item
        let phone = "Telefone não encontrado";
        try {
          // Clica no item
          await el.click();
          
          // Aguarda o painel lateral aparecer
          const panel = await page.waitForSelector('div[role="dialog"]', { timeout: 5000 });
          if (panel) {
            // Aguarda o botão do telefone dentro do painel
            await page.waitForSelector('div[role="dialog"] button[data-item-id*="phone"]', { timeout: 5000 });
            
            // Procura o telefone especificamente dentro do painel aberto
            const phoneElement = await panel.$('button[data-item-id*="phone"]');
            if (phoneElement) {
              const phoneData = await phoneElement.evaluate(e => ({
                itemId: e.getAttribute('data-item-id'),
                ariaLabel: e.getAttribute('aria-label'),
                text: e.textContent.trim()
              }));
              
              if (phoneData.itemId && phoneData.itemId.includes('phone:tel:')) {
                phone = phoneData.itemId.split('phone:tel:')[1];
              } else if (phoneData.ariaLabel && phoneData.ariaLabel.toLowerCase().includes('phone:')) {
                phone = phoneData.ariaLabel.split(':')[1].trim();
              } else {
                phone = phoneData.text;
              }
            }
          }
          
          // Volta para a lista
          await page.keyboard.press('Escape');
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Erro ao pegar telefone:', error);
        }

        // Website
        const website = await el.$eval('a[data-item-id*="authority"], a[data-item-id*="website"], button[data-item-id*="authority"], a[href*="http"]:not([href*="google"])', e => {
          const href = e.getAttribute('href') || e.getAttribute('data-url') || e.getAttribute('data-item-id');
          if (href && !href.includes('google.com') && !href.includes('maps.google') && !href.includes('search?')) {
            return href.split('?')[0].trim();
          }
          return "Site não encontrado";
        }).catch(() => "Site não encontrado");

        results.push({
          name: name.replace(/\s+/g, ' ').trim(),
          address: address.replace(/\s+/g, ' ').trim(),
          phone,
          website
        });
      } catch (error) {
        console.error('Erro ao processar item:', error);
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