/* ═══════════════════════════════════════════════════════
   DÉCIO — núcleo compartilhado pelas páginas
   ═══════════════════════════════════════════════════════ */

/* ───────── API ───────── */

async function pedir(url, opcoes = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    ...opcoes
  });

  if (resp.status === 401) {
    window.location.href = '/login';
    throw new Error('Sessão expirada');
  }

  let dados = null;
  try { dados = await resp.json(); } catch { /* resposta sem corpo */ }

  if (!resp.ok) {
    const erro = new Error((dados && dados.error) || `Erro ${resp.status}`);
    erro.status = resp.status;
    erro.codigo = dados && dados.codigo;
    throw erro;
  }
  return dados;
}

const API = {
  get:  (url)       => pedir(url),
  post: (url, body) => pedir(url, { method: 'POST', body: JSON.stringify(body || {}) }),
  put:  (url, body) => pedir(url, { method: 'PUT',  body: JSON.stringify(body || {}) }),
  del:  (url)       => pedir(url, { method: 'DELETE' })
};

/* ───────── Avisos ───────── */

function aviso(texto, tipo = 'ok', duracaoMs = 3600) {
  let caixa = document.getElementById('avisos');
  if (!caixa) {
    caixa = document.createElement('div');
    caixa.id = 'avisos';
    document.body.appendChild(caixa);
  }

  const icones = { ok: '✓', erro: '✕', alerta: '!', info: 'i' };
  const el = document.createElement('div');
  el.className = 'aviso aviso-' + tipo;
  el.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  el.innerHTML = `<strong style="opacity:.75">${icones[tipo] || 'i'}</strong><span></span>`;
  el.querySelector('span').textContent = texto;
  caixa.appendChild(el);

  setTimeout(() => {
    el.classList.add('saindo');
    setTimeout(() => el.remove(), 200);
  }, duracaoMs);
}

const avisoOk   = t => aviso(t, 'ok');
const avisoErro = t => aviso(t, 'erro', 5000);

/** Envolve uma chamada de API mostrando o erro ao usuário em vez de engolir. */
async function tentar(fn, msgSucesso) {
  try {
    const r = await fn();
    if (msgSucesso) avisoOk(msgSucesso);
    return r;
  } catch (e) {
    avisoErro(e.message || 'Falha inesperada');
    return null;
  }
}

/* ───────── Helpers ───────── */

const escapar = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const iniciais = nome => String(nome || '?')
  .trim().split(/\s+/).filter(Boolean)
  .map(p => p[0]).join('').toUpperCase().slice(0, 2);

const dataBR = d => {
  if (!d) return '—';
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  const [a, m, dia] = s.split('-');
  return dia ? `${dia}/${m}/${a}` : s;
};

const horaCurta = h => (h ? String(h).slice(0, 5) : '—');

const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const segParaHMS = seg => {
  const t = Math.max(0, Math.round(seg));
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
};

const hmsParaSeg = hms => {
  const [h = 0, m = 0, s = 0] = String(hms || '0').split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/** Hora local no formato HH:MM:SS — usada por ponto e cadenciador */
const agoraHMS = () => new Date().toTimeString().slice(0, 8);

/* ───────── Voz ───────── */

const Voz = {
  ativa: true,
  falar(texto) {
    if (!this.ativa || !texto || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const f = new SpeechSynthesisUtterance(texto);
    f.lang = 'pt-BR';
    f.rate = 1;
    f.volume = 1;
    window.speechSynthesis.speak(f);
  }
};

/* ───────── Manter a tela ligada (totem de chão de fábrica) ───────── */

let _travaTela = null;
async function manterTelaLigada() {
  if (!('wakeLock' in navigator) || _travaTela) return;
  try {
    _travaTela = await navigator.wakeLock.request('screen');
    _travaTela.addEventListener('release', () => { _travaTela = null; });
  } catch { /* o navegador pode negar; segue sem travar */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !_travaTela) manterTelaLigada();
});

/* ───────── Cabeçalho ───────── */

const MENU = [
  { href: '/',             rotulo: 'Portal' },
  { href: '/ponto',        rotulo: 'Ponto NFC' },
  { href: '/cadenciador',  rotulo: 'Cadenciador' },
  { href: '/progestao',    rotulo: 'ProGestão' }
];

let USUARIO = null;

async function montarTopo(opcoes = {}) {
  if (!document.querySelector('.fita-marca')) {
    const fita = document.createElement('div');
    fita.className = 'fita-marca';
    document.body.prepend(fita);
  }

  const alvo = document.getElementById('topo');
  if (!alvo) return;

  try { USUARIO = await API.get('/api/me'); } catch { return; }

  const atual = window.location.pathname;
  const ehAtual = href => href === '/' ? atual === '/' : atual.startsWith(href);

  const links = MENU.map(m =>
    `<a href="${m.href}"${ehAtual(m.href) ? ' aria-current="page"' : ''}>${m.rotulo}</a>`
  ).join('');

  const linkAdmin = USUARIO.role === 'admin'
    ? `<a href="/admin"${ehAtual('/admin') ? ' aria-current="page"' : ''}>Administração</a>` : '';

  alvo.className = 'topo';
  alvo.innerHTML = `
    <a class="marca" href="/">
      <img src="/assets/logo-decio.png" alt="Décio Indústria Metalúrgica">
      <div>
        <div class="marca-nome">Décio</div>
        <div class="marca-sub">${escapar(opcoes.subtitulo || 'Sistema Integrado da Montagem')}</div>
      </div>
    </a>
    <nav class="topo-nav" aria-label="Sistemas">${links}${linkAdmin}</nav>
    <div class="topo-dir">
      <span class="relogio num" id="relogioTopo">--:--:--</span>
      <div class="usuario">
        <div class="avatar" aria-hidden="true">${iniciais(USUARIO.nome)}</div>
        <div>
          <div class="usuario-nome">${escapar(USUARIO.nome || USUARIO.username)}</div>
          <div class="usuario-papel">${USUARIO.role === 'admin' ? 'Administrador' : 'Operação'}</div>
        </div>
      </div>
      <button class="btn btn-fantasma btn-sm" id="btnSair">Sair</button>
    </div>`;

  document.getElementById('btnSair').onclick = async () => {
    await API.post('/api/logout');
    window.location.href = '/login';
  };

  const rel = document.getElementById('relogioTopo');
  const tique = () => { rel.textContent = new Date().toLocaleTimeString('pt-BR'); };
  tique();
  setInterval(tique, 1000);

  return USUARIO;
}

/* ───────── Modal ───────── */

function abrirModal(id)  { document.getElementById(id)?.classList.add('aberto'); }
function fecharModal(id) { document.getElementById(id)?.classList.remove('aberto'); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-fundo.aberto').forEach(m => m.classList.remove('aberto'));
});
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-fundo')) e.target.classList.remove('aberto');
});
