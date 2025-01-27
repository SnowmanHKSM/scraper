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
    const resultSelector = ".Nv2PK.THOPZb.cqNgl.Hk4XGb"; // Seleciona cada bloco de resultados
    await page.waitForSelector(resultSelector, { timeout: 60000 }); // Aguarda o carregamento inicial

    // Extrair informações dos resultados
    const results = await page.evaluate(() => {
      const elements = document.querySelectorAll(".Nv2PK.THOPZb.cqNgl.Hk4XGb");
      return Array.from(elements).map((el) => {
        const name = el.querySelector(".qBF1Pd.fontHeadlineSmall")?.textContent || "Nome não encontrado";
        const address = el.querySelector(".W4Efsd")?.textContent || "Endereço não encontrado";
        const phone = el.querySelector("[data-tooltip='Copiar número de telefone']")?.textContent || "Telefone não encontrado";
        const website = el.querySelector("[data-value='Website']")?.href || "Site não encontrado";

        return { name, address, phone, website };
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
