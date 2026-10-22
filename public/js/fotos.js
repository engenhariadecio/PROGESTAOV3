/* ═══════════════════════════════════════════════════════
   DÉCIO — Fotos dos cadastros (ProGestão + Diário de Bordo)

   Uso numa página:
     <div id="fotos-ferr"></div>
     <script src="/js/fotos.js"></script>

     const galeria = Fotos.galeria('#fotos-ferr', { entidade: 'ferramenta', titulo: 'Fotos da ferramenta' });
     galeria.carregar(id)          // ao editar
     galeria.limpar()              // ao abrir um cadastro novo / cancelar
     await galeria.salvar(id)      // depois de salvar o registro (precisa do id)

     const mapa = await Fotos.mapa('ferramenta');   // { id_do_registro: [ids das fotos] }
     Fotos.miniaturas(mapa[f.id])                    // HTML das miniaturas para a tabela

   As imagens são reduzidas no navegador (lado maior 1600 px, JPEG) antes do
   envio: uma foto de celular de 5 MB vira ~300 KB. Isso também remove os
   metadados do arquivo, como a localização GPS.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const CFG = {
    ladoMax: 1600, qualidade: 0.82,
    ladoMini: 360, qualidadeMini: 0.72,
    maxPorRegistro: 20,
    maxArquivoMB: 40
  };

  /* ───────── Estilos (usam as variáveis de cor de cada página) ───────── */
  const css = `
.fx-editor{max-width:700px;margin-top:14px}
.fx-cab{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px}
.fx-cab label{font-size:.8rem;color:var(--text2,#A2BCC3)}
.fx-cont{font-size:.75rem;color:var(--text2,#A2BCC3);font-variant-numeric:tabular-nums}
.fx-zona{border:2px dashed var(--border,#1E3D52);border-radius:var(--radius,12px);padding:12px;background:var(--card2,#1A3347);transition:border-color .2s,background .2s}
.fx-zona.fx-sobre{border-color:var(--accent,#26B247);background:rgba(38,178,71,.07)}
.fx-grade{display:flex;flex-wrap:wrap;gap:10px}
.fx-item{position:relative;width:92px;height:92px;border-radius:9px;overflow:hidden;border:1px solid var(--border,#1E3D52);background:var(--card,#14293A);flex-shrink:0}
.fx-item img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.fx-item.fx-nova{border-color:var(--accent,#26B247)}
.fx-item.fx-nova::after{content:'nova';position:absolute;left:4px;bottom:4px;background:var(--accent,#26B247);color:#fff;font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:6px;pointer-events:none}
.fx-item.fx-falhou{border-color:var(--red,#F26D6D)}
.fx-item.fx-falhou::after{content:'não enviada';background:var(--red,#F26D6D)}
.fx-item.fx-proc{display:grid;place-items:center;color:var(--text2,#A2BCC3);font-size:.7rem;text-align:center;padding:6px}
.fx-item.fx-enviando img{opacity:.45}
.fx-item.fx-enviando::before{content:'';position:absolute;inset:50% auto auto 50%;width:22px;height:22px;margin:-11px 0 0 -11px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:fx-gira .8s linear infinite;z-index:1}
@keyframes fx-gira{to{transform:rotate(360deg)}}
.fx-x{position:absolute;top:4px;right:4px;width:24px;height:24px;border-radius:50%;border:none;background:rgba(10,22,32,.78);color:#fff;font-size:16px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
.fx-x:hover{background:var(--red,#F26D6D)}
.fx-mais{width:92px;height:92px;border-radius:9px;border:1px dashed var(--border,#1E3D52);background:transparent;color:var(--text2,#A2BCC3);font-size:1.6rem;cursor:pointer;flex-shrink:0}
.fx-mais:hover{border-color:var(--accent,#26B247);color:var(--accent,#26B247)}
.fx-dica{font-size:.76rem;color:var(--text2,#A2BCC3);margin-top:10px}
.fx-botoes{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.fx-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--border,#1E3D52);background:var(--card,#14293A);color:var(--text,#EAF4F1);font-size:.84rem;font-weight:600;cursor:pointer}
.fx-btn:hover{border-color:var(--accent,#26B247)}
.fx-thumbs{display:inline-flex;gap:4px;align-items:center;vertical-align:middle}
.fx-thumb{width:40px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--border,#1E3D52);cursor:zoom-in;background:var(--card2,#1A3347)}
.fx-thumb:hover{border-color:var(--accent,#26B247)}
.fx-mais-n{font-size:.72rem;font-weight:700;color:var(--text2,#A2BCC3);padding:0 2px}
.fx-sem{color:var(--text2,#A2BCC3);font-size:.78rem}
.fx-galeria{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:6px}
.fx-galeria img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border,#1E3D52);cursor:zoom-in}
.fx-visor{position:fixed;inset:0;z-index:10000;background:rgba(4,10,15,.94);display:none;flex-direction:column;touch-action:pan-y}
.fx-visor.fx-aberto{display:flex}
.fx-visor-topo{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;color:#EAF4F1;font-size:.9rem;gap:12px}
.fx-visor-topo a{color:#EAF4F1;font-size:.82rem;text-decoration:underline;text-underline-offset:3px}
.fx-visor-topo .fx-fechar{background:none;border:none;color:#EAF4F1;font-size:2rem;line-height:1;cursor:pointer;padding:0 4px}
.fx-palco{flex:1;display:flex;align-items:center;justify-content:center;position:relative;min-height:0;padding:0 56px 20px}
.fx-palco img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;user-select:none;-webkit-user-drag:none}
.fx-seta{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(20,41,58,.8);color:#fff;font-size:1.5rem;cursor:pointer;display:grid;place-items:center}
.fx-seta:hover{background:rgba(38,178,71,.85)}
.fx-seta[hidden]{display:none}
.fx-ant{left:8px}.fx-prox{right:8px}
@media(max-width:600px){.fx-palco{padding:0 8px 16px}.fx-seta{width:40px;height:40px;background:rgba(20,41,58,.6)}.fx-item,.fx-mais{width:78px;height:78px}}
@media(prefers-reduced-motion:reduce){.fx-item.fx-enviando::before{animation:none}}
`;
  const estilo = document.createElement('style');
  estilo.textContent = css;
  document.head.appendChild(estilo);

  /* ───────── Utilidades ───────── */

  const url = (id, mini) => '/api/fotos/arquivo/' + encodeURIComponent(id) + (mini ? '?mini=1' : '');
  const toqueEhPrincipal = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  async function pedir(metodo, caminho, corpo) {
    const r = await fetch(caminho, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json', 'Accept': 'application/json' } : { 'Accept': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    if (r.status === 401) { location.href = '/login'; throw new Error('Sessão expirada'); }
    let dados = null;
    try { dados = await r.json(); } catch (_) { /* sem corpo */ }
    if (!r.ok) throw new Error((dados && dados.error) || ('Erro ' + r.status));
    return dados;
  }

  function carregarImagem(arquivo) {
    return new Promise((ok, falha) => {
      const endereco = URL.createObjectURL(arquivo);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(endereco); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(endereco); falha(new Error('formato não suportado')); };
      img.src = endereco;
    });
  }

  /** Desenha a imagem reduzida num canvas. O navegador já aplica a rotação EXIF. */
  function reduzir(img, ladoMax, qualidade) {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const escala = Math.min(1, ladoMax / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * escala));
    const h = Math.max(1, Math.round(h0 * escala));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';               // PNG transparente não vira fundo preto
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { dataURL: cv.toDataURL('image/jpeg', qualidade), largura: w, altura: h };
  }

  async function prepararArquivo(arquivo) {
    if (!arquivo.type || !arquivo.type.startsWith('image/')) {
      throw new Error('"' + arquivo.name + '" não é uma imagem');
    }
    if (arquivo.size > CFG.maxArquivoMB * 1024 * 1024) {
      throw new Error('"' + arquivo.name + '" passa de ' + CFG.maxArquivoMB + ' MB');
    }
    let img;
    try { img = await carregarImagem(arquivo); }
    catch (_) { throw new Error('"' + arquivo.name + '": formato não suportado neste navegador (use JPG ou PNG)'); }
    const grande = reduzir(img, CFG.ladoMax, CFG.qualidade);
    const mini = reduzir(img, CFG.ladoMini, CFG.qualidadeMini);
    return { imagem: grande.dataURL, miniatura: mini.dataURL, largura: grande.largura, altura: grande.altura };
  }

  function avisar(texto, tipo) {
    // Cada página do ProGestão tem seu toast(); o portal/admin tem aviso()
    if (typeof window.toast === 'function') return window.toast(texto, tipo === 'erro' ? 'error' : undefined);
    if (typeof window.aviso === 'function') return window.aviso(texto, tipo === 'erro' ? 'erro' : 'ok');
    if (tipo === 'erro') alert(texto);
  }

  /* ───────── Visualizador (tela cheia) ───────── */

  const Visor = {
    el: null, ids: [], i: 0,

    montar() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'fx-visor';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Visualizar foto');
      el.innerHTML =
        '<div class="fx-visor-topo"><span class="fx-contador"></span>' +
        '<span style="display:flex;align-items:center;gap:16px"><a class="fx-original" target="_blank" rel="noopener">Abrir em tamanho real</a>' +
        '<button type="button" class="fx-fechar" aria-label="Fechar">×</button></span></div>' +
        '<div class="fx-palco"><button type="button" class="fx-seta fx-ant" aria-label="Foto anterior">‹</button>' +
        '<img alt=""><button type="button" class="fx-seta fx-prox" aria-label="Próxima foto">›</button></div>';
      document.body.appendChild(el);
      this.el = el;

      el.querySelector('.fx-fechar').onclick = () => this.fechar();
      el.querySelector('.fx-ant').onclick = (e) => { e.stopPropagation(); this.ir(-1); };
      el.querySelector('.fx-prox').onclick = (e) => { e.stopPropagation(); this.ir(1); };
      el.querySelector('.fx-palco').addEventListener('click', (e) => { if (e.target.classList.contains('fx-palco')) this.fechar(); });

      document.addEventListener('keydown', (e) => {
        if (!this.el.classList.contains('fx-aberto')) return;
        if (e.key === 'Escape') { e.stopPropagation(); this.fechar(); }
        else if (e.key === 'ArrowLeft') this.ir(-1);
        else if (e.key === 'ArrowRight') this.ir(1);
      }, true);

      let x0 = null;
      el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      el.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 50) this.ir(dx < 0 ? 1 : -1);
        x0 = null;
      });
    },

    abrir(ids, inicio) {
      if (!ids || !ids.length) return;
      this.montar();
      this.ids = ids.slice();
      this.i = Math.min(Math.max(0, inicio || 0), ids.length - 1);
      this.el.classList.add('fx-aberto');
      document.body.style.overflow = 'hidden';
      this.mostrar();
      this.el.querySelector('.fx-fechar').focus();
    },

    mostrar() {
      const alvo = this.ids[this.i];
      const img = this.el.querySelector('.fx-palco img');
      // alvo pode ser um id do servidor ou um dataURL de foto ainda não enviada
      const ehLocal = typeof alvo === 'string' && alvo.startsWith('data:');
      img.src = ehLocal ? alvo : url(alvo);
      const orig = this.el.querySelector('.fx-original');
      orig.hidden = ehLocal;
      if (!ehLocal) orig.href = url(alvo);
      this.el.querySelector('.fx-contador').textContent = this.ids.length > 1 ? (this.i + 1) + ' de ' + this.ids.length : '';
      this.el.querySelector('.fx-ant').hidden = this.ids.length < 2;
      this.el.querySelector('.fx-prox').hidden = this.ids.length < 2;
      // pré-carrega as vizinhas para a troca ser instantânea
      [this.i - 1, this.i + 1].forEach(j => {
        const v = this.ids[(j + this.ids.length) % this.ids.length];
        if (v !== undefined && !(typeof v === 'string' && v.startsWith('data:'))) { const p = new Image(); p.src = url(v); }
      });
    },

    ir(passo) {
      if (this.ids.length < 2) return;
      this.i = (this.i + passo + this.ids.length) % this.ids.length;
      this.mostrar();
    },

    fechar() {
      this.el.classList.remove('fx-aberto');
      this.el.querySelector('.fx-palco img').removeAttribute('src');
      document.body.style.overflow = '';
    }
  };

  // Clique em qualquer miniatura gerada por Fotos.miniaturas() / Fotos.grade()
  document.addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-fx-ids]');
    if (!alvo) return;
    e.preventDefault();
    const ids = alvo.getAttribute('data-fx-ids').split(',').map(Number).filter(Boolean);
    Visor.abrir(ids, Number(alvo.getAttribute('data-fx-i')) || 0);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-fx-ids]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  /* ───────── Editor de fotos de um cadastro ───────── */

  function galeria(seletor, opcoes) {
    const raiz = typeof seletor === 'string' ? document.querySelector(seletor) : seletor;
    if (!raiz) throw new Error('Fotos.galeria: elemento não encontrado: ' + seletor);

    const op = Object.assign({ titulo: 'Fotos', max: CFG.maxPorRegistro }, opcoes || {});
    if (!op.entidade) throw new Error('Fotos.galeria: informe a entidade');

    let existentes = [];     // [{ id }]
    let removidas = [];      // ids a excluir no salvar
    let novas = [];          // [{ chave, imagem, miniatura, largura, altura, estado }]
    let processando = 0;
    let registroAtual = null;
    let geracao = 0;         // descarta carregamentos atrasados quando o formulário muda
    let seq = 0;

    const camera = toqueEhPrincipal();
    raiz.classList.add('fx-editor');
    raiz.innerHTML =
      '<div class="fx-cab"><label>' + op.titulo + '</label><span class="fx-cont"></span></div>' +
      '<div class="fx-zona"><div class="fx-grade"></div>' +
      '<div class="fx-dica">' + (camera
        ? 'Tire uma foto ou escolha da galeria do celular.'
        : 'Arraste imagens para cá, cole com Ctrl+V ou clique em +.') + '</div></div>' +
      '<div class="fx-botoes">' +
      (camera ? '<button type="button" class="fx-btn fx-b-cam">📷 Tirar foto</button>' : '') +
      '<button type="button" class="fx-btn fx-b-arq">🖼 Escolher imagens</button></div>' +
      '<input type="file" accept="image/*" multiple hidden class="fx-in-arq">' +
      '<input type="file" accept="image/*" capture="environment" hidden class="fx-in-cam">';

    const zona = raiz.querySelector('.fx-zona');
    const grade = raiz.querySelector('.fx-grade');
    const contador = raiz.querySelector('.fx-cont');
    const inArq = raiz.querySelector('.fx-in-arq');
    const inCam = raiz.querySelector('.fx-in-cam');

    raiz.querySelector('.fx-b-arq').onclick = () => inArq.click();
    if (camera) raiz.querySelector('.fx-b-cam').onclick = () => inCam.click();
    inArq.onchange = () => { adicionar(inArq.files); inArq.value = ''; };
    inCam.onchange = () => { adicionar(inCam.files); inCam.value = ''; };

    zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('fx-sobre'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('fx-sobre'));
    zona.addEventListener('drop', (e) => {
      e.preventDefault(); zona.classList.remove('fx-sobre');
      if (e.dataTransfer && e.dataTransfer.files.length) adicionar(e.dataTransfer.files);
    });

    // Ctrl+V com um print na área de transferência — só quando o formulário está visível
    document.addEventListener('paste', (e) => {
      if (!raiz.offsetParent) return;
      const itens = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const arquivos = itens.filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
      if (!arquivos.length) return;
      e.preventDefault();
      adicionar(arquivos);
    });

    const totalAtual = () => existentes.length + novas.length + processando;

    function render() {
      const idsVisor = existentes.map(f => f.id);
      let html = existentes.map((f, i) =>
        '<div class="fx-item"><img src="' + url(f.id, true) + '" alt="Foto ' + (i + 1) + '" loading="lazy" data-fx-ids="' + idsVisor.join(',') + '" data-fx-i="' + i + '">' +
        '<button type="button" class="fx-x" data-rem-existente="' + f.id + '" aria-label="Remover foto" title="Remover">×</button></div>'
      ).join('');
      html += novas.map(n =>
        '<div class="fx-item fx-nova' + (n.estado === 'enviando' ? ' fx-enviando' : '') + (n.estado === 'falhou' ? ' fx-falhou' : '') + '"' +
        (n.erro ? ' title="' + String(n.erro).replace(/"/g, '&quot;') + '"' : '') + '>' +
        '<img src="' + n.miniatura + '" alt="Foto nova" data-local="' + n.chave + '">' +
        (n.estado === 'enviando' ? '' : '<button type="button" class="fx-x" data-rem-nova="' + n.chave + '" aria-label="Remover foto" title="Remover">×</button>') +
        '</div>'
      ).join('');
      for (let i = 0; i < processando; i++) html += '<div class="fx-item fx-proc">Preparando…</div>';
      if (totalAtual() < op.max) html += '<button type="button" class="fx-mais" aria-label="Adicionar fotos" title="Adicionar fotos">+</button>';
      grade.innerHTML = html;

      const n = existentes.length + novas.length;
      contador.textContent = n ? n + (n === 1 ? ' foto' : ' fotos') + ' · máx. ' + op.max : '';
    }

    grade.addEventListener('click', (e) => {
      const remE = e.target.closest('[data-rem-existente]');
      if (remE) {
        const id = Number(remE.getAttribute('data-rem-existente'));
        existentes = existentes.filter(f => f.id !== id);
        removidas.push(id);
        return render();
      }
      const remN = e.target.closest('[data-rem-nova]');
      if (remN) {
        const ch = remN.getAttribute('data-rem-nova');
        novas = novas.filter(n => n.chave !== ch);
        return render();
      }
      const local = e.target.closest('[data-local]');
      if (local) {
        const lista = novas.map(n => n.imagem);
        const i = novas.findIndex(n => n.chave === local.getAttribute('data-local'));
        Visor.abrir(lista, Math.max(0, i));
        return;
      }
      if (e.target.closest('.fx-mais')) inArq.click();
    });

    async function adicionar(listaArquivos) {
      const arquivos = Array.from(listaArquivos || []);
      if (!arquivos.length) return;
      const vagas = op.max - totalAtual();
      if (vagas <= 0) return avisar('Limite de ' + op.max + ' fotos por registro', 'erro');
      if (arquivos.length > vagas) avisar('Só cabem mais ' + vagas + ' foto(s) — as demais foram ignoradas', 'erro');

      const minhaGeracao = geracao;
      const lote = arquivos.slice(0, vagas);
      processando += lote.length;
      render();
      for (const arq of lote) {
        try {
          const p = await prepararArquivo(arq);
          if (minhaGeracao !== geracao) return;   // formulário foi limpo nesse meio-tempo
          novas.push(Object.assign({ chave: 'n' + (++seq), estado: 'pendente' }, p));
        } catch (err) {
          if (minhaGeracao === geracao) avisar(err.message, 'erro');
        } finally {
          if (minhaGeracao === geracao) { processando--; render(); }
        }
      }
    }

    const api = {
      /** Mostra as fotos já salvas de um registro (ao abrir para edição). */
      async carregar(registroId) {
        api.limpar();
        registroAtual = registroId;
        const minhaGeracao = geracao;
        if (!registroId) return;
        try {
          const lista = await pedir('GET', '/api/fotos/' + op.entidade + '/' + registroId);
          if (minhaGeracao !== geracao) return;
          existentes = (lista || []).map(f => ({ id: f.id }));
          render();
        } catch (e) { avisar('Não foi possível carregar as fotos: ' + e.message, 'erro'); }
      },

      /** Esvazia o editor (cadastro novo ou cancelar). Descarta o que não foi salvo. */
      limpar() {
        geracao++;
        existentes = []; removidas = []; novas = []; processando = 0; registroAtual = null;
        render();
      },

      /** Há fotos novas ou removidas ainda não gravadas? */
      temAlteracoes() { return novas.length > 0 || removidas.length > 0; },

      /** Ainda está comprimindo alguma imagem? */
      ocupado() { return processando > 0; },

      /**
       * Grava as alterações no registro `registroId`. Chame depois de salvar o
       * cadastro (é quando se tem o id). Envia uma foto por vez para não
       * sobrecarregar a rede do chão de fábrica.
       * Retorna { enviadas, falhas }.
       */
      async salvar(registroId) {
        registroId = registroId || registroAtual;
        if (!registroId) throw new Error('Fotos.salvar: informe o id do registro');
        while (processando > 0) await new Promise(r => setTimeout(r, 150));

        let enviadas = 0, falhas = 0;
        for (const id of removidas.slice()) {
          try { await pedir('DELETE', '/api/fotos/arquivo/' + id); removidas = removidas.filter(x => x !== id); }
          catch (_) { falhas++; }
        }
        for (const n of novas.slice()) {
          if (n.estado === 'enviado') continue;
          n.estado = 'enviando'; n.erro = null; render();
          try {
            const r = await pedir('POST', '/api/fotos/' + op.entidade + '/' + registroId, {
              imagem: n.imagem, miniatura: n.miniatura, largura: n.largura, altura: n.altura
            });
            novas = novas.filter(x => x !== n);
            existentes.push({ id: r.id });
            enviadas++;
          } catch (e) {
            n.estado = 'falhou'; n.erro = e.message; falhas++;
          }
          render();
        }
        registroAtual = registroId;
        if (falhas) avisar(falhas + ' foto(s) não foram salvas. Abra o registro e tente de novo.', 'erro');
        return { enviadas, falhas };
      }
    };

    render();
    return api;
  }

  /* ───────── Listagens ───────── */

  /** { id_do_registro: [ids] } de uma entidade inteira, numa chamada só. */
  async function mapa(entidade) {
    try { return (await pedir('GET', '/api/fotos/' + entidade)) || {}; }
    catch (_) { return {}; }
  }

  /** Miniaturas para uma célula de tabela. Clique abre o visualizador. */
  function miniaturas(ids, opcoes) {
    const op = Object.assign({ max: 3, vazio: '<span class="fx-sem">—</span>' }, opcoes || {});
    if (!ids || !ids.length) return op.vazio;
    const lista = ids.join(',');
    const mostrar = ids.slice(0, op.max);
    let html = '<span class="fx-thumbs">' + mostrar.map((id, i) =>
      '<img class="fx-thumb" tabindex="0" src="' + url(id, true) + '" loading="lazy" alt="Foto ' + (i + 1) + ' de ' + ids.length + '" data-fx-ids="' + lista + '" data-fx-i="' + i + '">'
    ).join('');
    if (ids.length > op.max) {
      html += '<span class="fx-mais-n" role="button" tabindex="0" data-fx-ids="' + lista + '" data-fx-i="' + op.max + '" title="Ver todas">+' + (ids.length - op.max) + '</span>';
    }
    return html + '</span>';
  }

  /** Grade maior, para janelas de detalhe. */
  function grade(ids) {
    if (!ids || !ids.length) return '';
    const lista = ids.join(',');
    return '<div class="fx-galeria">' + ids.map((id, i) =>
      '<img tabindex="0" src="' + url(id, true) + '" loading="lazy" alt="Foto ' + (i + 1) + '" data-fx-ids="' + lista + '" data-fx-i="' + i + '">'
    ).join('') + '</div>';
  }

  window.Fotos = { galeria, mapa, miniaturas, grade, abrir: (ids, i) => Visor.abrir(ids, i), url };
})();
