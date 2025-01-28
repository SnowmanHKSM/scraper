const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

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
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: "/usr/bin/google-chrome", // Caminho para o Chrome instalado
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--lang=pt-BR", // Define o idioma do navegador como português
      ],
    });

    const page = await browser.newPage();

    // Configura o cabeçalho de idioma
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9",
    });

    // Gera a URL de pesquisa do Google Maps
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    await page.goto(url, { waitUntil: "networkidle2" });

    console.log(`Pesquisando: ${searchTerm}`);

    // Seletor para os resultados
    const resultsSelector = `[aria-label="Resultados para ${searchTerm}"]`;
    await page.waitForSelector(resultsSelector, { timeout: 60000 }); // Aumenta o tempo limite para o carregamento

    // Rolar a página até carregar todos os resultados
    let previousHeight;
    while (true) {
      const resultDiv = await page.$(resultsSelector);
      previousHeight = await page.evaluate((el) => el.scrollHeight, resultDiv);
      await page.evaluate((el) => el.scrollBy(0, el.scrollHeight), resultDiv);
      await new Promise((resolve) => setTimeout(resolve, 6000)); // Aguarda 6 segundos entre as rolagens
      const newHeight = await page.evaluate((el) => el.scrollHeight, resultDiv);
      if (newHeight === previousHeight) break; // Sai do loop se não houver mais resultados
    }

    // Extrair informações dos resultados
    const results = await page.evaluate(() => {
      const listings = document.querySelectorAll("div.Nv2PK");
      return Array.from(listings).map((listing) => {
        // Nome do local
        const name = listing.querySelector(".qBF1Pd")?.textContent.trim() || "Nome não disponível";

        // Avaliação
        const rating = listing.querySelector(".MW4etd")?.textContent.trim() || "Sem avaliação";

        // Número de avaliações
        const reviews = listing.querySelector(".UY7F9")?.textContent.trim() || "Sem avaliações";

        // Endereço
        const address = listing
          .querySelector('button[data-item-id="address"]')
          ?.getAttribute("aria-label")
          ?.replace(/^Endereço:\s*/, "")
          ?.trim() || "Endereço não disponível";

        // Telefone
        const phone = listing
          .querySelector('button[data-item-id="phone"]')
          ?.getAttribute("aria-label")
          ?.replace(/^Telefone:\s*/, "")
          ?.trim() || "Telefone não disponível";

        // Website
        const website = listing
          .querySelector('a[href^="http"][aria-label^="Visitar site"]')
          ?.href || "Site não disponível";

        return { name, rating, reviews, address, phone, website };
      });
    });

    await browser.close();

    // Retorna os resultados como JSON
    return res.json({
      term: searchTerm,
      total: results.length,
      results,
    });
  } catch (error) {
    console.error("Erro ao realizar a pesquisa:", error);
    return res.status(500).json({ error: "Erro ao realizar a pesquisa." });
  }
});

// Inicializar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
