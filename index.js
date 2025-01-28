app.get("/search", async (req, res) => {
  const searchTerm = req.query.term;

  if (!searchTerm) {
    return res.status(400).json({ error: "O parâmetro 'term' é obrigatório." });
  }

  try {
    console.log(`[${getTimestamp()}] Iniciando busca por: ${searchTerm}`);

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
      await page.waitForTimeout(3000);

      const currentResultsCount = await page.evaluate(
        () => document.querySelectorAll("div.Nv2PK").length
      );

      console.log(`Resultados encontrados após rolagem ${attempts + 1}: ${currentResultsCount}`);

      if (currentResultsCount === previousResultsCount) break;
      previousResultsCount = currentResultsCount;
      attempts++;
    }

    console.log(`Total final de resultados encontrados: ${previousResultsCount}`);

    // Coleta os dados detalhados
    const results = await page.$$eval("div.Nv2PK", async (listings) => {
      const resultList = [];

      for (let listing of listings) {
        try {
          listing.scrollIntoView({ behavior: "smooth", block: "center" });

          // Extrai detalhes do elemento atual
          const name = listing.querySelector(".qBF1Pd")?.textContent.trim() || "Nome não disponível";
          const rating =
            listing.querySelector(".MW4etd")?.textContent.trim() || "Avaliação não disponível";
          const reviews =
            listing.querySelector(".UY7F9")?.textContent.trim() || "Sem avaliações";

          // Clique para abrir os detalhes
          listing.click();
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const address = document
            .querySelector('button[data-item-id="address"]')
            ?.getAttribute("aria-label")
            ?.replace(/^Endereço:\s*/, "")
            ?.trim() || "Endereço não disponível";

          const phone = document
            .querySelector('button[data-item-id="phone"]')
            ?.getAttribute("aria-label")
            ?.replace(/^Telefone:\s*/, "")
            ?.trim() || "Telefone não disponível";

          const website = document
            .querySelector('a[href^="http"][aria-label^="Visitar site"]')
            ?.href || "Site não disponível";

          resultList.push({ name, rating, reviews, address, phone, website });

          // Volta à lista
          const backButton = document.querySelector('button[jsaction="pane.place.backToList"]');
          if (backButton) backButton.click();

          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (e) {
          console.error(`Erro ao processar um item: ${e}`);
          continue;
        }
      }

      return resultList;
    });

    console.log(`[${getTimestamp()}] Busca concluída. Resultados extraídos: ${results.length}`);
    await browser.close();

    res.json({
      term: searchTerm,
      total: results.length,
      results,
    });
  } catch (error) {
    console.error("Erro ao realizar a pesquisa:", error);
    res.status(500).json({ error: "Erro ao realizar a pesquisa.", message: error.message });
  }
});
