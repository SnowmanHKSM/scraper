#!/bin/bash

# Inicia o servidor principal em background
node index.js &

# Espera 2 segundos para o servidor iniciar
sleep 2

# Inicia o proxy
node proxy.js
