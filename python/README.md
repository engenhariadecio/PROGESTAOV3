# IA da câmera — treino

`treinar.py` ajusta um YOLOv8n (partindo de `pesos/yolov8n-oiv7.pt`, Open Images) para as
caixas/peças marcadas no painel e exporta um ONNX que o aparelho roda localmente.

O servidor chama este script sozinho (botão **Treinar IA** no painel das câmeras).
Para isso o servidor precisa de Python 3 com os pacotes de `requirements.txt`:

```bash
pip3 install -r python/requirements-local.txt
```

No Railway o `Dockerfile` da raiz já instala tudo. Se preferir sem Docker, remova o
Dockerfile: o sistema roda normalmente, só o treino fica indisponível (o painel avisa).
Variável opcional: `PYTHON_BIN` (padrão `python3`).

Treino típico: 20–30 quadros marcados, 40 passadas, 416 px → 5–15 min em CPU, ~1,5 GB de RAM.
