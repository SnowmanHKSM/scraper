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
    const resultsSelector = "div.Nv2PK";
    await page.waitForSelector(resultsSelector, { timeout: 60000 }); // Aumenta o tempo limite para o carregamento

    // Rolar a página até carregar todos os resultados
    let previousHeight;
    while (true) {
      previousHeight = await page.evaluate("document.body.scrollHeight");
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Aguarda 2 segundos entre as rolagens
      const newHeight = await page.evaluate("document.body.scrollHeight");
      if (newHeight === previousHeight) break; // Sai do loop se não houver mais resultados
    }

    // Extrair os dados dos resultados
    const results = await page.evaluate(() => {
      const elements = document.querySelectorAll("div.Nv2PK");
      return Array.from(elements).map((el) => {
        const name = el.querySelector(".qBF1Pd")?.textContent || "Nome não encontrado";
        const address = el.querySelector("button[data-item-id='address']")?.textContent || "Endereço não encontrado";
        const phone = el.querySelector("button[data-item-id='phone']")?.textContent || "Telefone não encontrado";
        const website = el.querySelector("a[data-value='Website']")?.href || "Site não encontrado";
        const rating = el.querySelector(".MW4etd")?.textContent || "Avaliação não encontrada";
        const reviews = el.querySelector(".UY7F9")?.textContent || "Nenhuma avaliação";

        return { name, address, phone, website, rating, reviews };
      });
    });

    await browser.close();

    // Retorna os resultados como JSON
    return res.json({
      term: searchTerm,
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
