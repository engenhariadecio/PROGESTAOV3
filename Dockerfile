# Node (sistema) + Python (treino da IA da câmera). O railway.json manda o Railway usar este arquivo.
# Feito para nunca derrubar o deploy: se a parte do Python/IA falhar, o sistema sobe igual
# (só o botão "Treinar IA" avisa que o treino não está disponível).
FROM node:20-bookworm-slim

ENV PIP_DEFAULT_TIMEOUT=180 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) sistema (Node)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 2) treino da IA (opcional), num ambiente Python separado (/opt/ia): instalar direto no Python do
#    Debian ("--break-system-packages") pode falhar ao tentar trocar pacotes do sistema.
#    PyTorch só de CPU — a versão de placa de vídeo ocuparia ~3 GB a mais.
ENV PYTHON_BIN=/opt/ia/bin/python
RUN ( python3 -m venv /opt/ia \
   && /opt/ia/bin/pip install --upgrade pip \
   && /opt/ia/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
   && /opt/ia/bin/pip install "ultralytics>=8.3" "onnx>=1.16" "onnxruntime>=1.17" \
   && /opt/ia/bin/python -c "import ultralytics, onnx, onnxruntime; print('IA: treino instalado — ultralytics', ultralytics.__version__)" ) \
 || echo "AVISO: treino da IA não foi instalado — o sistema funciona normalmente sem ele (veja o erro acima)"

# 3) código
COPY . .
# peso de partida do treino de contorno (~7 MB) — baixado aqui para não precisar ficar no GitHub
RUN python3 python/pesos_ia.py || echo "AVISO: peso da IA não baixado agora — será baixado no 1º treino"
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
