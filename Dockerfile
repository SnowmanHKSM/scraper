FROM node:18-slim

# Instalar dependências do sistema necessárias para o Puppeteer e Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxss1 \
    libgtk-3-0 \
    libxshmfence1 \
    libglu1 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    chromium \
    chromium-sandbox && \
    rm -rf /var/lib/apt/lists/*

# Variáveis de ambiente para o Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=8080

# Configurar diretório de trabalho
WORKDIR /app

# Copiar package.json e package-lock.json primeiro
COPY package*.json ./

# Instalar dependências do Node.js
RUN npm install

# Copiar o resto dos arquivos do projeto
COPY . .

# Expor a porta do servidor
EXPOSE 8080

# Comando de inicialização
CMD ["node", "index.js"]
