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
def modelo_info():
    if not os.path.exists(MODELO_PATH): return None
    info = json.load(open(MODELO_INFO)) if os.path.exists(MODELO_INFO) else {}
    return { 'id': info.get('id', 1), 'produto_id': None, 'imgsz': info.get('imgsz', 416), 'tipo': info.get('tipo', 'det'), 'classes': info.get('classes'), 'metricas': info.get('metricas', {}), 'amostras': info.get('amostras', 0), 'created_at': info.get('created_at') }
def contagem_total(): return sum(e['valor'] for e in EVENTOS if e['ts'][:10] == hoje())
def sessao_fake():
    # grade simples de ciclos a partir do takt, para o painel ter "esperado": começa no primeiro evento do dia ou agora
    takt = PRODUTOS[0]['takt_min']
    return { 'id': 1, 'takt_min': takt, 'status': 'aberta', 'produto_id': 1, 'turno_nome': 'Teste', 'turno_codigo': 'T', 'total_ciclos': 0, 'esperado': 0 }

# ───────── treino ─────────
def treinar(produto_id, epocas, imgsz, modo='det'):
    global TREINO
    d = tempfile.mkdtemp(prefix='treino-'); extra = []
    if modo == 'det':
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
    TREINO = { 'estado': 'rodando', 'progresso': 0, 'total': epocas, 'log': [], 'inicio': time.time() * 1000, 'fim': None, 'erro': None, 'amostras': len(AMOSTRAS), 'modo': modo }
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
        shutil.copy(saida, MODELO_PATH)
        json.dump({ 'id': int(time.time()), 'imgsz': imgsz, 'tipo': modo, 'classes': metricas.get('classes') if modo == 'cls' else CLASSES_DET, 'metricas': metricas, 'amostras': len(AMOSTRAS), 'created_at': agora_iso() }, open(MODELO_INFO, 'w'))
        global CONFIG_TS; CONFIG_TS = time.time()
        TREINO['estado'] = 'concluido'; TREINO['metricas'] = metricas; TREINO['modelo_id'] = modelo_info()['id']; TREINO['tamanho'] = os.path.getsize(MODELO_PATH)
    shutil.rmtree(d, ignore_errors=True)

