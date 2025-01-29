FROM ghcr.io/puppeteer/puppeteer:21.7.0

# Troca para root para instalar as dependências
USER root

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Copia e instala dependências
COPY package*.json ./
RUN npm install

# Copia o resto dos arquivos
COPY . .

# Ajusta permissões
RUN chown -R pptruser:pptruser /app

# Volta para o usuário não-root
USER pptruser

EXPOSE 8080

CMD ["node", "index.js"]
