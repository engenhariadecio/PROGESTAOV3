/* ═══════════════════════════════════════════════════════════════
   CONTADOR POR CÂMERA — motor compartilhado (tablet do cadenciador
   e celular avulso usam este mesmo código).

   ─ Cada caixa colocada no pallet muda uma parte da área marcada
     (onde antes era fundo/madeira, agora é caixa).
   ─ A IA (MediaPipe Pose, no próprio aparelho) detecta a pessoa. Enquanto
     há pessoa/movimento sobre a área, esperamos.
   ─ Área livre e parada por ~3 s → compara com a referência: mudou pelo
     menos uma fração de caixa → +1 (nova referência, foto de evidência);
     mudou "muitas caixas" → troca de pallet; não mudou → nada.
   ─ A configuração vem do servidor (linha + produto) e é reaplicada
     quando muda; comandos remotos chegam pelo mesmo canal.

   Uso:
     const cam = ContadorCam.criar({ video, canvas, flash, hud: { ia, estado, live },
                                     onContagem(n), onEvento(ev), onEstado(txt), onConfig(cfg) });
     await cam.conectar({ linhaId, produtoId, sessaoId });
     cam.registrar('manual_mais') … cam.parar()
   Requer core.js (API, avisoOk/avisoErro) e, se disponível, pose.js.
   ═══════════════════════════════════════════════════════════════ */