# ───────── HTTP ─────────
PAGINAS = { '/': 'contador-painel.html', '/cadenciador/painel': 'contador-painel.html', '/contador/painel': 'contador-painel.html',
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

    def do_GET(self):
        u = urlparse(self.path); p = u.path; q = { k: v[0] for k, v in parse_qs(u.query).items() }
        if p in PAGINAS: return self.arquivo(PAGINAS[p])
        if not p.startswith('/api/'): return self.arquivo(p)
        if p == '/api/me': return self.json({ 'id': 1, 'username': 'teste', 'nome': 'Teste local', 'role': 'admin' })
        if p == '/api/prod-celulas': return self.json([{ 'id': 1, 'nome': 'Teste', 'categoria': 'teste', 'ativa': True }])
        if p == '/api/cadenciador/produtos': return self.json(PRODUTOS)
        if p == '/api/cadenciador/sessoes': return self.json([])
        if p == '/api/config/turnos/atual': return self.json({ 'turno': None })
        if p == '/api/contador/treino/disponivel':
            try: import ultralytics; return self.json({ 'ok': True, 'versao': ultralytics.__version__ })
            except ImportError: return self.json({ 'ok': False, 'motivo': 'ultralytics não instalado' })
        if p == '/api/contador/linhas':
            online = time.time() - QUADRO['ts'] < 8
            return self.json([{ **LINHA, 'produto_nome': PRODUTOS[0]['nome'], 'takt_padrao': PRODUTOS[0]['takt_min'], 'config': CONFIG, 'config_linha': CONFIG, 'config_produto': {}, 'produtos_configurados': [],
                'online': online, 'frame_ts': int(QUADRO['ts'] * 1000) if QUADRO['ts'] else None, 'estado': QUADRO['estado'], 'resumo': QUADRO['resumo'], 'dispositivo': QUADRO['dispositivo'], 'usuario': 'Teste', 'capacidades': QUADRO['capacidades'],
                'contagem': contagem_total(), 'ultimo': EVENTOS[-1]['ts'] if EVENTOS else None, 'sessao': None, 'updated_at': CONFIG_TS }])
        if p == '/api/contador/linhas/1/estado':
            with LOCK: cmds = list(COMANDOS); COMANDOS.clear()
            return self.json({ 'linha': { 'id': 1, 'celula': 'Teste', 'nome': LINHA['nome'], 'produto_id': 1, 'produto_nome': PRODUTOS[0]['nome'], 'takt_padrao': PRODUTOS[0]['takt_min'] },
                'config': CONFIG, 'config_ts': CONFIG_TS, 'sessao': None, 'contagem': contagem_total(), 'comandos': cmds, 'agora': int(time.time() * 1000), 'modelo': modelo_info() })
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
        if p == '/api/contador/linhas/1/treino': return self.json({ **TREINO, 'log': TREINO.get('log', [])[-12:] })
        if p == '/api/contador/linhas/1/modelo':
            info = modelo_info()
            if not info: return self.json({ 'error': 'Sem modelo treinado' }, 404)
            if q.get('info'): return self.json(info)
            return self.bytes(open(MODELO_PATH, 'rb').read(), 'application/octet-stream', extra={ 'X-Modelo-Id': str(info['id']), 'X-Imgsz': str(info['imgsz']) })
        if p == '/api/export/contador': return self.json({ 'error': 'exportação não existe no servidor de teste' }, 404)
        return self.json({ 'error': 'rota não existe no servidor de teste: ' + p }, 404)

    def do_POST(self):
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
            a = { 'id': (max(x['id'] for x in AMOSTRAS) + 1) if AMOSTRAS else 1, 'produto_id': b.get('produto_id'), 'caixas': [dict(c, c=c.get('c') if c.get('c') in CLASSES_DET else 'caixa') for c in (b.get('caixas') or []) if isinstance(c, dict)], 'rotulo': b.get('rotulo') if b.get('rotulo') in ('vazio', 'com_pecas') else None, 'created_at': agora_iso() }
            open(os.path.join(DADOS, 'amostras', f"{a['id']}.jpg"), 'wb').write(buf)
            with LOCK: AMOSTRAS.append(a); salvar_amostras()
            return self.json({ 'id': a['id'], 'created_at': a['created_at'], 'n': len(a['caixas']), 'rotulo': a['rotulo'] })
        if p == '/api/contador/linhas/1/treinar':
            if TREINO.get('estado') == 'rodando': return self.json({ 'error': 'Já existe um treino rodando.' }, 409)
            try: import ultralytics  # noqa
            except ImportError: return self.json({ 'error': 'Treino indisponível: ultralytics não instalado neste Python. Rode: python -m pip install -r python/requirements-local.txt' }, 503)
            modo = 'cls' if b.get('modo') == 'cls' else 'det'
            if modo == 'det':
                marcadas = [a for a in AMOSTRAS if a.get('caixas')]
                if len(marcadas) < 3: return self.json({ 'error': f'Marque caixas em pelo menos 3 quadros (há {len(marcadas)}). O ideal são 15 ou mais.' }, 400)
            else:
                nv = len([a for a in AMOSTRAS if a.get('rotulo') == 'vazio']); nc = len([a for a in AMOSTRAS if a.get('rotulo') == 'com_pecas'])
                if nv < 3 or nc < 3: return self.json({ 'error': f'Capture pelo menos 3 quadros de pallet VAZIO e 3 COM PEÇAS (há {nv} e {nc}). O ideal são 10 ou mais de cada.' }, 400)
            epocas = max(5, min(80, int(b.get('epocas') or 40))); imgsz = int(b.get('imgsz') or 416)
            threading.Thread(target=treinar, args=(b.get('produto_id'), epocas, imgsz, modo), daemon=True).start()
            return self.json({ 'ok': True, 'amostras': len(AMOSTRAS), 'epocas': epocas, 'imgsz': imgsz })
        if p == '/api/cadenciador/sessoes': return self.json({ 'error': 'sem cadenciador no servidor de teste' }, 400)
        return self.json({ 'error': 'rota não existe no servidor de teste: ' + p }, 404)

    def do_PUT(self):
        global CONFIG_TS
        p = urlparse(self.path).path; b = self.corpo()
        if p == '/api/contador/linhas/1/config':
            novo = { k: v for k, v in b.items() if k in CONFIG_PADRAO }
            with LOCK: CONFIG.update(novo); CONFIG_TS = time.time(); salvar_config()
            return self.json({ 'config': CONFIG, 'config_linha': CONFIG, 'config_produto': {}, 'updated_at': CONFIG_TS })
        if p == '/api/contador/linhas/1': LINHA.update({ k: b[k] for k in ('nome',) if k in b }); return self.json(LINHA)
        m = re.match(r'^/api/contador/amostras/(\d+)$', p)
        if m:
            a = next((x for x in AMOSTRAS if x['id'] == int(m.group(1))), None)
            if not a: return self.json({}, 404)
            if 'rotulo' in b: a['rotulo'] = b['rotulo'] if b['rotulo'] in ('vazio', 'com_pecas') else None
            if isinstance(b.get('caixas'), list): a['caixas'] = [dict(c, c=c.get('c') if c.get('c') in CLASSES_DET else 'caixa') for c in b['caixas'] if isinstance(c, dict)]
            salvar_amostras()
            return self.json({ 'ok': True, 'n': len(a['caixas']) })
        return self.json({ 'error': 'rota não existe' }, 404)

    def do_DELETE(self):
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
        if p.startswith('/api/contador/linhas/1/modelo/'):
            for f in (MODELO_PATH, MODELO_INFO):
                if os.path.exists(f): os.remove(f)
            CONFIG_TS = time.time(); return self.json({ 'ok': True })
        if p.startswith('/api/contador/linhas/1/config/'): return self.json({ 'ok': True })
        return self.json({ 'error': 'rota não existe' }, 404)

def ips():
    out = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('10.255.255.255', 1)); out.append(s.getsockname()[0]); s.close()
    except Exception: pass
    try: out += [i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except Exception: pass
    return sorted(set(i for i in out if not i.startswith('127.')))

if __name__ == '__main__':
    srv = ThreadingHTTPServer(('0.0.0.0', PORTA), H)
    proto = 'http'
    cert = os.path.join(RAIZ, 'cert_teste', 'cert.pem'); key = os.path.join(RAIZ, 'cert_teste', 'key.pem')
    if os.path.exists(cert) and os.path.exists(key) and os.environ.get('HTTPS', '1') == '1':
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True); proto = 'https'
    print('=' * 60); print('  Servidor de TESTE da câmera (só Python)'); print('=' * 60)
    print(f'  No PC:        {proto}://localhost:{PORTA}/cadenciador/painel')
    for ip in ips(): print(f'  Na rede:      {proto}://{ip}:{PORTA}/cadenciador/camera   (celular/tablet: conectar câmera)')
    try: import ultralytics; print('  Treino da IA: disponível (ultralytics', ultralytics.__version__ + ')')
    except ImportError: print('  Treino da IA: indisponível — python -m pip install -r python/requirements-local.txt')
    print('  Dados em:    ', DADOS); print('  Ctrl+C para parar'); print('=' * 60, flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: print('\nEncerrado.')
