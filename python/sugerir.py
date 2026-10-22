#!/usr/bin/env python3
"""
Sugere as marcações (peça / pallet) numa imagem, para o usuário só conferir no painel.

  python3 sugerir.py --imagem foto.jpg [--modelo modelo.onnx --classes peca,pallet --tipo seg] [--conf 0.2]

Sem --modelo usa a IA genérica (yolov8s-oiv7, Open Images): "Box" vira peça (só retângulo).
Com o modelo treinado da câmera, usa as classes dele; se o modelo for de contorno (seg),
devolve também o contorno de cada item.
Imprime uma linha: SUGESTOES [{"x":..,"y":..,"w":..,"h":..,"c":"peca","p":0.8,"pts":[[x,y],...]}, ...]  (0–1)
"""
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--imagem', required=True); ap.add_argument('--modelo', default=None)
    ap.add_argument('--classes', default='peca,pallet'); ap.add_argument('--conf', type=float, default=None)
    ap.add_argument('--tipo', default='det', choices=['det', 'seg'])
    a = ap.parse_args()
    try:
        from ultralytics import YOLO
    except ImportError:
        print('ERRO ultralytics não instalado'); sys.exit(2)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from pesos_ia import peso   # baixa o peso na 1ª vez (não fica no GitHub)
    if a.modelo:
        m = YOLO(a.modelo, task='segment' if a.tipo == 'seg' else 'detect'); nomes = [c.strip() for c in a.classes.split(',')]
        mapa = lambda i, n: ('peca' if nomes[i] == 'caixa' else nomes[i]) if i < len(nomes) else None
        conf = a.conf or 0.3; imgsz = None
    else:
        m = YOLO(peso('yolov8s-oiv7.pt')); conf = a.conf or 0.12; imgsz = 960   # o 's' acha mais caixas que o 'n'
        mapa = lambda i, n: {'Box': 'peca'}.get(n)
    kw = dict(conf=conf, verbose=False, device='cpu')
    if imgsz: kw['imgsz'] = imgsz
    r = m.predict(a.imagem, **kw)[0]
    H, W = r.orig_shape
    polis = None
    try:
        if r.masks is not None: polis = r.masks.xyn   # contornos normalizados (0–1)
    except Exception: polis = None
    out = []
    for k, ((x1, y1, x2, y2), c, p) in enumerate(zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist())):
        nome = mapa(int(c), r.names.get(int(c), '') if isinstance(r.names, dict) else '')
        if not nome: continue
        item = {'x': round(x1 / W, 4), 'y': round(y1 / H, 4), 'w': round((x2 - x1) / W, 4), 'h': round((y2 - y1) / H, 4), 'c': nome, 'p': round(p, 3)}
        if polis is not None and k < len(polis) and len(polis[k]) >= 3:
            pts = polis[k].tolist(); passo = max(1, len(pts) // 40)   # no máx. ~40 pontos
            item['pts'] = [[round(x, 4), round(y, 4)] for x, y in pts[::passo]]
        out.append(item)
    print('SUGESTOES ' + json.dumps(out), flush=True)

if __name__ == '__main__':
    main()
