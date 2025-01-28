const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// Função para timestamp
function getTimestamp() {
  return new Date().toLocaleTimeString("pt-BR");
}

// Log com timestamp
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
    logWithTime(`Iniciando busca por: ${searchTerm}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR", "--start-maximized"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`, {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector('div[role="feed"]');
    const scrollableDiv = await page.$('div[role="feed"]');
    let previousResultsCount = 0;
    let maxAttempts = 10;
    let attempts = 0;

    while (attempts < maxAttempts) {
      await page.evaluate((div) => div.scrollTo(0, div.scrollHeight), scrollableDiv);
      await new Promise((resolve) => setTimeout(resolve, 3000)); // Substituição do waitForTimeout

      const currentResultsCount = await page.evaluate(
        () => document.querySelectorAll("div.Nv2PK").length
      );

      console.log(`Resultados encontrados após rolagem ${attempts + 1}: ${currentResultsCount}`);

      if (currentResultsCount === previousResultsCount) break;
      previousResultsCount = currentResultsCount;
      attempts++;
    }

    console.log(`Total final de resultados encontrados: ${previousResultsCount}`);

    const results = await page.evaluate(() => {
      const listings = document.querySelectorAll("div.Nv2PK");
      return Array.from(listings).map((listing) => {
        const name = listing.querySelector(".qBF1Pd")?.textContent.trim() || "Nome não disponível";
        const rating =
          listing.querySelector(".MW4etd")?.textContent.trim() || "Avaliação não disponível";
        const reviews =
          listing.querySelector(".UY7F9")?.textContent.trim() || "Sem avaliações";

        const address = listing
          .querySelector('button[data-item-id="address"]')
          ?.getAttribute("aria-label")
          ?.replace(/^Endereço:\s*/, "")
          ?.trim() || "Endereço não disponível";

        const phone = listing
          .querySelector('button[data-item-id="phone"]')
          ?.getAttribute("aria-label")
          ?.replace(/^Telefone:\s*/, "")
          ?.trim() || "Telefone não disponível";

        const website = listing
          .querySelector('a[href^="http"][aria-label^="Visitar site"]')
          ?.href || "Site não disponível";

        return { name, rating, reviews, address, phone, website };
      });
    });

    logWithTime("Busca finalizada.");
    await browser.close();

    res.json({ term: searchTerm, total: results.length, results });
  } catch (error) {
    console.error("Erro ao realizar a pesquisa:", error);
    res.status(500).json({ error: "Erro ao realizar a pesquisa.", message: error.message });
  }
});

// Inicializa o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("----------------------------------------");
  logWithTime(`Servidor iniciado na porta ${PORT}`);
  logWithTime("Sistema pronto para buscas!");
  console.log("----------------------------------------");
});
