const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Configuração CORS
app.use(cors({
  origin: '*',
  methods: '*',
  allowedHeaders: '*'
}));

// Configuração do proxy
const proxy = createProxyMiddleware({
  target: 'http://localhost:3001', // porta interna do scraper
  changeOrigin: true,
  ws: true,
  pathRewrite: {
    '^/': '/'
  },
  onError: (err, req, res) => {
    console.error('Erro no proxy:', err);
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });
    res.end('Algo deu errado no proxy: ' + err.message);
  }
});

app.use('/', proxy);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy rodando na porta ${PORT}`);
});