window.ContadorCam = (function () {
  const PROC_W = 320, PROC_H = 240, REF_W = 96, REF_H = 72, ENVIO_MS = 700, POLL_MS = 1500;
  const RES = { baixa: { w: 640, h: 480 }, media: { w: 1280, h: 960 }, alta: { w: 1920, h: 1440 } };
  const CFG_PADRAO = { zona: null, caixa: null, sens: 5, camera: '', zoom: null, lanterna: false, resolucao: 'media', multiplas: false };
  const disp = (navigator.userAgent.match(/\((.*?)\)/) || [])[1] || 'aparelho';

  function criar(o) {
    const video = o.video, sobre = o.canvas, sctx = sobre ? sobre.getContext('2d') : null;
    const proc = document.createElement('canvas'); proc.width = PROC_W; proc.height = PROC_H;
    const pctx = proc.getContext('2d', { willReadFrequently: true });
    const envio = document.createElement('canvas'); envio.width = 640; envio.height = 480;   // também vira amostra de treino: resolução conta
    const ectx = envio.getContext('2d');

    const S = {   // estado interno
      linha: null, linhaId: null, produtoId: null, sessaoId: null, sessao: null, stream: null, pose: null,
      cfg: { ...CFG_PADRAO }, cfgTs: null, zona: null, ref: null, refAnterior: null,
      estado: 'calibrando', livreDesde: 0, confirmandoDesde: 0, ultimaContagemTs: 0, ultimoQuadro: null, pessoaBox: null,
      contagem: 0, eventos: [], fila: [], pausado: false, ultimoEnvio: 0, ultimoPose: 0, posePronto: false, poseOcupado: false, iaOk: false,
      capacidades: null, capEnviadas: false, zonaEditadaLocal: false, desenhando: null, ativo: false, timers: [], fps: 0, fpsT: 0, fpsN: 0, raf: 0,
      tamanhos: [], fundo: null, caixaCor: null,
      modelo: null, modeloId: null, modeloCarregando: false, dets: [], detOcupado: false, ultimaDet: 0, contEstavel: null, histCont: [], detErro: null, pallet: null, histPallet: [], probCom: null, areaAuto: null, palletBox: null, palletOk: null, contAtual: {}, temClassePallet: false, chaveEstavel: null, palletEstavel: null, maos: [], ultimaMao: null, ultimaPresenca: null, ajustes: 0
    };
    try { S.fila = JSON.parse(localStorage.getItem('contador.fila') || '[]'); } catch (_) {}
    const hud = (k, txt, cls) => { const el = o.hud && o.hud[k]; if (!el) return; if (txt != null) el.textContent = txt; if (cls != null) el.className = 'selo-hud ' + cls; };

    /* ───────── câmera ───────── */
    async function abrirCamera() {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      const r = RES[S.cfg.resolucao] || RES.media, base = { width: { ideal: r.w }, height: { ideal: r.h } };
      const tentativas = [];
      if (S.cfg.camera) tentativas.push({ deviceId: { exact: S.cfg.camera }, ...base });
      tentativas.push({ facingMode: { ideal: 'environment' }, ...base }, { ...base }, true);
      let erro = null;
      for (const v of tentativas) { try { S.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); erro = null; break; } catch (e) { erro = e; } }
      if (erro) throw erro;
      video.srcObject = S.stream; await video.play().catch(() => {});
      S.ref = null; S.estado = 'calibrando'; S.livreDesde = 0;
      await lerCapacidades(); aplicarAjustesCamera();
    }
    async function lerCapacidades() {
      const track = S.stream && S.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      const st = track && track.getSettings ? track.getSettings() : {};
      let cameras = [];
      try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || 'Câmera ' + (i + 1) })); } catch (_) {}
      S.capacidades = { cameras, camera_atual: st.deviceId || '', zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, atual: st.zoom } : null,
        lanterna: !!caps.torch, largura: st.width, altura: st.height, ia: S.iaOk };
      S.capEnviadas = false;
    }
    async function aplicarAjustesCamera() {
      const track = S.stream && S.stream.getVideoTracks()[0]; if (!track || !track.applyConstraints) return;
      const adv = [];
      if (S.capacidades && S.capacidades.zoom && S.cfg.zoom != null) adv.push({ zoom: Math.min(S.capacidades.zoom.max, Math.max(S.capacidades.zoom.min, Number(S.cfg.zoom))) });
      if (S.capacidades && S.capacidades.lanterna) adv.push({ torch: !!S.cfg.lanterna });
      if (adv.length) { try { await track.applyConstraints({ advanced: adv }); } catch (e) { console.warn('ajuste câmera', e); } }
    }
    function iniciarPose() {
      if (typeof Pose === 'undefined') { if (!S.modelo) hud('ia', 'IA de pessoas indisponível — usando só movimento', 'alerta'); return; }
      try {
        S.pose = new Pose({ locateFile: f => '/js/mediapipe/pose/' + f });
        S.pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        S.pose.onResults(r => {
          S.iaOk = true; if (!S.modelo) hud('ia', 'IA: pessoa ' + (r.poseLandmarks ? 'detectada' : 'não'), r.poseLandmarks ? 'on' : '');
          if (!r.poseLandmarks) { S.pessoaBox = null; S.maos = []; return; }
          // pulsos e pontas dos dedos (15, 16, 19, 20): é a mão que coloca/tira a peça
          S.maos = [15, 16, 19, 20].map(i => r.poseLandmarks[i]).filter(l => l && (l.visibility || 0) > 0.4).map(l => ({ x: l.x, y: l.y }));
          const agora = performance.now(), za = areaAtiva();
          if (za && S.maos.some(m => m.x >= za.x - 0.04 && m.x <= za.x + za.w + 0.04 && m.y >= za.y - 0.04 && m.y <= za.y + za.h + 0.04)) S.ultimaMao = agora;
          const vis = r.poseLandmarks.filter(l => (l.visibility || 0) > 0.5);
          if (vis.length < 4) { S.pessoaBox = null; return; }
          const xs = vis.map(l => l.x), ys = vis.map(l => l.y);
          S.pessoaBox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        });
        S.pose.initialize().then(() => { S.posePronto = true; S.iaOk = true; if (S.capacidades) S.capacidades.ia = true; S.capEnviadas = false; if (!S.modelo) hud('ia', 'IA: pronta', ''); })
          .catch(e => { console.warn('Pose', e); if (!S.modelo) hud('ia', 'IA de pessoas indisponível — usando só movimento', 'alerta'); S.pose = null; });
      } catch (e) { if (!S.modelo) hud('ia', 'IA de pessoas indisponível — usando só movimento', 'alerta'); S.pose = null; }
    }

    /* ───────── servidor: config + comandos ───────── */
    function urlEstado() { return `/api/contador/linhas/${S.linhaId}/estado?produto_id=${S.produtoId || ''}&sessao_id=${S.sessaoId || ''}`; }
    async function sincronizar(primeira) {
      const e = await API.get(urlEstado());
      S.sessao = e.sessao; S.linha = { ...(S.linha || {}), ...e.linha };
      if (primeira || e.config_ts !== S.cfgTs) { S.cfgTs = e.config_ts; aplicarConfig(e.config, primeira); }
      if (!primeira && e.contagem !== S.contagem && !S.fila.length) { S.contagem = e.contagem; o.onContagem && o.onContagem(S.contagem); }
      for (const c of e.comandos || []) executarComando(c);
      const mid = e.modelo ? e.modelo.id : null;
      if (mid !== S.modeloId && !S.modeloCarregando) carregarModelo(e.modelo);
      o.onSessao && o.onSessao(S.sessao, S.contagem, S.eventos);
    }
    function aplicarConfig(novo, primeira) {
      const ant = S.cfg; S.cfg = { ...S.cfg, ...novo };
      const zonaMudou = JSON.stringify(S.cfg.zona) !== JSON.stringify(S.zona);
      if (zonaMudou && !S.zonaEditadaLocal) { S.zona = S.cfg.zona ? { ...S.cfg.zona } : null; S.ref = null; S.estado = 'calibrando'; S.livreDesde = 0; }
      S.zonaEditadaLocal = false;
      if (!primeira && S.stream) {
        if (S.cfg.camera !== ant.camera || S.cfg.resolucao !== ant.resolucao) abrirCamera().catch(e => avisoErro('Câmera: ' + e.message));
        else if (S.cfg.zoom !== ant.zoom || S.cfg.lanterna !== ant.lanterna) aplicarAjustesCamera();
      }
      o.onConfig && o.onConfig(S.cfg, S.zona);
    }
    function executarComando(c) {
      if (c.tipo === 'recalibrar') { recalibrar(); avisoOk('Recalibrando (comando do painel)'); }
      else if (c.tipo === 'troca_pallet') { recalibrar(); registrar('troca_pallet', 0, null); }
      else if (c.tipo === 'mais') registrar('manual_mais', 1, null);
      else if (c.tipo === 'menos') { if (S.contagem > 0) registrar('manual_menos', -1, null); }
      else if (c.tipo === 'reiniciar_camera') abrirCamera().catch(e => avisoErro('Câmera: ' + e.message));
      else if (c.tipo === 'encerrar') { parar(); o.onEncerrar && o.onEncerrar(); }
    }
    function recalibrar() { S.ref = null; S.refAnterior = null; S.fundo = null; S.estado = 'calibrando'; S.livreDesde = 0; S.contEstavel = null; S.chaveEstavel = null; S.histCont = []; S.pallet = null; S.histPallet = []; S.areaAuto = null; }

    /* ───────── análise da área ───────── */
    const COR_CLASSE = { caixa: '#F0B429', peca: '#56B6E0', pallet: '#A78BFA', objeto: '#35C95C' };
    const ROTULO_CLASSE = { caixa: 'CAIXA', peca: 'PEÇA', pallet: 'PALLET', objeto: 'OBJETO' };
    function resumoPallet() {
      const c = S.contAtual || {}, partes = [];
      if (c.caixa) partes.push(c.caixa + (c.caixa > 1 ? ' caixas' : ' caixa'));
      if (c.peca) partes.push(c.peca + (c.peca > 1 ? ' peças' : ' peça'));
      if (c.objeto) partes.push(c.objeto + ' objeto(s)');
      if (S.temClassePallet && !S.palletOk) return 'sem pallet' + (partes.length ? ' · ' + partes.join(', ') : '');
      return partes.length ? (S.temClassePallet ? 'pallet com ' : '') + partes.join(', ') : (S.temClassePallet ? 'PALLET VAZIO' : 'nada');
    }
    /* área onde as caixas/peças contam: a marcada à mão; sem ela, a "coluna" acima do pallet que a IA achou */
    function areaAtiva() { return S.zona || S.areaAuto || null; }
    function zonaPx() { const z = areaAtiva(); return { x: Math.round(z.x * PROC_W), y: Math.round(z.y * PROC_H), w: Math.max(8, Math.round(z.w * PROC_W)), h: Math.max(8, Math.round(z.h * PROC_H)) }; }
    const N = REF_W * REF_H;
    /* a área reduzida a REF_W×REF_H: cinza (g) para detectar mudança e cor média (rgb) para decidir colocada × retirada */
    function amostraZona() {
      const z = zonaPx(); const img = pctx.getImageData(z.x, z.y, z.w, z.h).data;
      const g = new Float32Array(N), rgb = new Float32Array(N * 3);
      for (let j = 0; j < REF_H; j++) for (let i = 0; i < REF_W; i++) {
        let r = 0, gg = 0, b = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(z.w - 1, Math.floor((i + dx * .5) * z.w / REF_W)), py = Math.min(z.h - 1, Math.floor((j + dy * .5) * z.h / REF_H));
          const k = (py * z.w + px) * 4; r += img[k]; gg += img[k + 1]; b += img[k + 2]; n++;
        }
        const c = j * REF_W + i; rgb[c * 3] = r / n; rgb[c * 3 + 1] = gg / n; rgb[c * 3 + 2] = b / n;
        g[c] = (r * 0.299 + gg * 0.587 + b * 0.114) / n;
      }
      return { g, rgb };
    }
    function comparar(a, b, lim) { let mud = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > lim) mud++; return { frac: mud / a.length }; }
    /* manchas de mudança entre a amostra atual e a referência: cada caixa colocada/retirada vira uma mancha compacta */
    function manchas(atual, ref, lim) {
      const m = new Uint8Array(N), m2 = new Uint8Array(N);
      // diferença por cor (maior desvio entre R, G e B): papelão sobre piso cinza tem o mesmo brilho, mas não a mesma cor
      for (let i = 0; i < N; i++) { const k = i * 3; const d = Math.max(Math.abs(atual.rgb[k] - ref.rgb[k]), Math.abs(atual.rgb[k + 1] - ref.rgb[k + 1]), Math.abs(atual.rgb[k + 2] - ref.rgb[k + 2])); m[i] = d > lim ? 1 : 0; }
      // limpeza: tira pontos isolados e fecha buracos pequenos
      for (let j = 0; j < REF_H; j++) for (let i = 0; i < REF_W; i++) {
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const x = i + dx, y = j + dy; if (x >= 0 && y >= 0 && x < REF_W && y < REF_H && m[y * REF_W + x]) v++; }
        const c = j * REF_W + i; m2[c] = m[c] ? (v >= 3 ? 1 : 0) : (v >= 6 ? 1 : 0);
      }
      // componentes conexos (4 vizinhos)
      const vis = new Uint8Array(N), lista = []; const fila = new Int32Array(N);
      let total = 0;
      for (let s = 0; s < N; s++) {
        if (!m2[s] || vis[s]) continue;
        let h = 0, q = 0; fila[q++] = s; vis[s] = 1;
        const cel = []; let x0 = REF_W, x1 = 0, y0 = REF_H, y1 = 0;
        while (h < q) {
          const c = fila[h++]; cel.push(c); const x = c % REF_W, y = (c / REF_W) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          const viz = [c - 1, c + 1, c - REF_W, c + REF_W];
          if (x === 0) viz[0] = -1; if (x === REF_W - 1) viz[1] = -1;
          for (const v of viz) if (v >= 0 && v < N && m2[v] && !vis[v]) { vis[v] = 1; fila[q++] = v; }
        }
        total += cel.length;
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        lista.push({ cel, area: cel.length, bw, bh, fill: cel.length / (bw * bh), y0, y1 });
      }
      lista.sort((a, b) => b.area - a.area);
      return { lista, frac: total / N };
    }
    const mediaRGB = (rgb, cel) => { let r = 0, g = 0, b = 0; for (const c of cel) { r += rgb[c * 3]; g += rgb[c * 3 + 1]; b += rgb[c * 3 + 2]; } const n = cel.length || 1; return [r / n, g / n, b / n]; };
    const distRGB = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    /* modelo de fundo: a faixa de cima da área (que deve ficar acima da pilha mais alta) na hora da calibração */
    function modeloFundo(am) {
      const cel = []; for (let j = 0; j < Math.max(2, Math.floor(REF_H * 0.22)); j++) for (let i = 0; i < REF_W; i++) cel.push(j * REF_W + i);
      S.fundo = mediaRGB(am.rgb, cel);
    }
    /* decide o que a mancha virou: ficou parecida com o fundo → retirada; senão → colocada */
    function direcao(mancha, atual, ref) {
      const cur = mediaRGB(atual.rgb, mancha.cel), ant = mediaRGB(ref.rgb, mancha.cel);
      if (!S.fundo) return +1;
      const dCur = distRGB(cur, S.fundo), dAnt = distRGB(ant, S.fundo);
      if (window.CAM_DEBUG) console.log('DIR', JSON.stringify({ area: mancha.area, y0: mancha.y0, y1: mancha.y1, cur: cur.map(Math.round), ant: ant.map(Math.round), fundo: S.fundo.map(Math.round), dCur: Math.round(dCur), dAnt: Math.round(dAnt) }));
      if (dCur < dAnt * 0.8) return -1;
      if (dCur > dAnt * 1.25) return +1;
      if (S.caixaCor) { return distRGB(cur, S.caixaCor) <= distRGB(cur, S.fundo) ? +1 : -1; }   // ambíguo: parece caixa ou fundo?
      return +1;
    }
    function aprenderCaixa(mancha, atual) {
      S.tamanhos.push(mancha.area); if (S.tamanhos.length > 20) S.tamanhos.shift();
      const cor = mediaRGB(atual.rgb, mancha.cel);
      S.caixaCor = S.caixaCor ? S.caixaCor.map((v, i) => v * 0.7 + cor[i] * 0.3) : cor;
    }
    const mediana = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[(s.length / 2) | 0]; };
    function sobrepoe(bx) {
      const z = areaAtiva(); if (!bx || !z) return false;
      const ix = Math.max(0, Math.min(bx.x + bx.w, z.x + z.w) - Math.max(bx.x, z.x)), iy = Math.max(0, Math.min(bx.y + bx.h, z.y + z.h) - Math.max(bx.y, z.y));
      return ix * iy > 0.02 * z.w * z.h;
    }
    /* tamanho mínimo de uma mancha para valer como caixa (em células) — aprende sozinho; o tamanho marcado é só opcional */
    function limiares() {
      const s = S.cfg.sens || 5, z = S.zona;
      let min = N * (0.004 + (10 - s) * 0.0015), tipico = null;
      const med = S.tamanhos.length >= 3 ? mediana(S.tamanhos) : null;
      if (S.cfg.caixa && z && z.w * z.h > 0) { tipico = N * (S.cfg.caixa.w * S.cfg.caixa.h) / (z.w * z.h); min = Math.max(min * 0.5, tipico * 0.3); }
      else if (med) { tipico = med; min = Math.max(min, med * 0.35); }
      return { min, tipico };
    }
    function loop(t) {
      if (!S.ativo) return;
      S.raf = requestAnimationFrame(loop);
      if (!video.videoWidth) return;
      S.fpsN++; if (t - S.fpsT > 1000) { S.fps = S.fpsN; S.fpsN = 0; S.fpsT = t; }
      pctx.drawImage(video, 0, 0, PROC_W, PROC_H);
      if (S.pose && S.posePronto && !S.poseOcupado && t - S.ultimoPose > 180) { S.ultimoPose = t; S.poseOcupado = true; S.pose.send({ image: proc }).catch(() => {}).finally(() => { S.poseOcupado = false; }); }
      if (S.modelo && !S.detOcupado && t - S.ultimaDet > 600 && !S.pausado) { S.ultimaDet = t; detectar(t); }
      if (S.zona && !S.pausado && !S.modelo) analisar(t);
      desenhar();
      if (t - S.ultimoEnvio > ENVIO_MS) { S.ultimoEnvio = t; enviarQuadro(); }
    }
    function analisar(t) {
      const atual = amostraZona(), L = limiares(), limMov = 14 + (10 - (S.cfg.sens || 5)) * 2;
      const mov = S.ultimoQuadro ? comparar(atual.g, S.ultimoQuadro.g, limMov).frac : 0;
      S.ultimoQuadro = atual;
      const presenca = mov > 0.015 || sobrepoe(S.pessoaBox);
      if (S.estado === 'calibrando') {
        if (!presenca) { if (!S.livreDesde) S.livreDesde = t; if (t - S.livreDesde > 1500) { S.ref = atual; S.refAnterior = null; modeloFundo(atual); S.estado = 'livre'; S.livreDesde = 0; } }
        else S.livreDesde = 0;
        return;
      }
      if (presenca) { if (S.estado !== 'ocupado') S.estado = 'ocupado'; S.livreDesde = 0; return; }
      if (S.estado === 'ocupado') { S.estado = 'assentando'; S.livreDesde = t; return; }
      const validas = m => m.lista.filter(b => b.area >= L.min && b.fill >= 0.3 && b.bw >= 3 && b.bh >= 3);
      if (S.estado === 'assentando') {
        if (t - S.livreDesde < 1200) return;
        if (validas(manchas(atual, S.ref, 18)).length) { S.estado = 'confirmando'; S.confirmandoDesde = t; } else S.estado = 'livre';
        return;
      }
      if (S.estado === 'confirmando') {
        if (t - S.confirmandoDesde < 2000) return;
        const m = manchas(atual, S.ref, 18), ok = validas(m);
        if (ok.length) {
          {
            // alguém que só parou na frente e saiu vira +1 seguido de −1 (retirada): o saldo fica certo
            let mais = 0, menos = 0;
            for (const b of ok) {
              const n = L.tipico ? Math.min(4, Math.max(1, Math.round(b.area / L.tipico))) : 1;   // mancha do tamanho de 2 caixas = 2
              if (direcao(b, atual, S.ref) > 0) { mais += n; aprenderCaixa(b, atual); } else menos += n;
            }
            if (m.frac > 0.6 || mais + menos > 6) { S.refAnterior = S.ref; S.ref = atual; registrar('troca_pallet', 0, m.frac); }
            else {
              S.refAnterior = S.ref; S.ref = atual; S.ultimaContagemTs = t;
              if (mais) registrar('ia', mais, m.frac);
              if (menos) registrar('ia_retirada', menos, m.frac);
            }
          }
        }
        S.estado = 'livre';
        return;
      }
      if (S.ref) { for (let i = 0; i < N; i++) S.ref.g[i] += (atual.g[i] - S.ref.g[i]) * 0.02; for (let i = 0; i < N * 3; i++) S.ref.rgb[i] += (atual.rgb[i] - S.ref.rgb[i]) * 0.02; }
    }

    /* ───────── IA de detecção (modelo treinado com as amostras desta câmera) ─────────
       Roda no próprio aparelho com onnxruntime-web. Conta as caixas/peças detectadas
       dentro da área; quando a contagem fica estável por ~2,5 s sem ninguém na frente
       e difere da última estável, registra +n (colocadas) ou −n (retiradas). */
    async function carregarModelo(info) {
      if (!info) { S.modelo = null; S.modeloId = null; S.dets = []; S.contEstavel = null; hud('ia', 'IA: sem modelo treinado — usando diferença de imagem', 'alerta'); o.onModelo && o.onModelo(null); return; }
      if (typeof ort === 'undefined') { S.detErro = 'onnxruntime não carregado'; hud('ia', 'IA: biblioteca não carregada', 'erro'); return; }
      S.modeloCarregando = true;
      try {
        ort.env.wasm.wasmPaths = '/js/ort/';
        ort.env.wasm.numThreads = (self.crossOriginIsolated && navigator.hardwareConcurrency > 2) ? 2 : 1;
        const r = await fetch(`/api/contador/linhas/${S.linhaId}/modelo?produto_id=${S.produtoId || ''}`);
        if (!r.ok) throw new Error('modelo não encontrado');
        const buf = await r.arrayBuffer();
        const sess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        S.modelo = { id: info.id, imgsz: info.imgsz || 416, tipo: info.tipo || 'det', classes: info.classes || ['com_pecas', 'vazio'], sess, entrada: sess.inputNames[0], saida: sess.outputNames[0], metricas: info.metricas };
        S.pallet = null; S.histPallet = [];
        S.modeloId = info.id; S.contEstavel = null; S.histCont = []; S.detErro = null;
        hud('ia', S.modelo.tipo === 'cls' ? 'IA: pallet vazio × com peças' : 'IA: ' + (S.modelo.classes || ['objeto']).map(c => ROTULO_CLASSE[c] || c).join(' / '), 'on');
        o.onModelo && o.onModelo(S.modelo); o.onConfig && o.onConfig(S.cfg, S.zona);
      } catch (e) { S.detErro = e.message; S.modelo = null; hud('ia', 'IA: falha ao carregar modelo (' + e.message + ')', 'erro'); }
      S.modeloCarregando = false;
    }
    const det = document.createElement('canvas'); const dctx = det.getContext('2d', { willReadFrequently: true });
    async function detectar(t) {
      const m = S.modelo; if (!m || !video.videoWidth) return;
      if (m.tipo === 'cls') return classificar(t);
      S.detOcupado = true;
      try {
        const sz = m.imgsz, vw = video.videoWidth, vh = video.videoHeight, s = sz / Math.max(vw, vh);
        const dw = Math.round(vw * s), dh = Math.round(vh * s), ox = Math.floor((sz - dw) / 2), oy = Math.floor((sz - dh) / 2);
        det.width = sz; det.height = sz; dctx.fillStyle = 'rgb(114,114,114)'; dctx.fillRect(0, 0, sz, sz); dctx.drawImage(video, ox, oy, dw, dh);
        const px = dctx.getImageData(0, 0, sz, sz).data, n = sz * sz, f = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) { f[i] = px[i * 4] / 255; f[n + i] = px[i * 4 + 1] / 255; f[2 * n + i] = px[i * 4 + 2] / 255; }
        const out = await m.sess.run({ [m.entrada]: new ort.Tensor('float32', f, [1, 3, sz, sz]) });
        const o2 = out[m.saida], d = o2.data, A = o2.dims[2], C = o2.dims[1];   // [1, 4+nc, A]
        const nomes = m.classes || ['objeto'];
        const cand = [];
        for (let a = 0; a < A; a++) {
          let sc = 0, ci = 0; for (let c = 4; c < C; c++) { const v = d[c * A + a]; if (v > sc) { sc = v; ci = c - 4; } }
          if (sc < 0.35) continue;
          const cx = d[a], cy = d[A + a], w = d[2 * A + a], h = d[3 * A + a];
          cand.push({ x: (cx - w / 2 - ox) / s / vw, y: (cy - h / 2 - oy) / s / vh, w: w / s / vw, h: h / s / vh, sc, classe: nomes[ci] || 'objeto' });
        }
        cand.sort((p, q) => q.sc - p.sc);
        const fin = [];
        for (const c of cand) { if (fin.every(k => k.classe !== c.classe || iou(k, c) < 0.45)) fin.push(c); if (fin.length >= 60) break; }
        S.dets = fin;
        // pallet: o mais confiável; define a área automática (coluna acima dele) quando não há área marcada
        const pallet = fin.filter(b => b.classe === 'pallet').sort((p, q) => q.sc - p.sc)[0] || null;
        S.temClassePallet = nomes.includes('pallet');
        S.palletBox = pallet;
        if (pallet && !S.zona) {
          // coluna acima do pallet até ~1,6× a largura dele (altura de pilha); de cima, cobre o próprio pallet
          const alturaPilha = pallet.w * (vw / vh) * 1.6, topo = Math.max(0, pallet.y - alturaPilha);
          const nova = { x: Math.max(0, pallet.x - pallet.w * 0.08), y: topo, w: Math.min(1, pallet.w * 1.16), h: Math.min(1, pallet.y + pallet.h) - topo };
          const a0 = S.areaAuto, difere = (a, b) => Math.abs(a.x - b.x) > 0.03 || Math.abs(a.w - b.w) > 0.03 || Math.abs(a.y - b.y) > 0.03 || Math.abs(a.h - b.h) > 0.03;
          if (!a0) { S.areaAuto = nova; S.ultimoQuadro = null; }
          else if (difere(a0, nova)) {
            // só move a área se o pallet aparecer no novo lugar em 4 leituras seguidas (pessoa tapando o pallet não mexe na área)
            if (S.areaCand && !difere(S.areaCand, nova)) S.areaCandN++; else { S.areaCand = nova; S.areaCandN = 1; }
            if (S.areaCandN >= 4) { S.areaAuto = nova; S.ultimoQuadro = null; S.areaCand = null; }
          } else S.areaCand = null;
        }
        const z = areaAtiva();
        const itens = fin.filter(b => b.classe !== 'pallet');
        const dentro = z ? itens.filter(b => { const cx = b.x + b.w / 2, cy = b.y + b.h / 2; return cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h; }) : itens;
        const cont = {}; for (const b of dentro) cont[b.classe] = (cont[b.classe] || 0) + 1;
        avaliarContagem(cont, S.temClassePallet ? !!pallet : true, t);
      } catch (e) { S.detErro = e.message; }
      S.detOcupado = false;
    }
    /* modo pallet: recorta a área, classifica vazio × com peças; vazio→com peças = +1, com peças→vazio = pallet liberado */
    async function classificar(t) {
      const m = S.modelo, z = S.zona; if (!z) { S.estado = 'calibrando'; return; }
      S.detOcupado = true;
      try {
        const sz = m.imgsz || 224, vw = video.videoWidth, vh = video.videoHeight;
        det.width = sz; det.height = sz; dctx.drawImage(video, z.x * vw, z.y * vh, z.w * vw, z.h * vh, 0, 0, sz, sz);
        const px = dctx.getImageData(0, 0, sz, sz).data, n = sz * sz, f = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) { f[i] = px[i * 4] / 255; f[n + i] = px[i * 4 + 1] / 255; f[2 * n + i] = px[i * 4 + 2] / 255; }
        const out = await m.sess.run({ [m.entrada]: new ort.Tensor('float32', f, [1, 3, sz, sz]) });
        let d = Array.from(out[m.saida].data);
        if (d.some(v => v < 0 || v > 1)) { const mx = Math.max(...d); const e = d.map(v => Math.exp(v - mx)); const s = e.reduce((a, b) => a + b, 0); d = e.map(v => v / s); }
        const iCom = Math.max(0, m.classes.indexOf('com_pecas'));
        S.probCom = d[iCom];
        avaliarPallet(S.probCom, t);
      } catch (e) { S.detErro = e.message; }
      S.detOcupado = false;
    }
    function avaliarPallet(p, t) {
      const presenca = sobrepoe(S.pessoaBox) || movimentoRecente(t);
      if (presenca) { S.estado = 'ocupado'; S.histPallet = []; return; }
      const leitura = p > 0.6 ? 'com' : p < 0.4 ? 'vazio' : null;   // zona morta no meio: não decide
      if (!leitura) { S.estado = 'confirmando'; return; }
      S.histPallet.push({ v: leitura, t }); S.histPallet = S.histPallet.filter(h => t - h.t <= 2500);
      const estavel = S.histPallet.length >= 3 && S.histPallet.every(h => h.v === leitura) && t - S.histPallet[0].t >= 2200;
      if (S.pallet === null) { S.estado = 'calibrando'; if (estavel) { S.pallet = leitura; S.estado = 'livre'; } return; }
      if (leitura === S.pallet) { S.estado = 'livre'; return; }
      if (!estavel) { S.estado = 'confirmando'; return; }
      if (leitura === 'com') registrar('ia', 1, Math.round(p * 100));       // pallet recebeu peça(s)
      else registrar('troca_pallet', 0, Math.round((1 - p) * 100));         // pallet esvaziou / foi trocado
      S.pallet = leitura; S.estado = 'livre';
    }
    function iou(a, b) {
      const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const i = ix * iy; return i / (a.w * a.h + b.w * b.h - i + 1e-9);
    }
    /* presença (pessoa/movimento) segura a avaliação; contagem estável por 2,5 s muda o total */
    /* cont = { caixa: 3, peca: 1 } dentro da área; palletOk = a IA está vendo o pallet.
       Só decide com a cena parada e ninguém na frente por ~2,5 s. Cada classe é comparada com a última
       contagem estável: +n colocadas, −n retiradas. Pallet sumiu = pallet trocado (não são retiradas). */
    const chave = c => Object.keys(c).filter(k => c[k]).sort().map(k => k + ':' + c[k]).join(',') || 'vazio';
    function avaliarContagem(cont, palletOk, t) {
      S.contAtual = cont; S.palletOk = palletOk;
      if (!areaAtiva()) { S.estado = S.temClassePallet ? 'sem_pallet' : 'livre'; return; }
      const pessoa = sobrepoe(S.pessoaBox), mov = movimentoRecente(t);
      S.movSeq = mov ? (S.movSeq || 0) + 1 : 0;
      // "alguém mexeu": pessoa vista pela IA, movimento grande (corpo/braço cobrindo ≥ 12 % da área) ou movimento
      // contínuo (≥ 2 leituras seguidas). Uma caixa que "aparece" sozinha ou um piscar de luz pequeno não valem.
      if (pessoa || S.movFrac >= 0.12 || S.movSeq >= 2) S.ultimaPresenca = t;
      if (pessoa || mov) { S.estado = 'ocupado'; S.histCont = []; return; }
      const k = (palletOk ? 'P|' : 'X|') + chave(cont);
      S.histCont.push({ k, t }); S.histCont = S.histCont.filter(h => t - h.t <= 2500);
      const estavel = S.histCont.length >= 3 && S.histCont.every(h => h.k === k) && t - S.histCont[0].t >= 2200;
      if (!estavel) { if (S.contEstavel !== null && k !== S.chaveEstavel) S.estado = 'confirmando'; else if (S.contEstavel === null) S.estado = 'calibrando'; return; }
      if (S.contEstavel === null) { S.contEstavel = { ...cont }; S.palletEstavel = palletOk; S.chaveEstavel = k; S.estado = palletOk ? 'livre' : 'sem_pallet'; return; }
      if (k === S.chaveEstavel) { S.estado = palletOk ? 'livre' : 'sem_pallet'; return; }
      // pallet saiu (com ou sem carga) ou chegou um pallet novo: não é colocar/retirar peça
      if (S.temClassePallet && palletOk !== S.palletEstavel) {
        if (!palletOk) registrar('troca_pallet', 0, null, 'pallet saiu');
        else registrar('troca_pallet', 0, null, 'pallet novo' + (Object.keys(cont).length ? ' (' + chave(cont) + ')' : ' vazio'));
      } else if (t - Math.max(S.ultimaMao || -1e9, S.ultimaPresenca || -1e9) > 25000) {
        // mudou sem ninguém ter mexido no pallet (sombra, reflexo, a IA oscilou): só ajusta a referência, não conta
        S.ajustes = (S.ajustes || 0) + 1; console.info('Contador: mudança sem pessoa/mão no pallet ignorada', chave(S.contEstavel), '→', chave(cont));
      } else {
        const tipos = new Set([...Object.keys(cont), ...Object.keys(S.contEstavel)]);
        for (const tipo of tipos) {
          const delta = (cont[tipo] || 0) - (S.contEstavel[tipo] || 0);
          if (delta > 0) registrar('ia', Math.min(4, delta), null, tipo);
          else if (delta < 0) registrar('ia_retirada', Math.min(4, -delta), null, tipo);
        }
      }
      S.contEstavel = { ...cont }; S.palletEstavel = palletOk; S.chaveEstavel = k; S.estado = palletOk ? 'livre' : 'sem_pallet';
    }
    function movimentoRecente(t) {
      if (!areaAtiva()) return false;
      const atual = amostraZona();
      const mov = S.ultimoQuadro ? comparar(atual.g, S.ultimoQuadro.g, 16).frac : 0;
      S.ultimoQuadro = atual;
      S.movFrac = mov;
      return mov > 0.015;
    }

    /* ───────── registro ───────── */
    function miniatura() {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240; const cx = c.getContext('2d'); cx.drawImage(video, 0, 0, 320, 240);
      if (S.zona) { cx.strokeStyle = '#35C95C'; cx.lineWidth = 2; cx.strokeRect(S.zona.x * 320, S.zona.y * 240, S.zona.w * 320, S.zona.h * 240); }
      return c.toDataURL('image/jpeg', 0.6);
    }
    function registrar(origem, valor, frac, detalhe) {
      if (origem === 'manual_mais') valor = 1; else if (origem === 'manual_menos') valor = -1; else if (origem === 'troca_pallet') valor = 0; else if (origem === 'ia_retirada') valor = -Math.abs(valor || 1);
      const ev = { linha_id: S.linhaId, sessao_id: S.sessaoId || (S.sessao ? S.sessao.id : null), origem, valor: Math.abs(valor) || undefined, ts: new Date().toISOString(), mudanca_pct: frac != null ? Math.round(frac * 1000) / 10 : null, foto: miniatura(), dispositivo: disp, detalhe: detalhe || null };
      if (valor) { S.contagem += valor; o.onContagem && o.onContagem(S.contagem); if (o.flash) { o.flash.classList.add('on'); setTimeout(() => o.flash.classList.remove('on'), 250); } if (navigator.vibrate) navigator.vibrate(60); }
      S.eventos.push({ ts: ev.ts, valor, origem, detalhe: ev.detalhe });
      o.onEvento && o.onEvento({ ...ev, valor });
      S.fila.push(ev); salvarFila(); enviarFila();
    }
    function salvarFila() { try { localStorage.setItem('contador.fila', JSON.stringify(S.fila)); } catch (_) {} }
    let enviando = false;
    async function enviarFila() {
      if (enviando || !S.fila.length) return; enviando = true;
      while (S.fila.length) {
        try { await API.post('/api/contador/eventos', S.fila[0]); S.fila.shift(); salvarFila(); o.onOffline && o.onOffline(false); }
        catch (e) { if (e.status && e.status < 500 && e.status !== 401) { S.fila.shift(); salvarFila(); } else { o.onOffline && o.onOffline(true); break; } }
      }
      enviando = false;
    }
    async function carregarEventosHoje() {
      const lista = await API.get(`/api/contador/eventos?data=${hojeISO()}&linha_id=${S.linhaId}${S.sessaoId ? '&sessao_id=' + S.sessaoId : ''}`).catch(() => []);
      S.eventos = lista.map(e => ({ ts: e.ts, valor: e.valor, origem: e.origem }));
      const vFila = f => f.origem === 'manual_menos' || f.origem === 'estorno' ? -1 : f.origem === 'ia_retirada' ? -(f.valor || 1) : f.origem === 'troca_pallet' ? 0 : (f.valor || 1);
      S.contagem = S.eventos.reduce((s, e) => s + e.valor, 0) + S.fila.filter(f => f.linha_id === S.linhaId).reduce((s, f) => s + vFila(f), 0);
      o.onContagem && o.onContagem(S.contagem);
    }

    /* ───────── desenho ───────── */
    function desenhar() {
      if (!sobre) return;
      const W = sobre.width = sobre.clientWidth, H = sobre.height = sobre.clientHeight;
      sctx.clearRect(0, 0, W, H);
      const vr = video.videoWidth / video.videoHeight, cr = W / H;
      let sx = 0, sy = 0, sw = 1, sh = 1;
      if (vr > cr) { sw = cr / vr; sx = (1 - sw) / 2; } else { sh = vr / cr; sy = (1 - sh) / 2; }
      const mapX = x => (x - sx) / sw * W, mapY = y => (y - sy) / sh * H;
      const z = S.desenhando || S.zona;
      if (z) {
        sctx.strokeStyle = S.estado === 'ocupado' ? '#F0B429' : (S.estado === 'assentando' || S.estado === 'confirmando') ? '#56B6E0' : '#35C95C';
        sctx.lineWidth = 3; sctx.setLineDash(S.estado === 'calibrando' ? [8, 6] : []);
        sctx.strokeRect(mapX(z.x), mapY(z.y), z.w / sw * W, z.h / sh * H); sctx.setLineDash([]);
        sctx.fillStyle = 'rgba(53,201,92,.08)'; sctx.fillRect(mapX(z.x), mapY(z.y), z.w / sw * W, z.h / sh * H);
        if (S.cfg.caixa && S.cfg.caixa_pos) { sctx.strokeStyle = 'rgba(240,180,41,.8)'; sctx.lineWidth = 1.5; sctx.setLineDash([4, 3]); sctx.strokeRect(mapX(S.cfg.caixa_pos.x), mapY(S.cfg.caixa_pos.y), S.cfg.caixa.w / sw * W, S.cfg.caixa.h / sh * H); sctx.setLineDash([]); }
      }
      if (S.modelo && S.modelo.tipo !== 'cls') {
        const za = areaAtiva();
        if (za && !S.zona) { sctx.strokeStyle = 'rgba(167,139,250,.6)'; sctx.lineWidth = 1.5; sctx.setLineDash([6, 4]); sctx.strokeRect(mapX(za.x), mapY(za.y), za.w / sw * W, za.h / sh * H); sctx.setLineDash([]); }
        sctx.lineWidth = 2; sctx.font = 'bold 11px sans-serif';
        for (const b of S.dets) {
          const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dentro = b.classe === 'pallet' || !za || (cx >= za.x && cx <= za.x + za.w && cy >= za.y && cy <= za.y + za.h);
          const cor = COR_CLASSE[b.classe] || COR_CLASSE.objeto;
          sctx.strokeStyle = dentro ? cor : 'rgba(255,255,255,.3)'; sctx.strokeRect(mapX(b.x), mapY(b.y), b.w / sw * W, b.h / sh * H);
          if (dentro) { sctx.fillStyle = cor; sctx.fillText(ROTULO_CLASSE[b.classe] || b.classe, mapX(b.x) + 3, mapY(b.y) + 12); }
        }
      }
      if (S.maos && S.maos.length) { const za = areaAtiva(); for (const m of S.maos) { const dentro = za && m.x >= za.x && m.x <= za.x + za.w && m.y >= za.y && m.y <= za.y + za.h; sctx.fillStyle = dentro ? '#35C95C' : 'rgba(255,255,255,.6)'; sctx.beginPath(); sctx.arc(mapX(m.x), mapY(m.y), dentro ? 7 : 4, 0, Math.PI * 2); sctx.fill(); } }
      if (S.pessoaBox) { sctx.strokeStyle = 'rgba(86,182,224,.9)'; sctx.lineWidth = 2; sctx.strokeRect(mapX(S.pessoaBox.x), mapY(S.pessoaBox.y), S.pessoaBox.w / sw * W, S.pessoaBox.h / sh * H); }
      const nomes = { calibrando: 'Calibrando — saia da frente do pallet', livre: 'Livre', ocupado: 'Pessoa no pallet', assentando: 'Conferindo…', confirmando: 'Confirmando…' };
      const ia = !S.modelo ? '' : S.modelo.tipo === 'cls' ? ' · pallet ' + (S.probCom == null ? '?' : S.probCom > 0.5 ? 'COM PEÇAS' : 'VAZIO') + ' (' + Math.round((S.probCom || 0) * 100) + '%)' : ' · ' + resumoPallet();
      const temArea = !!areaAtiva();
      const maoAgora = S.ultimaMao && performance.now() - S.ultimaMao < 1500;
      const txt = (S.pausado ? 'PAUSADO · ' : '') + (maoAgora ? '✋ mão no pallet · ' : '') + (S.estado === 'sem_pallet' ? 'Sem pallet' : temArea ? nomes[S.estado] : (S.modelo && S.modelo.tipo !== 'cls' ? 'Procurando o pallet…' : 'Sem área marcada')) + ia + ' · ' + S.fps + ' fps';
      hud('estado', txt, S.estado === 'ocupado' ? 'alerta' : S.estado === 'livre' ? 'on' : '');
      o.onEstado && o.onEstado(areaAtiva() ? S.estado : 'sem_area', txt);
      desenhar.map = { sx, sy, sw, sh };
    }
    /* marcar área/caixa arrastando no próprio aparelho (também salva no servidor) */
    let modoDesenho = 'zona', ini = null;
    function toqueParaNorm(e) { const r = sobre.getBoundingClientRect(); const m = desenhar.map || { sx: 0, sy: 0, sw: 1, sh: 1 }; return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width * m.sw + m.sx)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height * m.sh + m.sy)) }; }
    if (sobre) {
      sobre.addEventListener('pointerdown', e => { if (!o.desenhoLocal || !S.ativo) return; if (e.cancelable) e.preventDefault(); try { sobre.setPointerCapture(e.pointerId); } catch (_) {} ini = toqueParaNorm(e); S.desenhando = { x: ini.x, y: ini.y, w: 0, h: 0 }; });
      sobre.addEventListener('pointermove', e => { if (!ini) return; if (e.cancelable) e.preventDefault(); const p = toqueParaNorm(e); S.desenhando = { x: Math.min(ini.x, p.x), y: Math.min(ini.y, p.y), w: Math.abs(p.x - ini.x), h: Math.abs(p.y - ini.y) }; });
      const soltar = async () => {
        if (!ini) return; const d = S.desenhando; ini = null; S.desenhando = null;
        if (!d || d.w < 0.03 || d.h < 0.03) return;
        if (modoDesenho === 'zona') { S.zona = d; recalibrar(); S.zonaEditadaLocal = true; await salvarConfig({ zona: d }, false); avisoOk('Área marcada. Calibrando…'); }
        else { await salvarConfig({ caixa: { w: d.w, h: d.h }, caixa_pos: { x: d.x, y: d.y } }, true); avisoOk('Tamanho da caixa salvo para este produto.'); }
      };
      sobre.addEventListener('pointerup', soltar); sobre.addEventListener('pointercancel', soltar);
    }
    async function salvarConfig(parcial, porProduto) {
      try {
        const body = { ...parcial }; if (porProduto && S.produtoId) body.produto_id = S.produtoId;
        const r = await API.put('/api/contador/linhas/' + S.linhaId + '/config', body);
        S.cfgTs = r.updated_at; S.cfg = { ...S.cfg, ...r.config }; o.onConfig && o.onConfig(S.cfg, S.zona);
      } catch (e) { avisoErro(e.message); }
    }

    /* ───────── ao vivo ───────── */
    let enviandoQuadro = false;
    async function enviarQuadro() {
      if (enviandoQuadro || !video.videoWidth) return; enviandoQuadro = true;
      try {
        ectx.drawImage(video, 0, 0, 640, 480);
        const quadroLimpo = envio.toDataURL('image/jpeg', 0.6);   // sem desenhos: é o que vira amostra de treino
        if (S.zona) { ectx.strokeStyle = S.estado === 'ocupado' ? 'rgba(240,180,41,.9)' : 'rgba(53,201,92,.9)'; ectx.lineWidth = 2; ectx.strokeRect(S.zona.x * 640, S.zona.y * 480, S.zona.w * 640, S.zona.h * 480); }
        if (S.modelo && S.modelo.tipo !== 'cls') { ectx.lineWidth = 2; ectx.font = 'bold 13px sans-serif'; for (const b of S.dets) { const cor = COR_CLASSE[b.classe] || COR_CLASSE.objeto; ectx.strokeStyle = cor; ectx.strokeRect(b.x * 640, b.y * 480, b.w * 640, b.h * 480); ectx.fillStyle = cor; ectx.fillText(ROTULO_CLASSE[b.classe] || b.classe, b.x * 640 + 3, b.y * 480 + 14); } }
        ectx.fillStyle = 'rgba(10,22,32,.7)'; ectx.fillRect(0, 0, 640, 26);
        ectx.fillStyle = '#fff'; ectx.font = 'bold 14px sans-serif';
        ectx.fillText(`${(S.linha && (S.linha.nome || S.linha.celula)) || ''}  ·  ${S.contagem} un  ·  ${new Date().toLocaleTimeString('pt-BR')}`, 10, 18);
        const body = { linha_id: S.linhaId, produto_id: S.produtoId, sessao_id: S.sessaoId || (S.sessao ? S.sessao.id : null), contagem: S.contagem, estado: areaAtiva() ? S.estado : 'sem_area', resumo: S.modelo && S.modelo.tipo !== 'cls' ? resumoPallet() : null, dispositivo: disp, jpeg: envio.toDataURL('image/jpeg', 0.55), jpeg_limpo: quadroLimpo };
        if (S.capacidades && !S.capEnviadas) body.capacidades = S.capacidades;
        const r = await fetch('/api/contador/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 401) location.href = '/login';
        if (r.ok) { S.capEnviadas = true; const j = await r.json().catch(() => ({})); if (j.comandos) sincronizar(false).catch(() => {}); }
        hud('live', null, r.ok ? 'on' : 'erro');
      } catch (_) { hud('live', null, 'erro'); }
      enviandoQuadro = false;
    }

    /* ───────── ciclo de vida ───────── */
    async function conectar(p) {
      S.linhaId = Number(p.linhaId); S.produtoId = p.produtoId ? Number(p.produtoId) : null; S.sessaoId = p.sessaoId ? Number(p.sessaoId) : null;
      try { await sincronizar(true); } catch (e) { throw new Error('Linha não encontrada: ' + e.message); }
      await abrirCamera();
      S.ativo = true;
      if (typeof manterTelaLigada === 'function') manterTelaLigada();
      await carregarEventosHoje();
      iniciarPose();
      S.raf = requestAnimationFrame(loop);
      S.timers.push(setInterval(enviarFila, 4000), setInterval(() => sincronizar(false).catch(() => {}), POLL_MS));
      document.addEventListener('visibilitychange', onVis);
      return S;
    }
    function onVis() { S.pausado = document.hidden; }
    function parar() {
      S.ativo = false; cancelAnimationFrame(S.raf); S.timers.forEach(clearInterval); S.timers = [];
      if (S.stream) S.stream.getTracks().forEach(t => t.stop()); S.stream = null; video.srcObject = null;
      document.removeEventListener('visibilitychange', onVis);
      if (S.pose) { try { S.pose.close(); } catch (_) {} S.pose = null; S.posePronto = false; }
    }
    /* troca de produto/sessão sem reabrir a câmera (o tablet trocou a linha) */
    async function trocarSessao(produtoId, sessaoId) { S.produtoId = produtoId ? Number(produtoId) : null; S.sessaoId = sessaoId ? Number(sessaoId) : null; await sincronizar(true); await carregarEventosHoje(); }

    return {
      conectar, parar, trocarSessao, registrar: (origem) => registrar(origem, 0, null), recalibrar: () => { recalibrar(); },
      trocaPallet: () => { recalibrar(); registrar('troca_pallet', 0, null); },
      modoDesenho: m => { modoDesenho = m; }, salvarConfig, estado: S,
      get modelo() { return S.modelo; }, get resumo() { return resumoPallet(); }, get contAtual() { return S.contAtual; }, get palletOk() { return S.palletOk; }, get dets() { return S.dets; }, get contagem() { return S.contagem; }, get sessao() { return S.sessao; }, get eventos() { return S.eventos; }, get cfg() { return S.cfg; }, get zona() { return S.zona; }, get ativo() { return S.ativo; }
    };
  }
  return { criar, CFG_PADRAO };
})();
