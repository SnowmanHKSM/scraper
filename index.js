const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// Função para formatar timestamp
function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
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

    // Sistema de rolagem melhorado
    async function scrollPage() {
      await page.evaluate(() => {
        const container = document.querySelector('div[role="feed"]');
        if (container) {
          const scrollHeight = container.scrollHeight;
          container.scrollTo(0, scrollHeight);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    let previousResultCount = 0;
    let sameCountTimes = 0;
    let maxScrolls = 50;
    let currentScroll = 0;

    console.log("Iniciando captura de resultados...");

    while (currentScroll < maxScrolls) {
      currentScroll++;
      await scrollPage();

      const currentResultCount = await page.evaluate(() => {
        return document.querySelectorAll(".Nv2PK").length;
      });
      console.log(`Rolagem ${currentScroll}/${maxScrolls} - Resultados encontrados: ${currentResultCount}`);

      if (currentResultCount === previousResultCount) {
        sameCountTimes++;
        if (sameCountTimes >= 3) {
          console.log("Número de resultados estabilizou, parando a busca...");
          break;
        }
      } else {
        sameCountTimes = 0;
      }
      previousResultCount = currentResultCount;
    }

    logWithTime(`Iniciando extração de dados de ${previousResultCount} resultados...`);

    // Extrair os dados dos resultados
    const results = await page.evaluate(() => {
      const elements = document.querySelectorAll(".Nv2PK");
      return Array.from(elements).map((el) => {
        const nameElement = el.querySelector("h3.fontHeadlineSmall, .qBF1Pd");
        const name = nameElement ? nameElement.textContent.trim() : "Nome não encontrado";

        let address = "Endereço não encontrado";
        const addressElement = el.querySelector('button[data-item-id*="address"]');
        if (addressElement) {
          const addressText = addressElement.getAttribute("aria-label");
          address = addressText ? addressText.replace(/^Endereço:\s*/, "").trim() : address;
        }

        // Captura do telefone
        let phone = "Telefone não encontrado";
        const phoneButton = el.querySelector('button[data-item-id^="phone:tel:"]');
        if (phoneButton) {
          const phoneText = phoneButton.getAttribute("data-item-id").replace(/^phone:tel:/, "").trim();
          phone = phoneText.replace(/^55/, "+55 "); // Formata telefone com código do Brasil
        }

        // Captura do website
        let website = "Site não encontrado";
        const websiteElement = el.querySelector('a[href^="http"][aria-label^="Visitar site"]');
        if (websiteElement) {
          website = websiteElement.href.trim();
        }

        return { name, address, phone, website };
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
      message: error.message,
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
