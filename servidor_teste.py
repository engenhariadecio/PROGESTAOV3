#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor de TESTE da câmera — só Python padrão, sem instalar nada.

    python servidor_teste.py            (sobe em https://localhost:3000 e no IP da rede)

Serve as MESMAS páginas e o MESMO motor de câmera do sistema (pasta public/),
com um servidor mínimo no lugar do Node/Postgres: uma linha fixa "Teste",
contagens e configuração em memória, amostras e modelo em arquivos na pasta
teste_dados/. Serve para testar se a câmera reconhece as caixas/peças.

  - Celular/tablet:  https://IP-DO-PC:3000/cadenciador/camera   (conectar a câmera)
  - PC:              https://IP-DO-PC:3000/cadenciador/painel   (ver ao vivo, marcar área, Ensinar a IA)

Treino da IA: funciona se este Python tiver o ultralytics
(python -m pip install -r python/requirements-local.txt). Sem ele, o botão avisa.
Não tem login nem banco — é só para teste.
"""
import os, sys, json, ssl, time, base64, threading, subprocess, shutil, tempfile, re, socket, mimetypes
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

RAIZ = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(RAIZ, 'public')
DADOS = os.path.join(RAIZ, 'teste_dados'); os.makedirs(os.path.join(DADOS, 'amostras'), exist_ok=True)
PORTA = int(os.environ.get('PORT', '3000'))
try: sys.stdout.reconfigure(encoding='utf-8')
except Exception: pass

# ───────── estado em memória ─────────
LOCK = threading.Lock()
LINHA = { 'id': 1, 'celula': 'Teste', 'produto_id': 1, 'nome': 'Linha de teste', 'ativa': True }
PRODUTOS = [{ 'id': 1, 'nome': 'Produto de teste', 'takt_min': 10, 'celula_nome': 'Teste', 'cod_decio': None, 'ativo': True }]
CLASSES_DET = ['caixa', 'peca', 'pallet']
CLASSES_SEG = ['peca', 'pallet']   # modelo de contorno: caixa conta como peça

def limpar_marc(lista):
    """marcação = {c, x, y, w, h, pts?}; pts = contorno [[x,y],…] (0–1). O retângulo sai do contorno."""
    out = []
    for c in (lista or []):
        if not isinstance(c, dict): continue
        o = { 'c': c.get('c') if c.get('c') in CLASSES_DET else 'peca' }
        pts = [[min(1, max(0, round(float(p[0]), 4))), min(1, max(0, round(float(p[1]), 4)))] for p in (c.get('pts') or [])[:300] if isinstance(p, (list, tuple)) and len(p) >= 2]
        if len(pts) >= 3:
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            o.update(x=min(xs), y=min(ys), w=max(xs) - min(xs), h=max(ys) - min(ys), pts=pts)
        elif all(k in c for k in 'xywh'): o.update(x=float(c['x']), y=float(c['y']), w=float(c['w']), h=float(c['h']))
        else: continue
        if o['w'] > 0.005 and o['h'] > 0.005: out.append(o)
    return out

def linha_seg(c):
    pts = c.get('pts') if c.get('pts') and len(c['pts']) >= 3 else [[c['x'], c['y']], [c['x'] + c['w'], c['y']], [c['x'] + c['w'], c['y'] + c['h']], [c['x'], c['y'] + c['h']]]
    return ('1 ' if c.get('c') == 'pallet' else '0 ') + ' '.join(f"{min(1, max(0, x)):.5f} {min(1, max(0, y)):.5f}" for x, y in pts)
CONFIG_PADRAO = { 'zona': None, 'caixa': None, 'caixa_pos': None, 'sens': 5, 'camera': '', 'zoom': None, 'lanterna': False, 'resolucao': 'media', 'multiplas': False }
CFG_PATH = os.path.join(DADOS, 'config.json')
CONFIG = { **CONFIG_PADRAO, **(json.load(open(CFG_PATH)) if os.path.exists(CFG_PATH) else {}) }
CONFIG_TS = time.time()
QUADRO = { 'buf': None, 'limpo': None, 'ts': 0, 'contagem': 0, 'estado': '', 'resumo': None, 'dispositivo': '', 'capacidades': None }
COMANDOS = []
EVENTOS = []           # {id, ts, origem, valor, mudanca_pct, foto(bytes)}
EV_PATH = os.path.join(DADOS, 'eventos.json')
if os.path.exists(EV_PATH):
    try: EVENTOS = [dict(e, foto=None) for e in json.load(open(EV_PATH))]
    except Exception: EVENTOS = []
AMOSTRAS_PATH = os.path.join(DADOS, 'amostras.json')
AMOSTRAS = json.load(open(AMOSTRAS_PATH)) if os.path.exists(AMOSTRAS_PATH) else []   # {id, produto_id, caixas, created_at}
MODELO_PATH = os.path.join(DADOS, 'modelo.onnx'); MODELO_INFO = os.path.join(DADOS, 'modelo.json')
TREINO = { 'estado': 'nenhum' }
ORIG = { 'ia': 1, 'ia_retirada': -1, 'manual_mais': 1, 'manual_menos': -1, 'troca_pallet': 0, 'estorno': -1 }

def agora_iso(): return time.strftime('%Y-%m-%dT%H:%M:%S') + time.strftime('%z')[:3] + ':' + time.strftime('%z')[3:]
def hoje(): return time.strftime('%Y-%m-%d')
def salvar_amostras(): json.dump(AMOSTRAS, open(AMOSTRAS_PATH, 'w'))
def salvar_eventos(): json.dump([dict(e, foto=None) for e in EVENTOS], open(EV_PATH, 'w'))
def salvar_config(): json.dump(CONFIG, open(CFG_PATH, 'w'))
def b64jpeg(s):
    m = re.match(r'^data:image/jpeg;base64,(.+)$', s or '', re.S)
    if not m: return None
    try: b = base64.b64decode(m.group(1))
    except Exception: return None
    return b if b[:2] == b'\xff\xd8' else None
# biblioteca de modelos: teste_dados/modelos.json + teste_dados/modelos/<id>.onnx; uso por produto em uso_modelos.json
BIB_PATH = os.path.join(DADOS, 'modelos.json'); USO_PATH = os.path.join(DADOS, 'uso_modelos.json'); MOD_DIR = os.path.join(DADOS, 'modelos')
os.makedirs(MOD_DIR, exist_ok=True)
BIBLIO = json.load(open(BIB_PATH)) if os.path.exists(BIB_PATH) else []
USO = json.load(open(USO_PATH)) if os.path.exists(USO_PATH) else {}
if not BIBLIO and os.path.exists(MODELO_PATH):   # versão antiga: um modelo só → vira o padrão da biblioteca
    info = json.load(open(MODELO_INFO)) if os.path.exists(MODELO_INFO) else {}
    BIBLIO = [{ 'id': 1, 'nome': 'Modelo antigo', 'padrao': True, 'imgsz': info.get('imgsz', 416), 'tipo': info.get('tipo', 'det'), 'classes': info.get('classes'), 'metricas': info.get('metricas', {}), 'amostras': info.get('amostras', 0), 'created_at': info.get('created_at'), 'updated_at': info.get('created_at') or agora_iso() }]
    shutil.copy(MODELO_PATH, os.path.join(MOD_DIR, '1.onnx'))
def salvar_biblio(): json.dump(BIBLIO, open(BIB_PATH, 'w')); json.dump(USO, open(USO_PATH, 'w'))
def modelo_path(mid): return os.path.join(MOD_DIR, f'{mid}.onnx')
def modelo_por_id(mid): return next((m for m in BIBLIO if m['id'] == int(mid)), None) if mid not in (None, '') else None
def modelo_info(produto_id=None):
    m, origem = None, None
    if produto_id and str(produto_id) in USO: m, origem = modelo_por_id(USO[str(produto_id)]), 'produto'
    if not m: m, origem = next((x for x in BIBLIO if x.get('padrao')), None), 'padrao'
    if not m or not os.path.exists(modelo_path(m['id'])): return None
    return { **m, 'produto_id': None, 'linha_id': 1, 'origem': origem, 'chave': f"{m['id']}.{m.get('updated_at')}", 'tamanho': os.path.getsize(modelo_path(m['id'])), 'produtos': [{ 'id': int(k), 'nome': PRODUTOS[0]['nome'] } for k, v in USO.items() if v == m['id']] }
def contagem_total(): return sum(e['valor'] for e in EVENTOS if e['ts'][:10] == hoje())
def sessao_fake():
    # grade simples de ciclos a partir do takt, para o painel ter "esperado": começa no primeiro evento do dia ou agora
    takt = PRODUTOS[0]['takt_min']
    return { 'id': 1, 'takt_min': takt, 'status': 'aberta', 'produto_id': 1, 'turno_nome': 'Teste', 'turno_codigo': 'T', 'total_ciclos': 0, 'esperado': 0 }

# ───────── treino ─────────
PY_TREINO = None
def treino_disponivel(forcar=False):
    """Testa o ultralytics num processo separado: se o torch der erro de DLL no Windows, o servidor não cai
    e o painel mostra o motivo real. Guarda o resultado quando dá certo."""
    global PY_TREINO
    if PY_TREINO and (PY_TREINO.get('ok') or not forcar): return PY_TREINO
    try:
        r = subprocess.run([sys.executable, '-c', 'import ultralytics, onnx, onnxruntime; print(ultralytics.__version__)'],
                           capture_output=True, text=True, timeout=300, env=dict(os.environ, YOLO_VERBOSE='False'))
        if r.returncode == 0: PY_TREINO = { 'ok': True, 'versao': (r.stdout.strip().splitlines() or ['?'])[-1] }
        else:
            linhas = [l for l in (r.stderr or '').strip().splitlines() if l.strip()]
            PY_TREINO = { 'ok': False, 'motivo': (linhas[-1] if linhas else 'erro ao importar o ultralytics')[:300] }
    except Exception as e: PY_TREINO = { 'ok': False, 'motivo': ('%s: %s' % (type(e).__name__, e))[:300] }
    return PY_TREINO

def treinar(produto_id, epocas, imgsz, modo='seg', destino_id=None, nome='Caixa/Pallet'):
    global TREINO
    d = tempfile.mkdtemp(prefix='treino-'); extra = []
    usadas = len(AMOSTRAS)
    if modo == 'seg':
        os.makedirs(os.path.join(d, 'images')); os.makedirs(os.path.join(d, 'labels')); usadas = 0
        for a in AMOSTRAS:
            src = os.path.join(DADOS, 'amostras', f"{a['id']}.jpg")
            if not a.get('caixas') or not os.path.exists(src): continue
            shutil.copy(src, os.path.join(d, 'images', f"a{a['id']}.jpg")); usadas += 1
            with open(os.path.join(d, 'labels', f"a{a['id']}.txt"), 'w') as f: f.write('\n'.join(linha_seg(c) for c in a['caixas']) + '\n')
        extra = ['--classes', ','.join(CLASSES_SEG)]
    elif modo == 'det':
        os.makedirs(os.path.join(d, 'images')); os.makedirs(os.path.join(d, 'labels'))
        for a in AMOSTRAS:
            src = os.path.join(DADOS, 'amostras', f"{a['id']}.jpg")
            if not os.path.exists(src): continue
            shutil.copy(src, os.path.join(d, 'images', f"a{a['id']}.jpg"))
            with open(os.path.join(d, 'labels', f"a{a['id']}.txt"), 'w') as f:
                for c in a.get('caixas', []): f.write(f"{CLASSES_DET.index(c.get('c')) if c.get('c') in CLASSES_DET else 0} {c['x'] + c['w'] / 2:.5f} {c['y'] + c['h'] / 2:.5f} {c['w']:.5f} {c['h']:.5f}\n")
        extra = ['--classes', ','.join(CLASSES_DET)]
    else:
        for r in ('vazio', 'com_pecas'): os.makedirs(os.path.join(d, r))
        for a in AMOSTRAS:
            src = os.path.join(DADOS, 'amostras', f"{a['id']}.jpg")
            if a.get('rotulo') in ('vazio', 'com_pecas') and os.path.exists(src): shutil.copy(src, os.path.join(d, a['rotulo'], f"a{a['id']}.jpg"))
        z = CONFIG.get('zona')
        if z: extra = ['--zona', f"{z['x']},{z['y']},{z['w']},{z['h']}"]
        imgsz = 224
    saida = os.path.join(d, 'modelo.onnx')
    TREINO = { 'estado': 'rodando', 'progresso': 0, 'total': epocas, 'log': [], 'inicio': time.time() * 1000, 'fim': None, 'erro': None, 'amostras': usadas, 'modo': modo, 'modelo_nome': (modelo_por_id(destino_id) or {}).get('nome') or nome }
    cmd = [sys.executable, os.path.join(RAIZ, 'python', 'treinar.py'), '--modo', modo, '--dados', d, '--saida', saida, '--epocas', str(epocas), '--imgsz', str(imgsz), '--batch', '4'] + extra
    env = dict(os.environ, YOLO_VERBOSE='False')
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, cwd=RAIZ)
    metricas = {}
    for linha in p.stdout:
        linha = linha.strip()
        if not linha: continue
        m = re.match(r'^PROGRESSO (\d+)/(\d+)', linha)
        if m: TREINO['progresso'] = int(m.group(1)); TREINO['total'] = int(m.group(2))
        k = re.match(r'^METRICAS (.+)$', linha)
        if k:
            try: metricas = json.loads(k.group(1))
            except Exception: pass
        if re.match(r'^(PROGRESSO|METRICAS|ERRO|Error|error|Traceback)', linha) or len(linha) < 160: TREINO['log'].append(linha[:200])
        TREINO['log'] = TREINO['log'][-60:]
    p.wait()
    TREINO['fim'] = time.time() * 1000
    if p.returncode != 0 or not os.path.exists(saida):
        TREINO['estado'] = 'erro'; TREINO['erro'] = 'Treino terminou com erro (código %s): %s' % (p.returncode, ' | '.join(l for l in TREINO['log'] if re.search('ERRO|Error', l))[-300:])
    else:
        classes = metricas.get('classes') if modo == 'cls' else (CLASSES_SEG if modo == 'seg' else CLASSES_DET)
        dados = { 'imgsz': imgsz, 'tipo': modo, 'classes': classes, 'metricas': metricas, 'amostras': usadas, 'updated_at': agora_iso() }
        m = modelo_por_id(destino_id) if destino_id else None
        if m: m.update(dados)
        else:
            m = { 'id': max([x['id'] for x in BIBLIO] + [0]) + 1, 'nome': nome, 'padrao': not any(x.get('padrao') for x in BIBLIO), 'created_at': agora_iso(), **dados }
            BIBLIO.append(m)
        shutil.copy(saida, modelo_path(m['id'])); salvar_biblio()
        global CONFIG_TS; CONFIG_TS = time.time()
        TREINO['modelo_id'] = m['id']
        TREINO['estado'] = 'concluido'; TREINO['metricas'] = metricas; TREINO['tamanho'] = os.path.getsize(modelo_path(m['id']))
    shutil.rmtree(d, ignore_errors=True)

# ───────── HTTP ─────────
PAGINAS = { '/c': 'contador.html', '/': 'contador-painel.html', '/cadenciador/painel': 'contador-painel.html', '/contador/painel': 'contador-painel.html',
            '/cadenciador/camera': 'contador.html', '/contador': 'contador.html', '/cadenciador': 'contador-painel.html', '/login': 'contador-painel.html' }

class H(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        if '/api/contador/frame' in (a[0] if a else '') or '/linhas/1/estado' in (a[0] if a else ''): return
        sys.stdout.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a)); sys.stdout.flush()
    def json(self, obj, code=200):
        b = json.dumps(obj, default=str).encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def bytes(self, b, ctype, code=200, extra=None):
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def corpo(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n: return {}
        try: return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception: return {}
    def arquivo(self, rel):
        p = os.path.normpath(os.path.join(PUBLIC, rel.lstrip('/')))
        if not p.startswith(PUBLIC) or not os.path.isfile(p): return self.json({ 'error': 'não encontrado' }, 404)
        ctype = mimetypes.guess_type(p)[0] or 'application/octet-stream'
        if p.endswith('.mjs'): ctype = 'text/javascript'
        if p.endswith('.wasm'): ctype = 'application/wasm'
        with open(p, 'rb') as f: b = f.read()
        self.send_response(200); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    # qualquer erro numa rota vira resposta JSON com o motivo (o painel mostra), em vez de derrubar a conexão
    def _seguro(self, fn):
        try: fn()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError): pass
        except Exception as e:
            print('  ERRO em', self.command, self.path, '→', type(e).__name__, e)
            try: self.json({ 'error': '%s: %s' % (type(e).__name__, e) }, 500)
            except Exception: pass
    def do_GET(self): self._seguro(self._get)
    def do_POST(self): self._seguro(self._post)
    def do_PUT(self): self._seguro(self._put)
    def do_DELETE(self): self._seguro(self._delete)
    def _get(self):
        u = urlparse(self.path); p = u.path; q = { k: v[0] for k, v in parse_qs(u.query).items() }
        if p in PAGINAS: return self.arquivo(PAGINAS[p])
        if not p.startswith('/api/'): return self.arquivo(p)
        if p == '/api/me': return self.json({ 'id': 1, 'username': 'teste', 'nome': 'Teste local', 'role': 'admin' })
        if p == '/api/prod-celulas': return self.json([{ 'id': 1, 'nome': 'Teste', 'categoria': 'teste', 'ativa': True }])
        if p == '/api/cadenciador/produtos': return self.json(PRODUTOS)
        if p == '/api/cadenciador/sessoes': return self.json([])
        if p == '/api/config/turnos/atual': return self.json({ 'turno': None })
        if p == '/api/contador/treino/disponivel':
            return self.json(treino_disponivel(forcar=True))
        if p == '/api/contador/linhas':
            online = time.time() - QUADRO['ts'] < 8
            return self.json([{ **LINHA, 'produto_nome': PRODUTOS[0]['nome'], 'takt_padrao': PRODUTOS[0]['takt_min'], 'config': CONFIG, 'config_linha': CONFIG, 'config_produto': {}, 'produtos_configurados': [],
                'online': online, 'frame_ts': int(QUADRO['ts'] * 1000) if QUADRO['ts'] else None, 'estado': QUADRO['estado'], 'resumo': QUADRO['resumo'], 'dispositivo': QUADRO['dispositivo'], 'usuario': 'Teste', 'capacidades': QUADRO['capacidades'],
                'contagem': contagem_total(), 'ultimo': EVENTOS[-1]['ts'] if EVENTOS else None, 'sessao': None, 'updated_at': CONFIG_TS }])
        if p == '/api/contador/linhas/1/estado':
            with LOCK: cmds = list(COMANDOS); COMANDOS.clear()
            return self.json({ 'linha': { 'id': 1, 'celula': 'Teste', 'nome': LINHA['nome'], 'produto_id': 1, 'produto_nome': PRODUTOS[0]['nome'], 'takt_padrao': PRODUTOS[0]['takt_min'] },
                'config': CONFIG, 'config_ts': CONFIG_TS, 'sessao': None, 'contagem': contagem_total(), 'comandos': cmds, 'agora': int(time.time() * 1000), 'modelo': modelo_info(q.get('produto_id')) })
        if p == '/api/contador/linhas/1/config': return self.json({ 'config': CONFIG, 'config_linha': CONFIG, 'config_produto': {}, 'produto_id': None, 'updated_at': CONFIG_TS })
        if p == '/api/contador/frame/1':
            if not QUADRO['buf']: return self.json({ 'error': 'sem quadro' }, 404)
            return self.bytes(QUADRO['buf'], 'image/jpeg', extra={ 'X-Frame-Ts': str(int(QUADRO['ts'] * 1000)) })
        if p == '/api/contador/linhas/1/qr.svg':
            svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#fff"/><text x="120" y="110" font-size="13" text-anchor="middle" font-family="sans-serif">Servidor de teste:</text><text x="120" y="135" font-size="13" text-anchor="middle" font-family="sans-serif">abra o endereço abaixo</text><text x="120" y="160" font-size="13" text-anchor="middle" font-family="sans-serif">no celular</text></svg>'
            return self.bytes(svg.encode(), 'image/svg+xml')
        if p == '/api/contador/eventos':
            return self.json([{ 'id': e['id'], 'linha_id': 1, 'celula': 'Teste', 'sessao_id': None, 'ts': e['ts'], 'origem': e['origem'], 'valor': e['valor'], 'mudanca_pct': e.get('mudanca_pct'), 'detalhe': e.get('detalhe'), 'tem_foto': bool(e.get('foto')), 'dispositivo': '', 'usuario_nome': 'Teste' } for e in EVENTOS if e['ts'][:10] == q.get('data', hoje())])
        m = re.match(r'^/api/contador/eventos/(\d+)/foto$', p)
        if m:
            e = next((x for x in EVENTOS if x['id'] == int(m.group(1))), None)
            return self.bytes(e['foto'], 'image/jpeg') if e and e.get('foto') else self.json({}, 404)
        if p == '/api/contador/analise':
            data = q.get('data', hoje())
            return self.json({ 'data': data, 'sessao': None, 'ciclos': [], 'paradas': [], 'eventos': [{ 'id': e['id'], 'linha_id': 1, 'celula': 'Teste', 'sessao_id': None, 'ts': e['ts'], 'origem': e['origem'], 'valor': e['valor'], 'mudanca_pct': e.get('mudanca_pct'), 'detalhe': e.get('detalhe'), 'tem_foto': bool(e.get('foto')) } for e in EVENTOS if e['ts'][:10] == data] })
        if p == '/api/contador/historico':
            dias = {}
            for e in EVENTOS:
                d = dias.setdefault(e['ts'][:10], { 'data': e['ts'][:10], 'linha_id': 1, 'celula': 'Teste', 'sessao_id': None, 'contagem': 0, 'ia': 0, 'retiradas': 0, 'mais': 0, 'menos': 0, 'estornos': 0, 'primeiro': e['ts'], 'ultimo': e['ts'], 'takt_min': None, 'produto_nome': None, 'turno_nome': None, 'total_ciclos': 0 })
                d['contagem'] += e['valor']; d['ultimo'] = e['ts']
                k = { 'ia': 'ia', 'ia_retirada': 'retiradas', 'manual_mais': 'mais', 'manual_menos': 'menos', 'estorno': 'estornos' }.get(e['origem'])
                if k: d[k] += 1
            return self.json(sorted(dias.values(), key=lambda d: d['data'], reverse=True))
        if p == '/api/contador/linhas/1/amostras':
            return self.json([{ 'id': a['id'], 'produto_id': a.get('produto_id'), 'largura': 640, 'altura': 480, 'caixas': a.get('caixas', []), 'rotulo': a.get('rotulo'), 'created_at': a['created_at'], 'n': len(a.get('caixas', [])) } for a in sorted(AMOSTRAS, key=lambda a: a['id'], reverse=True)])
        m = re.match(r'^/api/contador/amostras/(\d+)/jpeg$', p)
        if m:
            f = os.path.join(DADOS, 'amostras', m.group(1) + '.jpg')
            return self.bytes(open(f, 'rb').read(), 'image/jpeg') if os.path.exists(f) else self.json({}, 404)
        if p in ('/api/contador/linhas/1/treino', '/api/contador/treino/atual'): return self.json({ **TREINO, 'log': TREINO.get('log', [])[-12:] })
        if p == '/api/contador/modelos':
            out = []
            for m in sorted(BIBLIO, key=lambda x: (not x.get('padrao'), x['id'])):
                if not os.path.exists(modelo_path(m['id'])): continue
                out.append({ **m, 'linha_nome': LINHA['nome'], 'tamanho': os.path.getsize(modelo_path(m['id'])), 'produtos': [{ 'id': int(k), 'nome': PRODUTOS[0]['nome'] } for k, v in USO.items() if v == m['id']] })
            return self.json(out)
        m = re.match(r'^/api/contador/produtos/(\d+)/modelo$', p)
        if m: return self.json({ 'modelo_id': USO.get(m.group(1)) })
        if p == '/api/contador/linhas/1/modelo':
            info = modelo_info(q.get('produto_id'))
            if not info: return self.json({ 'error': 'Sem modelo treinado' }, 404)
            if q.get('info'): return self.json(info)
            return self.bytes(open(modelo_path(info['id']), 'rb').read(), 'application/octet-stream', extra={ 'X-Modelo-Id': str(info['id']), 'X-Imgsz': str(info['imgsz']) })
        if p == '/api/export/contador': return self.json({ 'error': 'exportação não existe no servidor de teste' }, 404)
        return self.json({ 'error': 'rota não existe no servidor de teste: ' + p }, 404)

    def _post(self):
        global CONFIG_TS
        p = urlparse(self.path).path; b = self.corpo()
        if p == '/api/logout' or p == '/api/login': return self.json({ 'ok': True })
        if p == '/api/contador/frame':
            buf = b64jpeg(b.get('jpeg'))
            if not buf: return self.json({ 'error': 'Quadro inválido' }, 400)
            with LOCK:
                QUADRO.update({ 'buf': buf, 'limpo': b64jpeg(b.get('jpeg_limpo')) or buf, 'ts': time.time(), 'contagem': b.get('contagem', 0), 'estado': str(b.get('estado', ''))[:40], 'resumo': b.get('resumo'), 'dispositivo': str(b.get('dispositivo', ''))[:120] })
                if isinstance(b.get('capacidades'), dict): QUADRO['capacidades'] = b['capacidades']
            return self.json({ 'ok': True, 'comandos': len(COMANDOS) })
        if p == '/api/contador/eventos':
            origem = b.get('origem')
            if origem not in ORIG: return self.json({ 'error': 'Origem inválida' }, 400)
            v = ORIG[origem]
            if origem in ('ia', 'ia_retirada') and str(b.get('valor', '')).isdigit(): v = ORIG[origem] * max(1, min(4, int(b['valor'])))
            foto = b64jpeg(b.get('foto'))
            e = { 'id': (EVENTOS[-1]['id'] + 1) if EVENTOS else 1, 'ts': b.get('ts') or agora_iso(), 'origem': origem, 'valor': v, 'mudanca_pct': b.get('mudanca_pct'), 'detalhe': (str(b['detalhe'])[:60] if b.get('detalhe') else None), 'foto': foto }
            with LOCK: EVENTOS.append(e); salvar_eventos()
            print('  EVENTO', origem, v, e['detalhe'] or '', flush=True)
            return self.json({ 'id': e['id'], 'ts': e['ts'], 'valor': v })
        if p == '/api/contador/linhas': return self.json({ **LINHA, 'config': CONFIG })
        if p == '/api/contador/linhas/1/comando':
            with LOCK: COMANDOS.append({ 'tipo': b.get('tipo'), 'ts': int(time.time() * 1000), 'por': 'Teste' })
            return self.json({ 'ok': True })
        if p == '/api/contador/linhas/1/amostras':
            buf = b64jpeg(b.get('jpeg')) or (QUADRO['limpo'] if b.get('da_camera') else None)
            if not buf: return self.json({ 'error': 'Sem imagem (a câmera está transmitindo?)' }, 400)
            a = { 'id': (max(x['id'] for x in AMOSTRAS) + 1) if AMOSTRAS else 1, 'produto_id': b.get('produto_id'), 'caixas': limpar_marc(b.get('caixas')), 'rotulo': b.get('rotulo') if b.get('rotulo') in ('vazio', 'com_pecas') else None, 'created_at': agora_iso() }
            open(os.path.join(DADOS, 'amostras', f"{a['id']}.jpg"), 'wb').write(buf)
            with LOCK: AMOSTRAS.append(a); salvar_amostras()
            return self.json({ 'id': a['id'], 'created_at': a['created_at'], 'n': len(a['caixas']), 'rotulo': a['rotulo'] })
        m = re.match(r'^/api/contador/amostras/(\d+)/sugerir$', p)
        if m:
            img = os.path.join(DADOS, 'amostras', m.group(1) + '.jpg')
            if not os.path.exists(img): return self.json({ 'error': 'Quadro não encontrado' }, 404)
            d = treino_disponivel()
            if not d['ok']: return self.json({ 'error': 'Sugestão indisponível: ' + d['motivo'] }, 503)
            args = [sys.executable, os.path.join(RAIZ, 'python', 'sugerir.py'), '--imagem', img]; fonte = 'IA genérica'
            info = modelo_por_id(b['modelo_id']) if b.get('modelo_id') else modelo_info(b.get('produto_id'))
            if info and info.get('tipo', 'det') in ('det', 'seg') and not b.get('generica') and os.path.exists(modelo_path(info['id'])):
                args += ['--modelo', modelo_path(info['id']), '--classes', ','.join(info.get('classes') or CLASSES_DET), '--tipo', info.get('tipo', 'det')]; fonte = 'IA treinada (' + info.get('nome', '') + ')'
            r = subprocess.run(args, capture_output=True, text=True, timeout=180, env=dict(os.environ, YOLO_VERBOSE='False'))
            linha = next((l for l in r.stdout.splitlines() if l.startswith('SUGESTOES ')), None)
            if not linha: return self.json({ 'error': 'A IA não respondeu: ' + (r.stderr or '')[-300:] }, 500)
            return self.json({ 'fonte': fonte, 'caixas': json.loads(linha[10:]) })
        if p == '/api/contador/linhas/1/treinar':
            if TREINO.get('estado') == 'rodando': return self.json({ 'error': 'Já existe um treino rodando.' }, 409)
            d = treino_disponivel()
            if not d['ok']: return self.json({ 'error': 'Treino indisponível: ' + d['motivo'] + ' — rode: python -m pip install -r python/requirements-local.txt' }, 503)
            modo = b.get('modo') if b.get('modo') in ('cls', 'det') else 'seg'
            if modo == 'seg':
                marcadas = [a for a in AMOSTRAS if a.get('caixas')]
                com = len([a for a in marcadas if any(c.get('c') != 'pallet' for c in a['caixas'])]); vaz = len(marcadas) - com
                if com < 3: return self.json({ 'error': f'Faltam quadros com peça: há {com} (mínimo 3, ideal 15+). Use o passo 2 (Peça).' }, 400)
                if vaz < 1: return self.json({ 'error': 'Falta o pallet vazio: capture pelo menos 1 no passo 1 (ideal 3+).' }, 400)
            elif modo == 'det':
                marcadas = [a for a in AMOSTRAS if a.get('caixas')]
                if len(marcadas) < 3: return self.json({ 'error': f'Marque caixas em pelo menos 3 quadros (há {len(marcadas)}). O ideal são 15 ou mais.' }, 400)
            else:
                nv = len([a for a in AMOSTRAS if a.get('rotulo') == 'vazio']); nc = len([a for a in AMOSTRAS if a.get('rotulo') == 'com_pecas'])
                if nv < 3 or nc < 3: return self.json({ 'error': f'Capture pelo menos 3 quadros de pallet VAZIO e 3 COM PEÇAS (há {nv} e {nc}). O ideal são 10 ou mais de cada.' }, 400)
            epocas = max(5, min(80, int(b.get('epocas') or 40))); imgsz = int(b.get('imgsz') or 416)
            destino = int(b['modelo_id']) if b.get('modelo_id') else None
            if destino and not modelo_por_id(destino): return self.json({ 'error': 'Modelo não encontrado' }, 404)
            nome = (str(b.get('nome') or '').strip() or 'Caixa/Pallet')[:80]
            threading.Thread(target=treinar, args=(b.get('produto_id'), epocas, imgsz, modo, destino, nome), daemon=True).start()
            return self.json({ 'ok': True, 'amostras': len([a for a in AMOSTRAS if a.get('caixas')]), 'epocas': epocas, 'imgsz': imgsz, 'modelo_nome': (modelo_por_id(destino) or {}).get('nome') or nome })
        if p == '/api/cadenciador/sessoes': return self.json({ 'error': 'sem cadenciador no servidor de teste' }, 400)
        return self.json({ 'error': 'rota não existe no servidor de teste: ' + p }, 404)

    def _put(self):
        global CONFIG_TS
        p = urlparse(self.path).path; b = self.corpo()
        if p == '/api/contador/linhas/1/config':
            novo = { k: v for k, v in b.items() if k in CONFIG_PADRAO }
            with LOCK: CONFIG.update(novo); CONFIG_TS = time.time(); salvar_config()
            return self.json({ 'config': CONFIG, 'config_linha': CONFIG, 'config_produto': {}, 'updated_at': CONFIG_TS })
        m = re.match(r'^/api/contador/modelos/(\d+)$', p)
        if m:
            mod = modelo_por_id(m.group(1))
            if not mod: return self.json({ 'error': 'Modelo não encontrado' }, 404)
            if b.get('nome'): mod['nome'] = str(b['nome']).strip()[:80]
            if b.get('padrao') is True:
                for x in BIBLIO: x['padrao'] = x['id'] == mod['id']
            elif b.get('padrao') is False: mod['padrao'] = False
            salvar_biblio(); CONFIG_TS = time.time(); return self.json({ 'ok': True })
        m = re.match(r'^/api/contador/produtos/(\d+)/modelo$', p)
        if m:
            if b.get('modelo_id'): USO[m.group(1)] = int(b['modelo_id'])
            else: USO.pop(m.group(1), None)
            salvar_biblio(); CONFIG_TS = time.time(); return self.json({ 'ok': True, 'modelo_id': b.get('modelo_id') })
        if p == '/api/contador/linhas/1': LINHA.update({ k: b[k] for k in ('nome',) if k in b }); return self.json(LINHA)
        m = re.match(r'^/api/contador/amostras/(\d+)$', p)
        if m:
            a = next((x for x in AMOSTRAS if x['id'] == int(m.group(1))), None)
            if not a: return self.json({}, 404)
            if 'rotulo' in b: a['rotulo'] = b['rotulo'] if b['rotulo'] in ('vazio', 'com_pecas') else None
            if isinstance(b.get('caixas'), list): a['caixas'] = limpar_marc(b['caixas'])
            salvar_amostras()
            return self.json({ 'ok': True, 'n': len(a['caixas']) })
        return self.json({ 'error': 'rota não existe' }, 404)

    def _delete(self):
        global CONFIG_TS
        p = urlparse(self.path).path
        m = re.match(r'^/api/contador/amostras/(\d+)$', p)
        if m:
            AMOSTRAS[:] = [a for a in AMOSTRAS if a['id'] != int(m.group(1))]; salvar_amostras()
            f = os.path.join(DADOS, 'amostras', m.group(1) + '.jpg')
            if os.path.exists(f): os.remove(f)
            return self.json({ 'ok': True })
        m = re.match(r'^/api/contador/eventos/(\d+)$', p)
        if m: EVENTOS[:] = [e for e in EVENTOS if e['id'] != int(m.group(1))]; salvar_eventos(); return self.json({ 'ok': True })
        m = re.match(r'^/api/contador/(?:modelos|linhas/1/modelo)/(\d+)$', p)
        if m:
            mid = int(m.group(1)); BIBLIO[:] = [x for x in BIBLIO if x['id'] != mid]
            for k in [k for k, v in USO.items() if v == mid]: USO.pop(k)
            if os.path.exists(modelo_path(mid)): os.remove(modelo_path(mid))
            salvar_biblio(); CONFIG_TS = time.time(); return self.json({ 'ok': True })
        if p.startswith('/api/contador/linhas/1/config/'): return self.json({ 'ok': True })
        return self.json({ 'error': 'rota não existe' }, 404)

def ips():
    """IP principal (o da rota para fora) primeiro; adaptadores virtuais (VirtualBox, WSL/Hyper-V, VPN) por último."""
    principal, out = None, []
    for alvo in ('8.8.8.8', '10.255.255.255'):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect((alvo, 1)); principal = s.getsockname()[0]; s.close(); break
        except Exception: pass
    try: out += [i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except Exception: pass
    virt = lambda ip: ip.startswith(('169.254.', '192.168.56.', '172.17.', '172.18.', '172.19.', '172.2', '172.30.', '172.31.'))
    resto = sorted(set(i for i in out if not i.startswith('127.') and i != principal), key=virt)
    return ([principal] if principal and not principal.startswith('127.') else []) + resto

class Redireciona(SimpleHTTPRequestHandler):
    """http://IP:3001 → https://IP:3000 (quem digitar sem https:// no celular cai no lugar certo)"""
    def log_message(self, *a): pass
    def do_GET(self):
        host = (self.headers.get('Host') or 'localhost').split(':')[0]
        caminho = self.path if self.path not in ('/', '/c') else '/cadenciador/camera'
        self.send_response(302); self.send_header('Location', f'https://{host}:{PORTA}{caminho}'); self.end_headers()

class Servidor(ThreadingHTTPServer):
    """Ignora conexões que o celular/navegador cortou no meio (recarregou a página, trocou de rede,
    tela apagou). Isso é normal e não é erro do servidor — antes aparecia como um Traceback enorme."""
    daemon_threads = True
    def handle_error(self, request, client_address):
        e = sys.exc_info()[1]
        if isinstance(e, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError, ssl.SSLError)): return
        if isinstance(e, OSError) and getattr(e, 'winerror', None) in (10053, 10054): return
        super().handle_error(request, client_address)

