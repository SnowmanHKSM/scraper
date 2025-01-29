FROM ghcr.io/puppeteer/puppeteer:21.7.0

# Troca para root para instalar as dependências
USER root

# Remove arquivos de lista duplicados do Google
RUN rm -f /etc/apt/sources.list.d/google-chrome.list \
    /etc/apt/sources.list.d/google.list

# Adiciona a chave do Google e configura o repositório
RUN apt-get update && apt-get install -y wget gnupg2 \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list

# Instala dependências necessárias
RUN apt-get update && apt-get install -y \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    DISPLAY=:99

WORKDIR /app

# Copia e instala dependências
COPY package*.json ./
RUN npm install

# Copia o resto dos arquivos
COPY . .

# Ajusta permissões
RUN chown -R pptruser:pptruser /app

# Script de inicialização
COPY <<EOF /app/start.sh
#!/bin/bash
Xvfb :99 -screen 0 1920x1080x24 > /dev/null 2>&1 &
node index.js
EOF

RUN chmod +x /app/start.sh

# Volta para o usuário não-root
USER pptruser

EXPOSE 8080

CMD ["/app/start.sh"]
