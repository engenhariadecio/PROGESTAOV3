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
  // identidade desta câmera (desta aba): o servidor deixa só UMA câmera contar cada célula
  const CAM_ID = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 36);

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
      recalibrar();
      await lerCapacidades(); aplicarAjustesCamera();
    }
    async function lerCapacidades() {
      const track = S.stream && S.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      const st = track && track.getSettings ? track.getSettings() : {};
      let cameras = [];
      try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || 'Câmera ' + (i + 1) })); } catch (_) {}
      const fotosAnt = S.capacidades ? { fotos_cameras: S.capacidades.fotos_cameras, fotos_ts: S.capacidades.fotos_ts } : {};
      S.capacidades = { ...fotosAnt, cameras, camera_atual: st.deviceId || '', zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, atual: st.zoom } : null,
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
    /* Fotografa cada câmera do celular (uma foto pequena de cada) e manda para o painel — a lente 0,5× (ultra-angular)
       costuma aparecer como outra câmera traseira; no painel é só escolher a que mostra mais da cena. */
    async function testarCameras() {
      if (S.testandoCameras) return; S.testandoCameras = true;
      const lista = (S.capacidades && S.capacidades.cameras || []).filter(c => !/front|frontal|facing front|user/i.test(c.label));
      const fotos = [];
      try {
        if (S.stream) S.stream.getTracks().forEach(t => t.stop());
        for (const c of lista) {
          let st = null;
          try {
            st = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: c.id }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
            const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = st; await v.play().catch(() => {});
            const t0 = performance.now(); while ((!v.videoWidth || performance.now() - t0 < 1200) && performance.now() - t0 < 5000) await new Promise(r => setTimeout(r, 100));
            const tr = st.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
            const L = 240, w = v.videoWidth >= v.videoHeight ? L : Math.round(L * v.videoWidth / v.videoHeight), h = v.videoWidth >= v.videoHeight ? Math.round(L * v.videoHeight / v.videoWidth) : L;
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(v, 0, 0, w, h);
            fotos.push({ id: c.id, label: c.label, foto: cv.toDataURL('image/jpeg', 0.55), largura: v.videoWidth, altura: v.videoHeight, zoom: cap.zoom ? [cap.zoom.min, cap.zoom.max] : null });
          } catch (e) { fotos.push({ id: c.id, label: c.label, erro: e.name || e.message }); }
          if (st) st.getTracks().forEach(t => t.stop());
        }
      } finally {
        S.testandoCameras = false;
        await abrirCamera().catch(e => avisoErro('Câmera: ' + e.message));
        if (S.capacidades) { S.capacidades.fotos_cameras = fotos; S.capacidades.fotos_ts = Date.now(); S.capEnviadas = false; }
      }
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
      const mid = e.modelo ? (e.modelo.chave || e.modelo.id) : null;   // chave muda quando o modelo é treinado de novo
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
        else if (S.cfg.zoom !== ant.zoom || S.cfg.lanterna !== ant.lanterna) { if (S.cfg.zoom !== ant.zoom) recalibrar(); aplicarAjustesCamera(); }
      }
      o.onConfig && o.onConfig(S.cfg, S.zona);
    }
    function executarComando(c) {
      if (c.tipo === 'recalibrar') { recalibrar(); avisoOk('Recalibrando (comando do painel)'); }
      else if (c.tipo === 'troca_pallet') { recalibrar(); registrar('troca_pallet', 0, null); }
      else if (c.tipo === 'mais') registrar('manual_mais', 1, null);
      else if (c.tipo === 'menos') { if (S.contagem > 0) registrar('manual_menos', -1, null); }
      else if (c.tipo === 'reiniciar_camera') abrirCamera().catch(e => avisoErro('Câmera: ' + e.message));
      else if (c.tipo === 'testar_cameras') testarCameras().catch(e => avisoErro('Câmeras: ' + e.message));
      else if (c.tipo === 'encerrar') { parar(); o.onEncerrar && o.onEncerrar(); }
    }
    function recalibrar() { S.ref = null; S.refAnterior = null; S.fundo = null; S.estado = 'calibrando'; S.livreDesde = 0; S.contEstavel = null; S.chaveEstavel = null; S.histCont = []; S.pallet = null; S.histPallet = []; S.areaAuto = null; S.palletRef = null; S.chaveAnterior = null; S.tUltimoEvento = 0; S.regMov = null; S.comMov = false; S.antesSaiu = null; S.pilhaRef = null; }

    /* ───────── análise da área ───────── */
    const COR_CLASSE = { caixa: '#F0B429', peca: '#56B6E0', pallet: '#A78BFA', objeto: '#35C95C' };
    const ROTULO_CLASSE = { caixa: 'CAIXA', peca: 'PEÇA', pallet: 'PALLET', objeto: 'OBJETO' };
    function resumoPallet() {
      const conf = S.contEstavel && S.palletEstavel !== false ? S.contEstavel : null;
      const c = conf || S.contAtual || {}, partes = [];
      const agora = soma(S.contAtual || {}), lendo = conf && agora !== soma(conf) && (S.palletOk || !S.temClassePallet) ? ` (lendo ${agora}…)` : '';
      if (c.caixa) partes.push(c.caixa + (c.caixa > 1 ? ' caixas' : ' caixa'));
      if (c.peca) partes.push(c.peca + (c.peca > 1 ? ' peças' : ' peça'));
      if (c.objeto) partes.push(c.objeto + ' objeto(s)');
      if (S.dets && !S.dets.length && S.melhorSc != null) return `IA não reconhece nada (máx. ${Math.round(S.melhorSc * 100)}% — precisa de 35%; ensine com mais fotos)`;
      if (S.temClassePallet && !S.palletOk) return 'sem pallet' + (partes.length ? ' · ' + partes.join(', ') : '');
      return (partes.length ? (S.temClassePallet ? (S.palletVirtual ? 'pilha com ' : 'pallet com ') : '') + partes.join(', ') : (S.temClassePallet ? 'PALLET VAZIO' : 'nada')) + lendo;
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
      if (!video.videoWidth || S.testandoCameras) return;   // fotografando as câmeras: não lê nada
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
        const r = await fetch(`/api/contador/linhas/${S.linhaId}/modelo?produto_id=${S.produtoId || ''}&v=${encodeURIComponent(info.chave || info.id)}`);
        if (!r.ok) throw new Error('modelo não encontrado');
        const buf = await r.arrayBuffer();
        const sess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        S.modelo = { id: info.id, imgsz: info.imgsz || 416, tipo: info.tipo || 'det', classes: info.classes || ['com_pecas', 'vazio'], sess, entrada: sess.inputNames[0], saida: sess.outputNames[0], saidas: sess.outputNames, metricas: info.metricas };
        S.pallet = null; S.histPallet = [];
        S.modeloId = info.chave || info.id; S.modelo.nome = info.nome; S.contEstavel = null; S.histCont = []; S.detErro = null;
        hud('ia', S.modelo.tipo === 'cls' ? 'IA: pallet vazio × com peças' : 'IA' + (info.nome ? ' ' + info.nome : '') + (S.modelo.tipo === 'seg' ? ' (contorno)' : '') + ': ' + (S.modelo.classes || ['objeto']).map(c => ROTULO_CLASSE[c] || c).join(' / '), 'on');
        o.onModelo && o.onModelo(S.modelo); o.onConfig && o.onConfig(S.cfg, S.zona);
      } catch (e) { S.detErro = e.message; S.modelo = null; hud('ia', 'IA: falha ao carregar modelo (' + e.message + ')', 'erro'); }
      S.modeloCarregando = false;
    }
    /* contorno de uma detecção: máscara = coeficientes · protótipos, só dentro da caixa; vira polígono */
    function contornoDet(b, d, A, c0, nm, pr, sz, s, ox, oy, vw, vh, cx0 = 0, cy0 = 0) {
      try {
        const mh = pr.dims[2], mw = pr.dims[3], P = pr.data, k = sz / mw, area = mh * mw;
        const u0 = Math.max(0, Math.floor(b.lb[0] / k)), v0 = Math.max(0, Math.floor(b.lb[1] / k));
        const u1 = Math.min(mw - 1, Math.ceil(b.lb[2] / k)), v1 = Math.min(mh - 1, Math.ceil(b.lb[3] / k));
        const W = u1 - u0 + 1, H = v1 - v0 + 1; if (W < 2 || H < 2) return null;
        const coef = new Float32Array(nm); for (let j = 0; j < nm; j++) coef[j] = d[(c0 + j) * A + b.a];
        const mask = new Uint8Array(W * H);
        for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
          const off = (v0 + v) * mw + u0 + u; let z = 0;
          for (let j = 0; j < nm; j++) z += coef[j] * P[j * area + off];
          mask[v * W + u] = z > 0 ? 1 : 0;           // sigmoid(z) > 0,5
        }
        const r = Contorno.maior(mask, W, H, 0.8); if (!r || r.pts.length < 3) return null;
        return r.pts.map(([u, v]) => [Math.min(1, Math.max(0, (cx0 + ((u0 + u) * k - ox) / s) / vw)), Math.min(1, Math.max(0, (cy0 + ((v0 + v) * k - oy) / s) / vh))]);
      } catch (_) { return null; }
    }
    /* desenha a marcação: contorno (se houver) ou retângulo */
    function tracarItem(ctx, b, fx, fy) {
      ctx.beginPath();
      if (b.pts && b.pts.length >= 3) { b.pts.forEach(([x, y], i) => i ? ctx.lineTo(fx(x), fy(y)) : ctx.moveTo(fx(x), fy(y))); ctx.closePath(); }
      else ctx.rect(fx(b.x), fy(b.y), fx(b.x + b.w) - fx(b.x), fy(b.y + b.h) - fy(b.y));
    }
    const det = document.createElement('canvas'); const dctx = det.getContext('2d', { willReadFrequently: true });
    async function detectar(t) {
      const m = S.modelo; if (!m || !video.videoWidth) return;
      if (m.tipo === 'cls') return classificar(t);
      S.detOcupado = true;
      try {
        const sz = m.imgsz, VW = video.videoWidth, VH = video.videoHeight;
        // Recorta em volta da área (pallet + altura da pilha) antes de mandar para a IA: caixas finas/empilhadas ficam
        // com o dobro de pixels. Sem área (ou pallet sumido há várias leituras) usa o quadro inteiro.
        const za = areaAtiva(); let cx0 = 0, cy0 = 0, vw = VW, vh = VH;
        const usarRecorte = (x0, y0, x1, y1) => { if (x1 - x0 > 0.15 && y1 - y0 > 0.15 && (x1 - x0) * (y1 - y0) < 0.92) { cx0 = Math.round(x0 * VW); cy0 = Math.round(y0 * VH); vw = Math.round((x1 - x0) * VW); vh = Math.round((y1 - y0) * VH); } };
        const pz = S.pilhaRef && (S.semPalletN || 0) < 2 ? S.pilhaRef : null;
        if (pz) {
          // ZOOM NA PILHA: recorta em volta do pallet + caixas para o pallet ocupar ~70 % da largura (o tamanho em que a IA
          // foi treinada), com folga em cima para a próxima caixa e o braço. Câmera longe/0,5× deixa de "achatar" as caixas.
          const W0 = Math.max(pz.w / 0.7, 0.3), cxm = pz.x + pz.w / 2;
          let x0 = cxm - W0 / 2, x1 = cxm + W0 / 2; if (x0 < 0) { x1 -= x0; x0 = 0; } if (x1 > 1) { x0 -= x1 - 1; x1 = 1; } x0 = Math.max(0, x0);
          let y0 = Math.max(0, pz.y - Math.max(pz.h * 0.35, 0.06) - 0.04), y1 = Math.min(1, pz.y + pz.h + 0.04);
          if (y1 - y0 < 0.3) { const c = (y0 + y1) / 2; y0 = Math.max(0, c - 0.15); y1 = Math.min(1, y0 + 0.3); }
          usarRecorte(x0, y0, x1, y1);
        } else if (za && (S.semPalletN || 0) % 3 !== 2) {   // pallet sumido no recorte: a cada 3 leituras uma é no quadro inteiro (pallet pode ter mudado de lugar)
          // área marcada à mão já é "onde as caixas ficam": margem pequena (mais zoom na pilha); a automática ganha mais folga
          const f = S.zona ? 0.08 : 0.25, mx = za.w * f, my = za.h * (S.zona ? 0.08 : 0.2);
          usarRecorte(Math.max(0, za.x - mx), Math.max(0, za.y - my), Math.min(1, za.x + za.w + mx), Math.min(1, za.y + za.h + my * 0.6));
        } else if (!za && S.temClassePallet !== false && (S.buscaN || 0) >= 2) {
          // pallet pequeno na imagem (câmera longe): sem área ainda, alterna o quadro inteiro com recortes (centro, esquerda, direita)
          const q = [[0.2, 0.15, 0.8, 0.85], [0, 0.1, 0.6, 0.9], [0.4, 0.1, 1, 0.9]][S.buscaN % 3]; usarRecorte(...q);
        }
        const s = sz / Math.max(vw, vh);
        const dw = Math.round(vw * s), dh = Math.round(vh * s), ox = Math.floor((sz - dw) / 2), oy = Math.floor((sz - dh) / 2);
        det.width = sz; det.height = sz; dctx.fillStyle = 'rgb(114,114,114)'; dctx.fillRect(0, 0, sz, sz); dctx.drawImage(video, cx0, cy0, vw, vh, ox, oy, dw, dh);
        S.recorte = (cx0 || cy0 || vw !== VW || vh !== VH) ? { x: cx0 / VW, y: cy0 / VH, w: vw / VW, h: vh / VH } : null;
        const px = dctx.getImageData(0, 0, sz, sz).data, n = sz * sz, f = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) { f[i] = px[i * 4] / 255; f[n + i] = px[i * 4 + 1] / 255; f[2 * n + i] = px[i * 4 + 2] / 255; }
        const out = await m.sess.run({ [m.entrada]: new ort.Tensor('float32', f, [1, 3, sz, sz]) });
        // det: [1, 4+nc, A]  ·  seg (contorno): [1, 4+nc+32, A] + protótipos [1, 32, sz/4, sz/4]
        const saidas = (m.saidas || [m.saida]).map(k => out[k]);
        const o2 = saidas.find(v => v.dims.length === 3) || out[m.saida], pr = saidas.find(v => v.dims.length === 4) || null;
        const d = o2.data, A = o2.dims[2], C = o2.dims[1];
        const nomes = m.classes || ['objeto'];
        const nc = pr ? Math.min(nomes.length, C - 4 - pr.dims[1]) : C - 4, nm = pr ? pr.dims[1] : 0;
        const cand = []; let melhor = 0;
        for (let a = 0; a < A; a++) {
          let sc = 0, ci = 0; for (let c = 4; c < 4 + nc; c++) { const v = d[c * A + a]; if (v > sc) { sc = v; ci = c - 4; } }
          if (sc > melhor) melhor = sc;
          if (sc < 0.35) continue;
          if (window.__testeSemPallet && nomes[ci] === 'pallet') continue;   // só para teste: simula pallet coberto/invisível
          const cx = d[a], cy = d[A + a], w = d[2 * A + a], h = d[3 * A + a];
          const b = { x: (cx0 + (cx - w / 2 - ox) / s) / VW, y: (cy0 + (cy - h / 2 - oy) / s) / VH, w: w / s / VW, h: h / s / VH, sc, classe: nomes[ci] === 'caixa' && m.tipo === 'seg' ? 'peca' : (nomes[ci] || 'objeto') };
          if (pr) { b.a = a; b.lb = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]; }
          cand.push(b);
        }
        cand.sort((p, q) => q.sc - p.sc);
        const fin = [];
        for (const c of cand) { if (fin.every(k => k.classe !== c.classe || iou(k, c) < 0.45)) fin.push(c); if (fin.length >= 60) break; }
        if (pr && window.Contorno) for (const b of fin) b.pts = contornoDet(b, d, A, 4 + nc, nm, pr, sz, s, ox, oy, VW, VH, cx0, cy0);
        if (window.Contorno) {
          // contorno "rasterizado" numa grade 160×160; se 60 % do menor estiver dentro do maior (pedaço da mesma caixa,
          // caixa detectada duas vezes), fica só o de maior confiança
          const G = 160, ras = b => { if (!b.pts || b.pts.length < 3) return null; const m = new Set();
            const i0 = Math.max(0, Math.floor(b.x * G)), i1 = Math.min(G - 1, Math.ceil((b.x + b.w) * G)), j0 = Math.max(0, Math.floor(b.y * G)), j1 = Math.min(G - 1, Math.ceil((b.y + b.h) * G));
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Contorno.dentro(b.pts, (i + 0.5) / G, (j + 0.5) / G)) m.add(j * G + i); return m.size ? m : null; };
          const fica = [];
          for (const b of fin.filter(x => x.classe !== 'pallet').sort((p, q) => q.sc - p.sc)) {
            const mb = ras(b);
            const dup = mb && fica.some(k => { let inter = 0; for (const c of mb) if (k.m.has(c)) inter++; return inter >= 0.6 * Math.min(mb.size, k.m.size); });
            if (dup) b.dup = true; else if (mb) fica.push({ b, m: mb });
          }
          for (let i = fin.length - 1; i >= 0; i--) if (fin[i].dup) fin.splice(i, 1);
        }
        S.dets = fin; S.melhorSc = melhor;   // maior confiança vista (diagnóstico: IA "tímida" = precisa de mais fotos)
        // pallet: o mais confiável; define a área automática (coluna acima dele) quando não há área marcada
        // pallet: tem que ser grande (≥ 22 % da largura — a câmera fica perto); entre vários, o que está onde o pallet já estava
        // …ou do recorte (câmera longe), ou onde o pallet já estava, ou com peças apoiadas em cima dele
        const pecasDet = fin.filter(b => b.classe !== 'pallet');
        const apoiada = (p, b) => { const sob = Math.min(p.x + p.w, b.x + b.w) - Math.max(p.x, b.x); return sob >= p.w * 0.5 && p.y + p.h >= b.y - p.h * 0.6 && p.y + p.h <= b.y + b.h + 0.02; };
        const plausivel = b => b.w >= 0.22 || (S.recorte && b.w >= 0.22 * S.recorte.w) || (S.palletRef && iou(b, S.palletRef) > 0.3) || pecasDet.some(p => apoiada(p, b));
        const pallets = fin.filter(b => b.classe === 'pallet' && plausivel(b));
        // o pallet de verdade é o que tem a pilha em cima (a IA às vezes marca um "pallet" falso no topo da pilha):
        // mais caixas apoiadas nele → onde o pallet já estava → mais confiança
        const apoiadas = new Map(pallets.map(p => [p, naPilha(pecasDet, p).size]));
        const pallet = pallets.sort((p, q) => (apoiadas.get(q) - apoiadas.get(p)) || (S.palletRef ? iou(q, S.palletRef) - iou(p, S.palletRef) : 0) || q.sc - p.sc)[0] || null;
        S.temClassePallet = nomes.includes('pallet');
        // Pallet coberto (papelão), cortado na imagem ou que a IA não reconhece: a BASE DA PILHA vira o apoio.
        // Entre as caixas da área, a que tem mais caixas empilhadas em cima é a base (caixa solta ao lado não ganha).
        let base = null;
        if (!pallet && S.temClassePallet && pecasDet.length) {
          const zz = S.zona, naArea = zz ? pecasDet.filter(b => { const cx = b.x + b.w / 2, cy = b.y + b.h / 2; return cx >= zz.x && cx <= zz.x + zz.w && cy >= zz.y && cy <= zz.y + zz.h; }) : pecasDet;
          let melhor = null, nm = 0;
          for (const c of naArea) {
            // a base é a CAMADA de baixo inteira (caixas lado a lado com o fundo na mesma altura), não uma caixa só
            const fc = c.y + c.h, tol = Math.max(0.015, c.h * 0.5), camada = naArea.filter(b => Math.abs(b.y + b.h - fc) <= tol);
            const x0 = Math.min(...camada.map(b => b.x)), x1 = Math.max(...camada.map(b => b.x + b.w));
            const v = { x: x0, y: fc - c.h * 0.25, w: x1 - x0, h: c.h * 0.5, classe: 'pallet', virtual: true, fundo: fc }, n = naPilha(naArea, v).size;
            if (n > nm || (n === nm && melhor && fc > melhor.fundo)) { nm = n; melhor = v; }
          }
          if (melhor && (zz || nm >= 2)) { base = melhor; base.n = nm; }
        }
        const apoio = pallet || base;
        S.palletBox = apoio; S.palletVirtual = !pallet && !!base;
        S.semPalletN = (S.temClassePallet && !apoio) ? (S.semPalletN || 0) + 1 : 0;   // leituras seguidas sem pallet (no recorte → 1 em 3 no quadro inteiro)
        S.buscaN = (S.temClassePallet && !apoio && !za) ? (S.buscaN || 0) + 1 : 0;   // leituras seguidas sem pallet e sem área → tenta recortes
        if (apoio && !S.zona && (pallet || base.n >= 3)) {
          let nova;
          if (pallet) {
            // coluna acima do pallet até ~1,6× a largura dele (altura de pilha); de cima, cobre o próprio pallet
            const alturaPilha = pallet.w * (VW / VH) * 1.6, topo = Math.max(0, pallet.y - alturaPilha);
            nova = { x: Math.max(0, pallet.x - pallet.w * 0.08), y: topo, w: Math.min(1, pallet.w * 1.16), h: Math.min(1, pallet.y + pallet.h) - topo };
          } else {
            // sem pallet visível: a área é a PILHA INTEIRA (todas as caixas apoiadas), com folga em cima para ela crescer
            const pil = [...naPilha(pecasDet, base)], x0 = Math.min(...pil.map(b => b.x)), x1 = Math.max(...pil.map(b => b.x + b.w)), y0 = Math.min(...pil.map(b => b.y)), y1 = Math.max(...pil.map(b => b.y + b.h));
            const topo = Math.max(0, y0 - (y1 - y0) * 0.6);
            nova = { x: Math.max(0, x0 - (x1 - x0) * 0.08), y: topo, w: Math.min(1, (x1 - x0) * 1.16), h: Math.min(1, y1 + 0.03) - topo };
          }
          const a0 = S.areaAuto, difere = (a, b) => Math.abs(a.x - b.x) > 0.03 || Math.abs(a.w - b.w) > 0.03 || Math.abs(a.y - b.y) > 0.03 || Math.abs(a.h - b.h) > 0.03;
          if (!a0) { S.areaAuto = nova; if (pallet) S.palletRef = pallet; S.ultimoQuadro = null; }
          else if (difere(a0, nova)) {
            // só move a área se o pallet aparecer no novo lugar em 4 leituras seguidas (pessoa tapando o pallet não mexe na área)
            if (S.areaCand && !difere(S.areaCand, nova)) S.areaCandN++; else { S.areaCand = nova; S.areaCandN = 1; }
            if (S.areaCandN >= 4) { S.areaAuto = nova; if (pallet) S.palletRef = pallet; S.ultimoQuadro = null; S.areaCand = null; }
          } else { S.areaCand = null; if (pallet) S.palletRef = pallet; }
        }
        const z = areaAtiva();
        const itens = fin.filter(b => b.classe !== 'pallet');
        let dentro = z ? itens.filter(b => { const cx = b.x + b.w / 2, cy = b.y + b.h / 2; return cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h; }) : itens;
        // Só conta o que está EM CIMA DO PALLET: apoiado no pallet ou numa caixa que já está na pilha.
        // Caixa plástica, caixa no chão ao lado, mesa, outra pilha — mesmo dentro da área — ficam de fora (cinza na tela).
        if (apoio) {
          const ok = naPilha(dentro, apoio); for (const b of itens) b.foraPilha = !ok.has(b); dentro = dentro.filter(b => ok.has(b));
          const u = [apoio, ...dentro], ux0 = Math.min(...u.map(b => b.x)), uy0 = Math.min(...u.map(b => b.y)), ux1 = Math.max(...u.map(b => b.x + b.w)), uy1 = Math.max(...u.map(b => b.y + b.h));
          if (pallet || (base && base.n >= 2)) S.pilhaRef = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
        }
        else if (S.temClassePallet) { for (const b of itens) b.foraPilha = true; dentro = []; }   // sem pallet e sem pilha: caixa solta não conta
        const cont = {}; for (const b of dentro) cont[b.classe] = (cont[b.classe] || 0) + 1;
        avaliarContagem(cont, S.temClassePallet ? !!apoio : true, t);
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
    /* peças já contadas no pallet que está na frente da câmera = soma dos eventos desde a última troca de pallet.
       Serve para, ao ligar (ou recarregar) a câmera, contar só as peças que ainda não foram contadas. */
    function contadasNoPalletAtual() {
      const evs = (S.eventosLinha || []).concat(S.eventos.filter(e => e.local)).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      let n = 0; for (const e of evs) { if (e.origem === 'troca_pallet') n = 0; else n += Number(e.valor) || 0; }
      return Math.max(0, n);
    }
    const soma = c => Object.values(c).reduce((s, v) => s + v, 0);
    /* cont = { peca: 3 } dentro da área; palletOk = a IA está vendo o pallet.
       A cada leitura da IA guarda o resultado; quando a cena fica parada (sem pessoa/mão/movimento) e a MAIORIA das
       leituras dos últimos segundos concorda, compara com a última contagem estável: +n colocadas, −n retiradas.
       Pallet sumiu = pallet saiu (não são retiradas); pallet voltou vazio = pallet novo, a contagem continua somando.
       A janela de tempo acompanha a velocidade do aparelho (celular lento faz menos leituras por segundo). */
    const chave = c => Object.keys(c).filter(k => c[k]).sort().map(k => k + ':' + c[k]).join(',') || 'vazio';
    function naPilha(itens, p) {
      const sup = [{ x: p.x - p.w * 0.08, y: p.y, w: p.w * 1.16, h: p.h, pallet: true }], ok = new Set();
      const sobre = (a, s) => {
        const ov = Math.min(a.x + a.w, s.x + s.w) - Math.max(a.x, s.x);
        if (ov < 0.5 * Math.min(a.w, s.w)) return false;   // tem que estar com pelo menos metade em cima do apoio
        const fundo = a.y + a.h;
        return fundo >= s.y - 0.5 * a.h - 0.03 && fundo <= (s.pallet ? s.y + s.h + 0.02 : s.y + s.h * 0.8 + a.h * 0.5 + 0.02);
      };
      for (let mudou = true; mudou;) { mudou = false; for (const a of itens) if (!ok.has(a) && sup.some(s => sobre(a, s))) { ok.add(a); sup.push(a); mudou = true; } }
      return ok;
    }
    function avaliarContagem(cont, palletOk, t) {
      if (S.testandoCameras) return;
      S.contAtual = cont; S.palletOk = palletOk;
      if (S.ultLeitura) S.intervalo = S.intervalo ? S.intervalo * 0.8 + (t - S.ultLeitura) * 0.2 : t - S.ultLeitura;
      S.ultLeitura = t;
      if (!areaAtiva()) { S.estado = S.temClassePallet ? 'sem_pallet' : 'livre'; return; }
      const pessoa = sobrepoe(S.pessoaBox), mov = movimentoRecente(t), mao = S.ultimaMao && t - S.ultimaMao < 1500;
      if (pessoa || mov || mao) S.ultimaPresenca = t;   // alguém mexeu no pallet (vale para as próximas ~25 s)
      // A IA de pessoas viu alguém na frente do pallet: espera sair (a pessoa tapa as caixas).
      if (pessoa) { S.estado = 'ocupado'; S.histCont = []; S.comMov = true; return; }
      // Só movimento perto da pilha (celular sem a IA de pessoas, braço, gente passando atrás): NÃO trava — continua
      // lendo, mas só aceita leitura bem firme e só para SOMAR caixa ("menos caixas" com movimento = alguém tapando).
      S.comMov = !!(mov || mao);
      // Leituras dos últimos segundos → MEDIANA por classe (uma leitura que oscila não derruba a decisão).
      // Estável = a maioria das leituras concorda com a mediana; se não concordar nunca (câmera tremendo, luz piscando),
      // decide mesmo assim 12 s depois de a pessoa sair — a contagem não pode travar em "confirmando".
      const janela = Math.min(10000, Math.max(5000, (S.intervalo || 700) * 6));
      S.histCont.push({ t, cont: { ...cont }, palletOk, mov: S.comMov }); S.histCont = S.histCont.filter(h => t - h.t <= janela);
      const n = S.histCont.length, span = t - S.histCont[0].t;
      // Leitura MAIS FREQUENTE da janela (moda): caixa fina oscila 11/12/13 de um quadro para o outro, a moda fica no 12.
      // Empate: fica com a já confirmada (não troca à toa); senão, a do meio.
      const chaveDe = h => (h.palletOk ? 'P|' : 'X|') + chave(h.cont);
      const freq = new Map(); for (const h of S.histCont) { const c = chaveDe(h); freq.set(c, (freq.get(c) || 0) + 1); }
      let k = null, fk = 0;
      for (const [c, f] of freq) if (f > fk || (f === fk && c === S.chaveEstavel)) { k = c; fk = f; }
      if ([...freq.values()].filter(f => f === fk).length > 1 && !(S.chaveEstavel && freq.get(S.chaveEstavel) === fk)) {
        const emp = S.histCont.filter(h => freq.get(chaveDe(h)) === fk).sort((a, b) => soma(a.cont) - soma(b.cont)); k = chaveDe(emp[Math.floor((emp.length - 1) / 2)]);
      }
      const rep = S.histCont.find(h => chaveDe(h) === k);
      const med = { ...rep.cont }, palletMaj = rep.palletOk;
      const concordam = fk / n;
      const semPresencaHa = t - (S.ultimaPresenca || -1e9);
      // se teve movimento em QUALQUER leitura da janela, vale a regra firme (as leituras com movimento podem estar tapadas)
      const movJanela = S.histCont.some(h => h.mov); S.movJanela = movJanela;
      const estavel = movJanela
        ? n >= 4 && span >= janela * 0.6 && concordam >= 0.8
        : n >= 3 && span >= Math.min(2500, janela * 0.6) && (concordam >= (k === S.chaveEstavel ? 0.6 : 0.7) || (semPresencaHa > 12000 && span >= janela * 0.9));
      S.concordam = concordam;
      if (!estavel) { if (S.contEstavel !== null && k !== S.chaveEstavel) S.estado = 'confirmando'; else if (S.contEstavel === null) S.estado = 'calibrando'; else if (S.comMov) S.estado = 'ocupado'; return; }
      cont = med; palletOk = palletMaj;
      if (S.contEstavel === null) {
        if (!S.eventosProntos) { S.estado = 'calibrando'; return; }   // espera saber o que já foi contado hoje
        // 1ª leitura estável = ponto de partida. O que JÁ está no pallet ao ligar (ou ao recalibrar / trocar de câmera)
        // NÃO conta: só conta caixa COLOCADA depois disso.
        S.contEstavel = { ...cont }; S.palletEstavel = palletOk; S.chaveEstavel = k; S.tUltimoEvento = t; S.estado = palletOk ? 'livre' : 'sem_pallet'; return;
      }
      if (k === S.chaveEstavel) { S.estado = !palletOk ? 'sem_pallet' : S.comMov ? 'ocupado' : 'livre'; return; }
      // pallet saiu (com ou sem carga) ou chegou um pallet novo: não é colocar/retirar peça — a contagem continua
      if (S.temClassePallet && palletOk !== S.palletEstavel) {
        if (!palletOk) { registrar('troca_pallet', 0, null, 'pallet saiu'); S.antesSaiu = { n: soma(S.contEstavel || {}), t }; }
        else {
          const nNovo = soma(cont), maxV = S.cfg.multiplas ? 6 : 2, ant = S.antesSaiu;
          // voltou em menos de 1 min com pelo menos as mesmas caixas = o MESMO pallet (alguém tapou a pilha): conta só as a mais
          const mesmo = ant && ant.n > 0 && t - ant.t < 60000 && nNovo >= ant.n;
          registrar('troca_pallet', 0, null, mesmo ? 'pallet voltou a aparecer' : 'pallet novo' + (nNovo ? ' (' + chave(cont) + ')' : ' vazio'));
          // pallet coberto/invisível: ele só "aparece" quando a 1ª caixa é colocada → essas 1–2 caixas foram colocadas agora
          const novas = mesmo ? nNovo - ant.n : S.palletVirtual ? nNovo : 0;
          if (novas > 0 && novas <= maxV && t - (S.ultimaPresenca || -1e9) < 25000) {
            const tipo = Object.entries(cont).sort((x, y) => y[1] - x[1])[0][0]; registrar('ia', novas, null, tipo);
          }
          S.antesSaiu = null;
        }
        S.tUltimoEvento = t;
      } else if (t - (S.ultimaPresenca || -1e9) > 25000) {
        // mudou sem nenhum movimento/pessoa/mão no pallet (sombra, reflexo, a IA oscilou): só ajusta a referência, não conta
        S.ajustes = (S.ajustes || 0) + 1; console.info('Contador: mudança sem movimento no pallet ignorada', chave(S.contEstavel), '→', chave(cont));
      } else {
        const tipos = new Set([...Object.keys(cont), ...Object.keys(S.contEstavel)]);
        const deltas = [...tipos].map(tipo => [tipo, (cont[tipo] || 0) - (S.contEstavel[tipo] || 0)]);
        // Ninguém coloca nem tira 3+ caixas de uma vez: queda grande (ou pallet cheio → vazio) = pallet trocado sem a câmera
        // ver o "sem pallet" no meio; subida grande = chegou pallet já carregado (ou a IA viu outra coisa). Nenhum dos dois conta.
        const tot = soma(cont), totAnt = soma(S.contEstavel), dif = tot - totAnt, maxPorVez = S.cfg.multiplas ? 6 : 2;
        if (S.temClassePallet && ((dif <= -3 && (!movJanela || tot === 0)) || (tot === 0 && totAnt >= 1) || dif > maxPorVez)) {   // com movimento, queda grande só se esvaziou (senão é alguém tapando)
          registrar('troca_pallet', 0, null, dif < 0 ? `pallet trocado (${totAnt} → ${tot})` : `pallet chegou com ${tot}`);
          S.tUltimoEvento = t; S.chaveAnterior = null;
          S.contEstavel = { ...cont }; S.palletEstavel = palletOk; S.chaveEstavel = k; S.estado = 'livre'; return;
        }
        // Com movimento na pilha, "menos 1 ou 2 caixas" é alguém tapando a pilha: não desconta (só depois que parar de mexer).
        if (movJanela && dif < 0) { S.estado = 'ocupado'; return; }
        // Peça não some sozinha: "menos peças" sem ninguém ter chegado perto do pallet desde a última contagem é a IA
        // oscilando (peça fina mal vista) — ignora e mantém a contagem; se persistir 25 s, a referência se ajusta sozinha acima.
        if (deltas.every(([, d]) => d <= 0) && (S.ultimaPresenca || 0) <= (S.tUltimoEvento || 0)) { S.oscilacoes = (S.oscilacoes || 0) + 1; S.estado = 'livre'; return; }
        // Voltar à contagem de antes da última mudança (16→15→16) só com leituras MUITO firmes — senão é oscilação
        if (k === S.chaveAnterior && t - (S.tUltimoEvento || 0) < 30000 && !(concordam >= 0.85 && n >= 5 && span >= janela * 0.9)) { S.estado = 'confirmando'; return; }
        for (const [tipo, delta] of deltas) {
          if (delta > 0) registrar('ia', Math.min(50, delta), null, tipo);
          else if (delta < 0) registrar('ia_retirada', Math.min(50, -delta), null, tipo);
        }
        S.tUltimoEvento = t;
      }
      S.chaveAnterior = S.chaveEstavel;
      S.contEstavel = { ...cont }; S.palletEstavel = palletOk; S.chaveEstavel = k; S.estado = palletOk ? 'livre' : 'sem_pallet';
    }
    /* Onde olhar movimento: a PILHA (pallet + caixas que a IA achou na área, com margem para o braço que coloca a caixa),
       não a área inteira — gente passando no corredor do fundo, empilhadeira, chão e reflexo fora do pallet não travam
       a contagem. Sem nada detectado usa a última pilha (até 15 s) e, depois, a área toda. */
    function regiaoPilha(z, t) {
      const dentroZ = b => { const cx = b.x + b.w / 2, cy = b.y + b.h / 2; return cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h; };
      const caixas = (S.dets || []).filter(b => b.classe === 'pallet' ? b === S.palletBox : dentroZ(b) && !b.foraPilha);
      if (caixas.length) {
        let x0 = Math.min(...caixas.map(b => b.x)), y0 = Math.min(...caixas.map(b => b.y));
        let x1 = Math.max(...caixas.map(b => b.x + b.w)), y1 = Math.max(...caixas.map(b => b.y + b.h));
        const w = x1 - x0, h = y1 - y0;
        x0 -= w * 0.12; x1 += w * 0.12; y0 -= Math.min(0.1, Math.max(h * 0.2, 0.06)); y1 += Math.max(0.02, h * 0.05);   // em cima: o braço com a próxima caixa
        const g = { x: Math.max(z.x, x0), y: Math.max(z.y, y0) }; g.w = Math.min(z.x + z.w, x1) - g.x; g.h = Math.min(z.y + z.h, y1) - g.y;
        if (g.w > 0.03 && g.h > 0.03) { S.regMov = g; S.regMovT = t; }
      }
      if (S.regMov && t - (S.regMovT || 0) > 15000) S.regMov = null;
      return S.regMov || z;
    }
    function movimentoRecente(t) {
      const z = areaAtiva(); if (!z) return false;
      const atual = amostraZona(), ult = S.ultimoQuadro;
      let mov = 0;
      if (ult) {
        const r = regiaoPilha(z, t);
        const i0 = Math.max(0, Math.floor((r.x - z.x) / z.w * REF_W)), i1 = Math.min(REF_W, Math.ceil((r.x + r.w - z.x) / z.w * REF_W));
        const j0 = Math.max(0, Math.floor((r.y - z.y) / z.h * REF_H)), j1 = Math.min(REF_H, Math.ceil((r.y + r.h - z.y) / z.h * REF_H));
        // tira a variação geral de luz (exposição automática do celular, nuvem, lâmpada) antes de comparar
        let soma = 0, n = 0;
        for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { const c = j * REF_W + i; soma += atual.g[c] - ult.g[c]; n++; }
        if (n) {
          const md = soma / n; let mud = 0;
          for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { const c = j * REF_W + i; if (Math.abs(atual.g[c] - ult.g[c] - md) > 16) mud++; }
          mov = mud / n;
        }
      }
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
      // 2ª câmera aberta na mesma célula: não conta nada (a outra já está contando)
      if (S.camDuplicada && origem !== 'manual_mais' && origem !== 'manual_menos') return;
      S.seqEv = (S.seqEv || 0) + 1;
      const ev = { uid: CAM_ID.slice(0, 20) + '-' + Date.now().toString(36) + '-' + S.seqEv, cam: CAM_ID, linha_id: S.linhaId, sessao_id: S.sessaoId || (S.sessao ? S.sessao.id : null), origem, valor: Math.abs(valor) || undefined, ts: new Date().toISOString(), mudanca_pct: frac != null ? Math.round(frac * 1000) / 10 : null, foto: miniatura(), dispositivo: disp, detalhe: detalhe || null };
      if (valor) { S.contagem += valor; o.onContagem && o.onContagem(S.contagem); if (o.flash) { o.flash.classList.add('on'); setTimeout(() => o.flash.classList.remove('on'), 250); } if (navigator.vibrate) navigator.vibrate(60); }
      S.eventos.push({ ts: ev.ts, valor, origem, detalhe: ev.detalhe, local: true });
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
      const daLinha = S.sessaoId ? await API.get(`/api/contador/eventos?data=${hojeISO()}&linha_id=${S.linhaId}`).catch(() => null) : lista;
      S.eventosLinha = (daLinha || lista).map(e => ({ ts: e.ts, valor: e.valor, origem: e.origem }));
      S.eventosProntos = true;
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
        if (S.regMov) { const r = S.regMov; sctx.strokeStyle = S.estado === 'ocupado' ? 'rgba(240,180,41,.9)' : 'rgba(240,180,41,.45)'; sctx.lineWidth = 1.5; sctx.setLineDash([3, 3]); sctx.strokeRect(mapX(r.x), mapY(r.y), r.w / sw * W, r.h / sh * H); sctx.setLineDash([]); }
        if (S.recorte) { const r = S.recorte; sctx.strokeStyle = 'rgba(255,255,255,.25)'; sctx.lineWidth = 1; sctx.setLineDash([2, 4]); sctx.strokeRect(mapX(r.x), mapY(r.y), r.w / sw * W, r.h / sh * H); sctx.setLineDash([]); }
        sctx.lineWidth = 2; sctx.font = 'bold 11px sans-serif';
        for (const b of S.dets) {
          const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dentro = b.classe === 'pallet' || ((!za || (cx >= za.x && cx <= za.x + za.w && cy >= za.y && cy <= za.y + za.h)) && !b.foraPilha);
          const cor = COR_CLASSE[b.classe] || COR_CLASSE.objeto;
          tracarItem(sctx, b, mapX, mapY);
          if (dentro && b.pts) { sctx.fillStyle = cor + '33'; sctx.fill(); }
          sctx.strokeStyle = dentro ? cor : 'rgba(255,255,255,.3)'; sctx.stroke();
          if (dentro) { sctx.fillStyle = cor; sctx.fillText(ROTULO_CLASSE[b.classe] || b.classe, mapX(b.x) + 3, mapY(b.y) + 12); }
        }
      }
      if (S.maos && S.maos.length) { const za = areaAtiva(); for (const m of S.maos) { const dentro = za && m.x >= za.x && m.x <= za.x + za.w && m.y >= za.y && m.y <= za.y + za.h; sctx.fillStyle = dentro ? '#35C95C' : 'rgba(255,255,255,.6)'; sctx.beginPath(); sctx.arc(mapX(m.x), mapY(m.y), dentro ? 7 : 4, 0, Math.PI * 2); sctx.fill(); } }
      if (S.pessoaBox) { sctx.strokeStyle = 'rgba(86,182,224,.9)'; sctx.lineWidth = 2; sctx.strokeRect(mapX(S.pessoaBox.x), mapY(S.pessoaBox.y), S.pessoaBox.w / sw * W, S.pessoaBox.h / sh * H); }
      const nomes = { calibrando: 'Calibrando — saia da frente do pallet', livre: 'Livre', ocupado: S.posePronto ? 'Pessoa no pallet' : 'Movimento no pallet', assentando: 'Conferindo…', confirmando: 'Confirmando…' + (S.concordam != null ? ' (' + Math.round(S.concordam * 100) + '% das leituras)' : '') };
      const ia = !S.modelo ? '' : S.modelo.tipo === 'cls' ? ' · pallet ' + (S.probCom == null ? '?' : S.probCom > 0.5 ? 'COM PEÇAS' : 'VAZIO') + ' (' + Math.round((S.probCom || 0) * 100) + '%)' : ' · ' + resumoPallet();
      const temArea = !!areaAtiva();
      const maoAgora = S.ultimaMao && performance.now() - S.ultimaMao < 1500;
      const txt = (S.camDuplicada ? '⚠ OUTRA CÂMERA JÁ CONTA ESTA CÉLULA — esta não conta · ' : '') + (S.pausado ? 'PAUSADO · ' : '') + (maoAgora ? '✋ mão no pallet · ' : '') + (S.estado === 'sem_pallet' ? 'Sem pallet' : temArea ? nomes[S.estado] : (S.modelo && S.modelo.tipo !== 'cls' ? 'Procurando o pallet…' : 'Sem área marcada')) + ia + ' · ' + S.fps + ' fps' + (S.modelo && S.intervalo > 1200 ? ' · IA a cada ' + (S.intervalo / 1000).toFixed(1).replace('.', ',') + ' s' : '');
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
        // mesma proporção da câmera (celular em pé = 480×640): imagem do painel e amostras de treino sem distorção
        const EW = video.videoWidth >= video.videoHeight ? 640 : 480, EH = video.videoWidth >= video.videoHeight ? 480 : 640;
        if (envio.width !== EW || envio.height !== EH) { envio.width = EW; envio.height = EH; }
        ectx.drawImage(video, 0, 0, EW, EH);
        const quadroLimpo = envio.toDataURL('image/jpeg', 0.6);   // sem desenhos: é o que vira amostra de treino
        if (S.zona) { ectx.strokeStyle = S.estado === 'ocupado' ? 'rgba(240,180,41,.9)' : 'rgba(53,201,92,.9)'; ectx.lineWidth = 2; ectx.strokeRect(S.zona.x * EW, S.zona.y * EH, S.zona.w * EW, S.zona.h * EH); }
        if (S.regMov) { const r = S.regMov; ectx.strokeStyle = S.estado === 'ocupado' ? 'rgba(240,180,41,.95)' : 'rgba(240,180,41,.5)'; ectx.lineWidth = 1.5; ectx.setLineDash([4, 4]); ectx.strokeRect(r.x * EW, r.y * EH, r.w * EW, r.h * EH); ectx.setLineDash([]); }
        if (S.modelo && S.modelo.tipo !== 'cls') { ectx.lineWidth = 2; ectx.font = 'bold 13px sans-serif'; for (const b of S.dets) { const cor = b.foraPilha ? 'rgba(255,255,255,.35)' : (COR_CLASSE[b.classe] || COR_CLASSE.objeto); tracarItem(ectx, b, x => x * EW, y => y * EH); if (b.pts && !b.foraPilha) { ectx.fillStyle = cor + '33'; ectx.fill(); } ectx.strokeStyle = cor; ectx.stroke(); if (b.foraPilha) continue; ectx.fillStyle = cor; ectx.fillText(ROTULO_CLASSE[b.classe] || b.classe, b.x * EW + 3, b.y * EH + 14); } }
        ectx.fillStyle = 'rgba(10,22,32,.7)'; ectx.fillRect(0, 0, EW, 26);
        ectx.fillStyle = '#fff'; ectx.font = 'bold 14px sans-serif';
        ectx.fillText(`${(S.linha && (S.linha.nome || S.linha.celula)) || ''}  ·  ${S.contagem} un  ·  ${new Date().toLocaleTimeString('pt-BR')}`, 10, 18);
        const body = { linha_id: S.linhaId, produto_id: S.produtoId, sessao_id: S.sessaoId || (S.sessao ? S.sessao.id : null), contagem: S.contagem, estado: areaAtiva() ? S.estado : 'sem_area', resumo: S.modelo && S.modelo.tipo !== 'cls' ? resumoPallet() : null, dispositivo: disp, cam: CAM_ID, jpeg: envio.toDataURL('image/jpeg', 0.55), jpeg_limpo: quadroLimpo };
        if (S.capacidades && !S.capEnviadas) body.capacidades = S.capacidades;
        const r = await fetch('/api/contador/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 401) location.href = '/login';
        if (r.ok) {
          S.capEnviadas = true; const j = await r.json().catch(() => ({}));
          const dup = !!j.outraCam; if (dup !== !!S.camDuplicada) { S.camDuplicada = dup; if (dup) avisoErro('Outra câmera já está contando esta célula — esta NÃO conta (feche a outra ou esta).'); else recalibrar(); }
          if (j.comandos) sincronizar(false).catch(() => {});
        }
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
      get modelo() { return S.modelo; }, get resumo() { return resumoPallet(); }, get contAtual() { return S.contAtual; }, get palletOk() { return S.palletOk; }, get dets() { return S.dets; }, get contagem() { return S.contagem; }, get sessao() { return S.sessao; }, get eventos() { return S.eventos; }, get cfg() { return S.cfg; }, get zona() { return S.zona; }, get ativo() { return S.ativo; }, get recorte() { return S.recorte; }, get areaAuto() { return S.areaAuto; }, debugRecorte() { return det.toDataURL('image/jpeg', 0.7); }
    };
  }
  return { criar, CFG_PADRAO };
})();
