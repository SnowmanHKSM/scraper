FROM ghcr.io/puppeteer/puppeteer:21.7.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Copiando arquivos de dependências
COPY package*.json ./

# Instalando dependências com --unsafe-perm
RUN npm install --unsafe-perm=true

# Copiando resto dos arquivos
COPY . .

# Ajustando permissões
RUN chown -R pptruser:pptruser /app

# Trocando para usuário não-root
USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]
