const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// Rota raiz
app.get("/", (req, res) => {
  res.send("Bem-vindo ao Scraper Google Maps");
});

// Rota de busca no Google Maps
app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--lang=pt-BR",
      ],
    });

    const page = await browser.newPage();

    // Configura cabeçalhos de idioma
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9",
    });

    // Gera a URL de pesquisa
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    console.log(`Pesquisando: ${searchTerm}`);

    // Melhor seletor para os resultados
    const resultSelector = "div.Nv2PK";
    await page.waitForSelector(resultSelector, { timeout: 120000 }); // Aumenta o limite para 120 segundos

    // Armazenar os resultados
    let allResults = [];

    // Rolar a página para capturar todos os resultados
    let previousHeight = 0;
    while (true) {
      const results = await page.evaluate(() => {
        const elements = document.querySelectorAll("div.Nv2PK");
        return Array.from(elements).map((el) => {
          const name = el.querySelector(".qBF1Pd")?.textContent || "Nome não encontrado";
          const rating = el.querySelector(".MW4etd")?.textContent || "Avaliação não encontrada";
          const reviews = el.querySelector(".UY7F9")?.textContent || "Não disponível";

          const addressButton = document.evaluate(
            "//button[contains(@data-item-id, 'address')]",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          const address = addressButton?.textContent || "Endereço não encontrado";

          const phoneButton = document.evaluate(
            "//button[contains(@data-item-id, 'phone')]",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          const phone = phoneButton?.textContent || "Telefone não encontrado";

          const websiteLink = document.evaluate(
            "//a[contains(@aria-label, 'Visitar site') or contains(@aria-label, 'Visit site')]",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          const website = websiteLink?.href || "Site não encontrado";

          return { name, rating, reviews, address, phone, website };
        });
      });

      allResults = [...allResults, ...results];

      // Rola a página para carregar mais resultados
      previousHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise((resolve) => setTimeout(resolve, 3000)); // Aguarda 3 segundos
      const newHeight = await page.evaluate(() => document.body.scrollHeight);

      if (newHeight === previousHeight) break; // Para se não houver mais resultados
    }

    await browser.close();

    // Retorna os resultados
    return res.json({
      term: searchTerm,
      results: allResults,
    });
  } catch (error) {
    console.error("Erro ao realizar a pesquisa:", error);
    return res.status(500).json({ error: "Erro ao realizar a pesquisa." });
  }
});

// Inicializar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
