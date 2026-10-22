#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sobe o sistema no PC usando só o Python (sem instalar nada como administrador).

    python iniciar_pc.py

Na primeira vez (precisa de internet) ele instala, via pip, um Node.js e um
PostgreSQL embutidos, cria o banco "decio" dentro da pasta .banco/, grava o
.env, roda "npm install" e inicia o servidor. Nas próximas vezes só inicia.
Ctrl+C encerra o servidor e o banco.

Precisa de Python 3.10, 3.11 ou 3.12 (o PostgreSQL embutido ainda não tem
pacote para 3.13+). Se o seu for mais novo, instale o 3.12 em python.org
(pode ter os dois) e rode com "py -3.12 iniciar_pc.py".
"""
import os, sys, subprocess, shutil, re, signal, time

RAIZ = os.path.dirname(os.path.abspath(__file__))
WIN = os.name == 'nt'
try: sys.stdout.reconfigure(encoding='utf-8')
except Exception: pass

def titulo(t): print('\n' + '=' * 60 + '\n  ' + t + '\n' + '=' * 60, flush=True)
def falhar(msg):
    print('\nERRO: ' + msg, flush=True)
    if sys.stdin and sys.stdin.isatty():
        try: input('\nPressione Enter para sair...')
        except Exception: pass
    sys.exit(1)

def pip_instalar(*pacotes):
    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', *pacotes]
    if subprocess.run([sys.executable, '-m', 'pip', '--version'], capture_output=True).returncode != 0:
        subprocess.run([sys.executable, '-m', 'ensurepip', '--upgrade'], capture_output=True)   # Python sem pip (ex.: baixado pelo uv)
    r = subprocess.run(cmd)
    if r.returncode != 0 and not WIN:
        r = subprocess.run(cmd + ['--break-system-packages'])
    return r.returncode == 0

def testar_internet():
    import urllib.request
    for url in ('https://pypi.org/simple/pip/', 'https://github.com'):
        try:
            urllib.request.urlopen(url, timeout=15).read(100); print('Internet OK:', url, flush=True)
        except Exception as e:
            print('SEM ACESSO a', url, '->', str(e)[:120], flush=True)
            print('   (rede da empresa com proxy? configure as variáveis HTTPS_PROXY/HTTP_PROXY no CMD antes de rodar,\n    ou rode o primeiro início numa rede livre, ex.: internet do celular)', flush=True)

# ───────── 1. Python compatível ─────────
if sys.version_info < (3, 10):
    falhar(f'Python {sys.version.split()[0]} é antigo demais. Instale o Python 3.12 em python.org.')

def achar_python312():
    """O PostgreSQL embutido só tem pacote até o Python 3.12. Se este for mais novo,
    procura um 3.12 na máquina; não achando, baixa um (sem administrador) com o uv."""
    candidatos = []
    if WIN:
        candidatos.append(['py', '-3.12'])
    candidatos += [['python3.12'], ['python3.11'], ['python3.10']]
    for c in candidatos:
        try:
            out = subprocess.run(c + ['-c', 'import sys; print(sys.executable)'], capture_output=True, text=True, timeout=20)
            if out.returncode == 0 and out.stdout.strip(): return out.stdout.strip()
        except Exception: pass
    print('Este Python é o %d.%d. Baixando um Python 3.12 só para o sistema (uma vez, ~30 MB)...' % sys.version_info[:2], flush=True)
    # 1) uv (usa os certificados do Windows — redes de empresa com proxy inspecionando HTTPS)
    if pip_instalar('uv'):
        uv = [sys.executable, '-m', 'uv']
        env_uv = dict(os.environ, UV_NATIVE_TLS='1', UV_SYSTEM_CERTS='1')
        r = subprocess.run(uv + ['python', 'install', '3.12'], capture_output=True, text=True, env=env_uv)
        print((r.stdout.strip() + ' ' + r.stderr.strip()).strip()[-400:], flush=True)
        if r.returncode == 0:
            out = subprocess.run(uv + ['python', 'find', '3.12'], capture_output=True, text=True, env=env_uv)
            if out.stdout.strip(): return out.stdout.strip()
        print('-> uv não conseguiu; tentando o Python embutido do python.org...', flush=True)
    # 2) Python "embeddable" do python.org, dentro da pasta do projeto (.python312)
    if WIN:
        try: return baixar_python_embutido()
        except Exception as e: print('-> falhou o Python embutido:', str(e)[:300], flush=True)
    return None

def baixar_python_embutido():
    import urllib.request, zipfile
    ver = '3.12.10'
    destino = os.path.join(RAIZ, '.python312'); exe = os.path.join(destino, 'python.exe')
    if os.path.exists(exe) and os.path.exists(os.path.join(destino, 'Scripts', 'pip.exe')): return exe
    url = f'https://www.python.org/ftp/python/{ver}/python-{ver}-embed-amd64.zip'
    print('Baixando', url, flush=True)
    zp = os.path.join(RAIZ, 'python-embed.zip'); urllib.request.urlretrieve(url, zp)
    zipfile.ZipFile(zp).extractall(destino); os.remove(zp)
    for f in os.listdir(destino):                       # libera o site-packages (vem desligado no embeddable)
        if f.endswith('._pth'):
            p = os.path.join(destino, f); open(p, 'w').write(open(p).read().replace('#import site', 'import site'))
    gp = os.path.join(destino, 'get-pip.py'); urllib.request.urlretrieve('https://bootstrap.pypa.io/get-pip.py', gp)
    subprocess.run([exe, gp, '--no-warn-script-location'], check=True); os.remove(gp)
    return exe

if sys.version_info >= (3, 13) and os.environ.get('DECIO_REEXEC') != '1':
    titulo('0/4  Python 3.12 para o banco embutido')
    testar_internet()
    py = achar_python312()
    if not py:
        falhar('Não encontrei nem consegui baixar um Python 3.12.\nInstale o Python 3.12 em python.org (marque "Add to PATH") e rode:  py -3.12 iniciar_pc.py')
    print('Usando', py, flush=True)
    os.environ['DECIO_REEXEC'] = '1'
    sys.exit(subprocess.call([py, os.path.abspath(__file__)] + sys.argv[1:]))

# ───────── 2. PostgreSQL embutido ─────────
titulo('1/4  Banco de dados (PostgreSQL embutido)')
try:
    import pgserver
except ImportError:
    print('Instalando o PostgreSQL embutido (pip install pgserver)...', flush=True)
    if not pip_instalar('pgserver'):
        falhar('Não consegui instalar o pacote "pgserver".\n'
               + ('Seu Python é o %d.%d — esse pacote existe só para 3.10, 3.11 e 3.12.\n' % sys.version_info[:2]
                  + 'Instale o Python 3.12 (python.org, marque "Add to PATH") e rode:  py -3.12 iniciar_pc.py'
                  if sys.version_info >= (3, 13) else 'Verifique a internet e tente de novo.'))
    import pgserver

pasta_banco = os.path.join(RAIZ, '.banco')
try:
    banco = pgserver.get_server(pasta_banco)          # cria na 1ª vez, inicia nas outras
except Exception as e:
    falhar('Não consegui iniciar o PostgreSQL embutido: %s\nSe o erro persistir, apague a pasta .banco (perde os dados) e rode de novo.' % e)
if 'decio' not in banco.psql('SELECT datname FROM pg_database'):
    banco.psql('CREATE DATABASE decio')
    print('Banco "decio" criado.', flush=True)
uri = banco.get_uri('decio')
print('PostgreSQL no ar:', uri, flush=True)

# ───────── 3. Node.js embutido ─────────
titulo('2/4  Node.js embutido')
try:
    import nodejs_wheel
except ImportError:
    print('Instalando o Node.js embutido (pip install nodejs-wheel-binaries)...', flush=True)
    if not pip_instalar('nodejs-wheel-binaries'):
        falhar('Não consegui instalar o pacote "nodejs-wheel-binaries". Verifique a internet.')
    import nodejs_wheel
NODE_DIR = os.path.dirname(nodejs_wheel.__file__)
NODE = os.path.join(NODE_DIR, 'node.exe') if WIN else os.path.join(NODE_DIR, 'bin', 'node')
NPM_CLI = os.path.join(NODE_DIR, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
if not os.path.exists(NPM_CLI):   # procura o npm-cli.js onde quer que o pacote o tenha posto
    for base, _dirs, arquivos in os.walk(NODE_DIR):
        if 'npm-cli.js' in arquivos and base.endswith(os.path.join('npm', 'bin')): NPM_CLI = os.path.join(base, 'npm-cli.js'); break
if not os.path.exists(NODE): falhar('node não encontrado em ' + NODE)
versao = subprocess.run([NODE, '-v'], capture_output=True, text=True).stdout.strip()
print('Node.js', versao, flush=True)
env = dict(os.environ)
env['PATH'] = (NODE_DIR if WIN else os.path.join(NODE_DIR, 'bin')) + os.pathsep + env.get('PATH', '')

# ───────── 4. .env ─────────
titulo('3/4  Configuração (.env)')
env_path = os.path.join(RAIZ, '.env')
if not os.path.exists(env_path):
    base = os.path.join(RAIZ, '.env.example')
    conteudo = open(base, encoding='utf-8').read() if os.path.exists(base) else 'PORT=3000\nHTTPS=1\nSEED_ON_BOOT=true\nTZ=America/Sao_Paulo\n'
    open(env_path, 'w', encoding='utf-8').write(conteudo)
    print('.env criado a partir do .env.example', flush=True)
linhas = open(env_path, encoding='utf-8').read().splitlines()
def definir(chave, valor):
    global linhas
    achou = False
    for i, l in enumerate(linhas):
        if re.match(r'^\s*#?\s*' + chave + r'\s*=', l):
            linhas[i] = f'{chave}={valor}'; achou = True; break
    if not achou: linhas.append(f'{chave}={valor}')
definir('DATABASE_URL', uri)                 # a porta do banco embutido pode mudar a cada início
definir('PYTHON_BIN', sys.executable)        # para o treino da IA usar este mesmo Python
open(env_path, 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')
porta = next((l.split('=', 1)[1].strip() for l in linhas if l.startswith('PORT=')), '3000')
https = any(l.strip() == 'HTTPS=1' for l in linhas)
print('.env atualizado (DATABASE_URL e PYTHON_BIN).', flush=True)

# ───────── 5. dependências do sistema ─────────
titulo('4/4  Dependências e servidor')
if not os.path.isdir(os.path.join(RAIZ, 'node_modules')):
    print('Primeira vez: baixando as dependências (npm install)... pode levar alguns minutos.', flush=True)
    r = subprocess.run([NODE, NPM_CLI, 'install', '--no-audit', '--no-fund'], cwd=RAIZ, env=env)
    if r.returncode != 0: falhar('npm install falhou. Verifique a internet e rode de novo.')

# treino da IA (opcional): avisa se faltar
try:
    import ultralytics  # noqa
    print('IA: pacotes de treino presentes.', flush=True)
except ImportError:
    print('IA: treino indisponível (opcional). Para habilitar: %s -m pip install -r python/requirements-local.txt' % os.path.basename(sys.executable), flush=True)

print('\nIniciando o servidor... (Ctrl+C para parar)\n', flush=True)
proc = subprocess.Popen([NODE, 'server.js'], cwd=RAIZ, env=env)
try:
    proc.wait()
except KeyboardInterrupt:
    print('\nEncerrando...', flush=True)
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        proc.kill()
finally:
    try: banco.cleanup()
    except Exception: pass
print('Servidor e banco encerrados.')
