#!/usr/bin/env python3
"""
Pesos (pontos de partida) da IA — baixados sozinhos na 1ª vez, para o GitHub não precisar guardá-los.

  python3 pesos_ia.py              baixa o peso do treino de contorno (yolov8n-seg.pt, ~7 MB)
  python3 pesos_ia.py --todos      baixa todos (seg, det, cls e o de sugestão, ~43 MB)

Usado por treinar.py e sugerir.py: peso('yolov8n-seg.pt') devolve o caminho em python/pesos/,
baixando de github.com/ultralytics/assets se ainda não existir. Se não tiver internet, devolve só
o nome e o próprio ultralytics tenta baixar.
"""
import os, sys, shutil, urllib.request

PASTA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pesos')
URL = 'https://github.com/ultralytics/assets/releases/download/v8.3.0/'
TODOS = ['yolov8n-seg.pt', 'yolov8n-oiv7.pt', 'yolov8n-cls.pt', 'yolov8s-oiv7.pt']

def peso(nome):
    destino = os.path.join(PASTA, nome)
    if os.path.exists(destino) and os.path.getsize(destino) > 100000: return destino
    os.makedirs(PASTA, exist_ok=True)
    tmp = destino + '.baixando'
    try:
        print(f'Baixando o peso {nome}…', file=sys.stderr, flush=True)
        with urllib.request.urlopen(URL + nome, timeout=120) as r, open(tmp, 'wb') as f: shutil.copyfileobj(r, f)
        os.replace(tmp, destino)
        return destino
    except Exception as e:
        print(f'AVISO: não consegui baixar {nome} ({e}); o ultralytics vai tentar sozinho.', file=sys.stderr, flush=True)
        try: os.remove(tmp)
        except OSError: pass
        return nome

if __name__ == '__main__':
    for n in (TODOS if '--todos' in sys.argv else ['yolov8n-seg.pt']):
        print(n, '→', peso(n))
