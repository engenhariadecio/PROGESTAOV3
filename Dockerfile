# Node (sistema) + Python (treino da IA da câmera). O railway.json manda o Railway usar este arquivo.
# Feito para nunca derrubar o deploy: se a parte do Python/IA falhar, o sistema sobe igual
# (só o botão "Treinar IA" avisa que o treino não está disponível).
FROM node:20-bookworm-slim

ENV PIP_DEFAULT_TIMEOUT=180 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) sistema (Node)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 2) treino da IA (opcional). PyTorch só de CPU — a versão de placa de vídeo ocuparia ~3 GB a mais.
RUN ( pip3 install --break-system-packages --index-url https://download.pytorch.org/whl/cpu torch torchvision \
   && pip3 install --break-system-packages "ultralytics>=8.3" "onnx>=1.16" "onnxruntime>=1.17" \
   && echo "IA: treino instalado" ) \
 || echo "AVISO: treino da IA não foi instalado — o sistema funciona normalmente sem ele"

# 3) código
COPY . .
# peso de partida do treino de contorno (~7 MB) — baixado aqui para não precisar ficar no GitHub
RUN python3 python/pesos_ia.py || echo "AVISO: peso da IA não baixado agora — será baixado no 1º treino"
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
