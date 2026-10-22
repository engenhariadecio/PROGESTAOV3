#!/usr/bin/env python3
"""
Treina a IA de uma câmera a partir das amostras marcadas no painel.

  python3 treinar.py --dados PASTA --saida modelo.onnx [--modo det|cls] [--epocas 40] [--imgsz 416] [--zona x,y,w,h]

modo det (contar peças): PASTA/images/*.jpg + PASTA/labels/*.txt (YOLO, classe 0 = objeto).
  Parte dos pesos yolov8n-oiv7 (Open Images, já conhece "Box") e ajusta para as caixas desta linha.
modo cls (pallet vazio × com peças): PASTA/vazio/*.jpg + PASTA/com_pecas/*.jpg.
  Parte dos pesos yolov8n-cls. Com --zona, recorta a área do pallet de cada imagem antes (o aparelho
  faz o mesmo recorte na hora de classificar).
Imprime "PROGRESSO n/total" e, no fim, "METRICAS {json}" — o servidor acompanha por aí.
"""
import argparse, json, os, sys, shutil, glob

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dados', required=True); ap.add_argument('--saida', required=True)
    ap.add_argument('--modo', default='det', choices=['det', 'cls'])
    ap.add_argument('--base', default=None)
    ap.add_argument('--epocas', type=int, default=40); ap.add_argument('--imgsz', type=int, default=416)
    ap.add_argument('--batch', type=int, default=8); ap.add_argument('--zona', default=None)
    ap.add_argument('--classes', default='objeto', help='det: nomes das classes na ordem dos índices (ex.: caixa,peca,pallet)')
    a = ap.parse_args()
    pesos = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pesos')
    if not a.base: a.base = os.path.join(pesos, 'yolov8n-cls.pt' if a.modo == 'cls' else 'yolov8n-oiv7.pt')

    try:
        from ultralytics import YOLO
    except ImportError:
        print('ERRO ultralytics não instalado (pip install -r python/requirements.txt)'); sys.exit(2)

    run_dir = os.path.join(a.dados, 'run'); shutil.rmtree(run_dir, ignore_errors=True)
    total = a.epocas
    def on_epoch_end(trainer): print(f'PROGRESSO {trainer.epoch + 1}/{total}', flush=True)
    aug = dict(hsv_h=0.01, hsv_s=0.4, hsv_v=0.4, degrees=3, translate=0.08, scale=0.25, fliplr=0.5)
    met = {}

    if a.modo == 'det':
        imgs = sorted(glob.glob(os.path.join(a.dados, 'images', '*.jpg')))
        if len(imgs) < 3: print('ERRO poucas amostras (mínimo 3 quadros marcados)'); sys.exit(3)
        yaml = os.path.join(a.dados, 'data.yaml')
        nomes = [c.strip() for c in a.classes.split(',') if c.strip()]
        with open(yaml, 'w') as f: f.write(f"path: {os.path.abspath(a.dados)}\ntrain: images\nval: images\nnames:\n" + ''.join(f"  {i}: {n}\n" for i, n in enumerate(nomes)))
        model = YOLO(a.base); model.add_callback('on_train_epoch_end', on_epoch_end)
        model.train(data=yaml, epochs=a.epocas, imgsz=a.imgsz, batch=a.batch, device='cpu', workers=0, project=run_dir, name='t', exist_ok=True,
                    verbose=False, plots=False, val=True, pretrained=True, patience=0, close_mosaic=max(1, a.epocas // 4), mosaic=1.0, **aug)
        best = os.path.join(run_dir, 't', 'weights', 'best.pt')
        if not os.path.exists(best): best = os.path.join(run_dir, 't', 'weights', 'last.pt')
        m = YOLO(best)
        try:
            r = m.val(data=yaml, imgsz=a.imgsz, device='cpu', workers=0, plots=False, verbose=False)
            met = {'map50': round(float(r.box.map50), 3), 'map': round(float(r.box.map), 3), 'precisao': round(float(r.box.mp), 3), 'recall': round(float(r.box.mr), 3)}
        except Exception as e: met = {'erro_val': str(e)[:200]}
        met['imagens'] = len(imgs); met['classes'] = nomes
        try: met['por_classe'] = { nomes[int(c)]: round(float(v), 3) for c, v in zip(r.box.ap_class_index, r.box.ap50) }
        except Exception: pass
    else:
        # classificação: recorta a área do pallet (se informada) e monta train/val com as duas classes
        from PIL import Image
        zona = [float(v) for v in a.zona.split(',')] if a.zona else None
        ds = os.path.join(a.dados, 'cls'); shutil.rmtree(ds, ignore_errors=True)
        n = 0
        for classe in ('vazio', 'com_pecas'):
            for split in ('train', 'val'): os.makedirs(os.path.join(ds, split, classe), exist_ok=True)
            for f in sorted(glob.glob(os.path.join(a.dados, classe, '*.jpg'))):
                im = Image.open(f).convert('RGB')
                if zona:
                    W, H = im.size; x, y, w, h = zona
                    im = im.crop((int(x * W), int(y * H), int((x + w) * W), int((y + h) * H)))
                im = im.resize((a.imgsz, a.imgsz))   # quadrado esticado: igual ao que o aparelho faz na hora de classificar
                for split in ('train', 'val'): im.save(os.path.join(ds, split, classe, os.path.basename(f)), quality=92)
                n += 1
        for classe in ('vazio', 'com_pecas'):
            if len(glob.glob(os.path.join(ds, 'train', classe, '*.jpg'))) < 3:
                print(f'ERRO poucas amostras da classe "{classe}" (mínimo 3 de cada)'); sys.exit(3)
        model = YOLO(a.base); model.add_callback('on_train_epoch_end', on_epoch_end)
        model.train(data=ds, epochs=a.epocas, imgsz=a.imgsz, batch=a.batch, device='cpu', workers=0, project=run_dir, name='t', exist_ok=True,
                    verbose=False, plots=False, val=True, pretrained=True, patience=0, erasing=0.0, auto_augment=None, **aug)
        best = os.path.join(run_dir, 't', 'weights', 'best.pt')
        if not os.path.exists(best): best = os.path.join(run_dir, 't', 'weights', 'last.pt')
        m = YOLO(best)
        try:
            r = m.val(data=ds, imgsz=a.imgsz, device='cpu', workers=0, plots=False, verbose=False)
            met = {'acerto': round(float(r.top1), 3)}
        except Exception as e: met = {'erro_val': str(e)[:200]}
        met['imagens'] = n; met['classes'] = ['com_pecas', 'vazio'] if sorted(['vazio', 'com_pecas'])[0] == 'com_pecas' else ['vazio', 'com_pecas']
        met['classes'] = sorted(['vazio', 'com_pecas'])   # ultralytics ordena as pastas: ['com_pecas', 'vazio']
        met['zona'] = zona

    onnx = m.export(format='onnx', imgsz=a.imgsz, opset=12, simplify=False, dynamic=False, device='cpu')
    shutil.copy(onnx, a.saida)
    met['imgsz'] = a.imgsz; met['epocas'] = a.epocas; met['modo'] = a.modo
    print('METRICAS ' + json.dumps(met), flush=True)

if __name__ == '__main__':
    main()
