const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

// URL do webhook no Railway
const N8N_WEBHOOK = 'https://scraper-production-87ef.up.railway.app/webhook/places';
const BATCH_SIZE = 10;

async function sendToN8N(batch, query, batchNumber) {
  try {
    await axios.post(N8N_WEBHOOK, {
      query,
      batchNumber,
      results: batch,
      timestamp: new Date().toISOString()
    });
    console.log(`[${new Date().toLocaleTimeString()}] Lote ${batchNumber} enviado para n8n (${batch.length} resultados)`);
  } catch (error) {
    console.error(`Erro ao enviar lote ${batchNumber} para n8n:`, error.message);
  }
}

app.get('/', (req, res) => {
  res.send('Google Maps Scraper - Use /search?term=sua+busca');
});

app.get('/search', async (req, res) => {
  const query = req.query.term;
  
  if (!query) {
    return res.status(400).json({ error: 'Termo de busca é obrigatório' });
  }

  console.log(`[${new Date().toLocaleTimeString()}] Buscando: ${query}`);
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1920x1080',
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    
    let currentBatch = [];
    let batchNumber = 1;
    let totalResults = 0;
    let lastResultsCount = 0;
    let noNewResultsCount = 0;
    
    // Função para extrair e enviar resultados
    const extractAndSendResults = async () => {
      const newResults = await page.evaluate(() => {
        const places = [];
        const items = document.querySelectorAll('a[href^="https://www.google.com/maps/place"]');
        
        items.forEach(item => {
          try {
            const titleEl = item.querySelector('div[class] div[class] div[class] div[class]:first-child');
            const ratingEl = item.querySelector('span[aria-label*="classificação"]');
            const addressEl = item.querySelector('div[class] div[class] div[class] div[class]:nth-child(2)');
            
            if (titleEl) {
              const title = titleEl.textContent.trim();
              const rating = ratingEl ? ratingEl.getAttribute('aria-label') : '';
              const address = addressEl ? addressEl.textContent.trim() : '';
              
              places.push({
                title,
                rating: rating ? rating.replace('classificação:', '').trim() : 'Sem avaliação',
                address: address || 'Endereço não disponível'
              });
            }
          } catch (err) {
            console.error('Erro ao extrair item:', err);
          }
        });
        
        return places;
      });

      // Filtra resultados duplicados
      const uniqueResults = newResults.filter(result => 
        !currentBatch.some(existing => existing.title === result.title)
      );

      // Adiciona novos resultados ao lote atual
      currentBatch.push(...uniqueResults);

      // Se temos um lote completo, envia para o n8n
      while (currentBatch.length >= BATCH_SIZE) {
        const batchToSend = currentBatch.splice(0, BATCH_SIZE);
        await sendToN8N(batchToSend, query, batchNumber++);
        totalResults += batchToSend.length;
      }

      return uniqueResults.length;
    };

    // Loop principal de scraping
    while (noNewResultsCount < 3) { // Para após 3 tentativas sem novos resultados
      // Extrai e envia resultados atuais
      const newResultsCount = await extractAndSendResults();
      
      if (newResultsCount === 0) {
        noNewResultsCount++;
      } else {
        noNewResultsCount = 0;
      }

      // Rola a página para carregar mais resultados
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollTop = feed.scrollHeight;
        }
      });

      // Aguarda carregamento de novos resultados
      await page.waitForTimeout(2000);
    }

    // Envia o último lote (mesmo que incompleto)
    if (currentBatch.length > 0) {
      await sendToN8N(currentBatch, query, batchNumber);
      totalResults += currentBatch.length;
    }

    console.log(`[${new Date().toLocaleTimeString()}] Busca finalizada. Total enviado: ${totalResults} resultados`);
    
    return res.json({
      success: true,
      totalResults,
      batches: batchNumber,
      message: `Resultados enviados em ${batchNumber} lotes para o n8n`
    });

  } catch (error) {
    console.error('Erro:', error);
    return res.status(500).json({ 
      error: 'Erro ao buscar resultados',
      details: error.message 
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