if __name__ == '__main__':
    srv = Servidor(('0.0.0.0', PORTA), H)
    proto = 'http'
    cert = os.path.join(RAIZ, 'cert_teste', 'cert.pem'); key = os.path.join(RAIZ, 'cert_teste', 'key.pem')
    if os.path.exists(cert) and os.path.exists(key) and os.environ.get('HTTPS', '1') == '1':
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True); proto = 'https'
    if proto == 'https':
        try:
            red = Servidor(('0.0.0.0', PORTA + 1), Redireciona)
            threading.Thread(target=red.serve_forever, daemon=True).start()
        except Exception: pass
    lista = ips()
    print('=' * 64); print('  Servidor de TESTE da câmera (só Python)'); print('=' * 64)
    print(f'  No PC (painel):    {proto}://localhost:{PORTA}/cadenciador/painel')
    if lista:
        print(f'  NO CELULAR digite: {proto}://{lista[0]}:{PORTA}/c')
        for ip in lista[1:]: print(f'     (outro IP deste PC, se o de cima não abrir: {proto}://{ip}:{PORTA}/c)')
    print('  -> no celular aparece "conexão não é particular": Avançado > Continuar (é o certificado de teste)')
    print('  Celular não abre a página?')
    print('     1) celular e PC na MESMA rede Wi-Fi')
    print('     2) Firewall do Windows: na 1a vez ele pergunta — permita o Python em redes privadas E públicas')
    print('     3) Wi-Fi de empresa costuma bloquear aparelho com aparelho: ligue o "Hotspot móvel" do Windows,')
    print('        conecte o celular nele e use o IP que aparecer acima (normalmente 192.168.137.1)')
    print('  Treino da IA: verificando…', end='', flush=True)
    d = treino_disponivel()
    print('\r  Treino da IA: ' + ('disponível (ultralytics ' + d['versao'] + ')' if d['ok'] else 'INDISPONÍVEL — ' + d['motivo'] + '\n      → python -m pip install -r python/requirements-local.txt'))
    print('  Dados em:    ', DADOS); print('  Ctrl+C para parar'); print('=' * 60, flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: print('\nEncerrado.')
