const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/*
 * Contador por câmera.
 *
 * Linha = célula + produto do cadenciador (tabela cont_linhas), criada no PC.
 * O celular abre o link da linha, conecta a câmera e passa a:
 *   - mandar um quadro JPEG a cada ~0,7 s (só o último fica em memória: ao vivo);
 *   - buscar a configuração e os comandos a cada ~1,5 s (área do pallet, caixa,
 *     câmera, zoom, sensibilidade; recalibrar, +1/−1, troca de pallet...).
 * Assim quem está no PC vê a imagem e configura a câmera de longe.
 * Os eventos de contagem (com miniatura de evidência) vão para o banco.
 */

const QUADROS = new Map();    // linha_id -> { buf, ts, contagem, estado, dispositivo, usuario, capacidades }
const COMANDOS = new Map();   // linha_id -> [{ tipo, valor, ts }]
const QUADRO_MAX = 600 * 1024;
const FOTO_MAX = 200 * 1024;
const VIVO_MS = 8000;

const b64jpeg = (s) => {
  const m = /^data:image\/jpeg;base64,(.+)$/s.exec(s || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 ? buf : null;
};
/* Datas e horas sempre no fuso do Node (TZ=America/Sao_Paulo em produção) —
   o Postgres da nuvem fica em UTC, então nada de LOCALTIME/CURRENT_DATE aqui. */
const FUSO = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
const pad = n => String(n).padStart(2, '0');
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const agoraHMS = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const diaLocal = (col, idx) => `(${col} AT TIME ZONE '${FUSO}')::date = $${idx}::date`;
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const idOk = v => /^\d+$/.test(String(v || ''));
const naoPcp = (req, res, next) => req.session.role === 'pcp' ? res.status(403).json({ error: 'Perfil PCP: somente visualização' }) : next();

/* ───────── Config da linha ───────── */
const CONFIG_PADRAO = { zona: null, caixa: null, sens: 5, camera: '', zoom: null, lanterna: false, resolucao: 'media', multiplas: false };
const ret = o => o && typeof o === 'object' && ['x', 'y', 'w', 'h'].every(k => isFinite(Number(o[k]))) ? { x: +o.x, y: +o.y, w: +o.w, h: +o.h } : null;
function limparConfig(c) {
  c = c || {};
  const out = {};
  if ('zona' in c) out.zona = ret(c.zona);
  if ('caixa_pos' in c) out.caixa_pos = c.caixa_pos && isFinite(Number(c.caixa_pos.x)) ? { x: +c.caixa_pos.x, y: +c.caixa_pos.y } : null;
  if ('caixa' in c) out.caixa = c.caixa && isFinite(Number(c.caixa.w)) && isFinite(Number(c.caixa.h)) ? { w: +c.caixa.w, h: +c.caixa.h } : null;
  if ('sens' in c) out.sens = Math.min(10, Math.max(1, Number(c.sens) || 5));
  if ('camera' in c) out.camera = String(c.camera || '').slice(0, 200);
  if ('zoom' in c) out.zoom = c.zoom == null || c.zoom === '' ? null : Number(c.zoom);
  if ('lanterna' in c) out.lanterna = !!c.lanterna;
  if ('resolucao' in c) out.resolucao = ['baixa', 'media', 'alta'].includes(c.resolucao) ? c.resolucao : 'media';
  if ('multiplas' in c) out.multiplas = !!c.multiplas;
  return out;
}

const SQL_LINHA = `
  SELECT l.id, l.celula, l.produto_id, l.nome, l.config, l.ativa, l.updated_at,
         p.nome AS produto_nome, p.cod_decio, p.takt_min::float AS takt_padrao, p.celula_id AS produto_celula_id
    FROM cont_linhas l LEFT JOIN cad_produtos p ON p.id = l.produto_id`;

async function carregarLinha(id, produtoId) {
  const r = await pool.query(SQL_LINHA + ' WHERE l.id = $1', [id]);
  if (!r.rows[0]) return null;
  const l = r.rows[0];
  l.config_linha = { ...CONFIG_PADRAO, ...(l.config || {}) };
  l.config_produto = {};
  const pid = idOk(produtoId) ? Number(produtoId) : l.produto_id;
  if (pid) {
    const p = await pool.query('SELECT config, updated_at FROM cont_linha_produto WHERE linha_id = $1 AND produto_id = $2', [l.id, pid]);
    if (p.rows[0]) { l.config_produto = p.rows[0].config || {}; if (p.rows[0].updated_at > l.updated_at) l.updated_at = p.rows[0].updated_at; }
  }
  l.config_produto_id = pid || null;
  l.config = { ...l.config_linha, ...l.config_produto };   // o produto sobrepõe a linha
  return l;
}
async function sessaoPorId(id) {
  const r = await pool.query(
    `SELECT s.id, s.takt_min::float AS takt_min, s.status, s.produto_id, t.nome AS turno_nome, t.codigo AS turno_codigo,
            (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos,
            (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id AND c.hora_prevista <= $2::time) AS esperado
       FROM cad_sessoes s JOIN turnos t ON t.id = s.turno_id WHERE s.id = $1`, [id, agoraHMS()]);
  return r.rows[0] || null;
}
/* Sessão do cadenciador de hoje para o produto da linha (prefere a aberta) */
async function sessaoDeHoje(produtoId) {
  if (!produtoId) return null;
  const r = await pool.query(
    `SELECT s.id, s.takt_min::float AS takt_min, s.status, t.nome AS turno_nome, t.codigo AS turno_codigo,
            (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos,
            (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id AND c.hora_prevista <= $3::time) AS esperado
       FROM cad_sessoes s JOIN turnos t ON t.id = s.turno_id
      WHERE s.produto_id = $1 AND s.data = $2
      ORDER BY (s.status = 'aberta') DESC, s.id DESC LIMIT 1`, [produtoId, hoje(), agoraHMS()]);
  return r.rows[0] || null;
}

/* ───────── Linhas (CRUD — PC) ───────── */

router.get('/linhas', requireAuth, async (req, res) => {
  try {
    const data = dataOk(req.query.data) ? req.query.data : hoje();
    const linhas = (await pool.query(SQL_LINHA + ' WHERE l.ativa ORDER BY l.celula')).rows;
    const contagens = (await pool.query(
      `SELECT linha_id, sessao_id, SUM(valor)::int AS contagem, MAX(ts) AS ultimo FROM cont_eventos WHERE ${diaLocal('ts', 1)} GROUP BY linha_id, sessao_id`, [data])).rows;
    const agora = Date.now();
    const porProduto = (await pool.query('SELECT linha_id, produto_id, config FROM cont_linha_produto')).rows;
    for (const l of linhas) {
      let q = QUADROS.get(l.id);
      if (q && agora - q.ts >= VIVO_MS) q = { ...q, produto_id: null, sessao_id: null };   // aparelho offline: não manda mais no produto/sessão
      if (q && q.produto_id && q.produto_id !== l.produto_id) l.produto_id = q.produto_id;   // o aparelho ligado trocou de produto
      const cp = porProduto.find(x => x.linha_id === l.id && x.produto_id === l.produto_id);
      l.config_linha = { ...CONFIG_PADRAO, ...(l.config || {}) };
      l.config_produto = cp ? cp.config : {};
      l.config = { ...l.config_linha, ...l.config_produto };
      l.produtos_configurados = porProduto.filter(x => x.linha_id === l.id).map(x => x.produto_id);
      let c = {};
      l.online = !!q && agora - q.ts < VIVO_MS;
      l.frame_ts = q ? q.ts : null;
      l.estado = q ? q.estado : ''; l.resumo = q ? q.resumo : null;
      l.dispositivo = q ? q.dispositivo : null;
      l.usuario = q ? q.usuario : null;
      l.capacidades = q ? q.capacidades : null;
      if (q && q.produto_id) { const pn = (await pool.query('SELECT nome FROM cad_produtos WHERE id = $1', [q.produto_id])).rows[0]; if (pn) l.produto_nome = pn.nome; }
      l.sessao = q && q.sessao_id ? await sessaoPorId(q.sessao_id) : await sessaoDeHoje(l.produto_id);
      // contagem da sessão em andamento; sem sessão, o total do dia da câmera
      const doDia = contagens.filter(x => x.linha_id === l.id);
      c = l.sessao ? (doDia.find(x => x.sessao_id === l.sessao.id) || {}) : { contagem: doDia.reduce((s, x) => s + x.contagem, 0), ultimo: doDia.map(x => x.ultimo).sort().pop() || null };
      l.contagem = c.contagem || 0;
      l.ultimo = c.ultimo || null;
    }
    res.json(linhas);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/linhas', requireAuth, naoPcp, async (req, res) => {
  try {
    const { celula, produto_id, nome } = req.body || {};
    if (!celula || !String(celula).trim()) return res.status(400).json({ error: 'Célula obrigatória' });
    const r = await pool.query(
      `INSERT INTO cont_linhas (celula, produto_id, nome) VALUES ($1, $2, $3)
       ON CONFLICT (celula) DO UPDATE SET produto_id = COALESCE(EXCLUDED.produto_id, cont_linhas.produto_id), nome = COALESCE(EXCLUDED.nome, cont_linhas.nome), ativa = TRUE, updated_at = NOW()
       RETURNING id`,
      [String(celula).trim().slice(0, 80), idOk(produto_id) ? Number(produto_id) : null, nome ? String(nome).slice(0, 120) : null]);
    res.json(await carregarLinha(r.rows[0].id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/linhas/:id', requireAdmin, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).end();
    const { celula, produto_id, nome, ativa } = req.body || {};
    const set = ['updated_at = NOW()'], params = [req.params.id];
    if (celula) { params.push(String(celula).trim().slice(0, 80)); set.push(`celula = $${params.length}`); }
    if (produto_id !== undefined) { params.push(idOk(produto_id) ? Number(produto_id) : null); set.push(`produto_id = $${params.length}`); }
    if (nome !== undefined) { params.push(nome ? String(nome).slice(0, 120) : null); set.push(`nome = $${params.length}`); }
    if (typeof ativa === 'boolean') { params.push(ativa); set.push(`ativa = $${params.length}`); }
    await pool.query(`UPDATE cont_linhas SET ${set.join(', ')} WHERE id = $1`, params);
    res.json(await carregarLinha(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/linhas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE cont_linhas SET ativa = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    QUADROS.delete(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/linhas/:id/config', requireAuth, async (req, res) => {
  try {
    const l = await carregarLinha(req.params.id, req.query.produto_id);
    if (!l) return res.status(404).json({ error: 'Linha não encontrada' });
    res.json({ config: l.config, config_linha: l.config_linha, config_produto: l.config_produto, produto_id: l.config_produto_id, updated_at: l.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Configuração da câmera/área — feita do PC (ou do próprio celular) */
router.put('/linhas/:id/config', requireAuth, naoPcp, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).end();
    const novo = limparConfig(req.body);
    const pid = idOk(req.body && req.body.produto_id) ? Number(req.body.produto_id) : null;
    if (pid) {
      await pool.query(
        `INSERT INTO cont_linha_produto (linha_id, produto_id, config) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (linha_id, produto_id) DO UPDATE SET config = cont_linha_produto.config || EXCLUDED.config, updated_at = NOW()`,
        [req.params.id, pid, JSON.stringify(novo)]);
      await pool.query('UPDATE cont_linhas SET updated_at = NOW() WHERE id = $1', [req.params.id]);   // acorda o aparelho
    } else {
      const r = await pool.query(`UPDATE cont_linhas SET config = config || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING id`, [req.params.id, JSON.stringify(novo)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Linha não encontrada' });
    }
    const l = await carregarLinha(req.params.id, pid);
    res.json({ config: l.config, config_linha: l.config_linha, config_produto: l.config_produto, updated_at: l.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/linhas/:id/config/:produto', requireAuth, naoPcp, async (req, res) => {
  try {
    await pool.query('DELETE FROM cont_linha_produto WHERE linha_id = $1 AND produto_id = $2', [req.params.id, req.params.produto]);
    await pool.query('UPDATE cont_linhas SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Comando remoto para o celular: recalibrar | troca_pallet | mais | menos | reiniciar_camera */
const TIPOS_CMD = ['recalibrar', 'troca_pallet', 'mais', 'menos', 'reiniciar_camera', 'encerrar'];
router.post('/linhas/:id/comando', requireAuth, naoPcp, (req, res) => {
  const { tipo } = req.body || {};
  if (!TIPOS_CMD.includes(tipo)) return res.status(400).json({ error: 'Comando inválido' });
  const id = Number(req.params.id);
  const fila = COMANDOS.get(id) || [];
  fila.push({ tipo, ts: Date.now(), por: req.session.nome || req.session.username });
  COMANDOS.set(id, fila.slice(-20));
  res.json({ ok: true });
});

/* O celular pergunta: config atual + sessão do cadenciador + comandos pendentes */
router.get('/linhas/:id/estado', requireAuth, async (req, res) => {
  try {
    const l = await carregarLinha(req.params.id, req.query.produto_id);
    if (!l || !l.ativa) return res.status(404).json({ error: 'Linha não encontrada' });
    const comandos = COMANDOS.get(l.id) || [];
    COMANDOS.set(l.id, []);
    const data = hoje();
    const sessao = idOk(req.query.sessao_id) ? await sessaoPorId(req.query.sessao_id) : await sessaoDeHoje(l.config_produto_id);
    const params = [l.id, data]; let where = `linha_id = $1 AND ${diaLocal('ts', 2)}`;
    if (sessao) { params.push(sessao.id); where += ` AND sessao_id = $3`; }
    const cont = (await pool.query(`SELECT COALESCE(SUM(valor), 0)::int AS c FROM cont_eventos WHERE ${where}`, params)).rows[0].c;
    const modelo = await modeloAtual(l.id, l.config_produto_id);
    res.json({ linha: { id: l.id, celula: l.celula, nome: l.nome, produto_id: l.config_produto_id, produto_nome: l.produto_nome, takt_padrao: l.takt_padrao },
      config: l.config, config_ts: l.updated_at, sessao, contagem: cont, comandos, agora: Date.now(),
      modelo: modelo ? { id: modelo.id, chave: modelo.chave, nome: modelo.nome, origem: modelo.origem, imgsz: modelo.imgsz, tipo: modelo.tipo || 'det', classes: modelo.classes, created_at: modelo.created_at, updated_at: modelo.updated_at, metricas: modelo.metricas } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/linhas/:id/qr.svg', requireAuth, async (req, res) => {
  try {
    const origem = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
    const svg = await QRCode.toString(`${origem}/cadenciador/camera?linha=${Number(req.params.id)}`, { type: 'svg', margin: 1, width: 240 });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' }).send(svg);
  } catch (e) { res.status(500).end(); }
});

/* ───────── Ao vivo ───────── */

router.post('/frame', requireAuth, (req, res) => {
  const { linha_id, contagem, estado, resumo, dispositivo, jpeg, jpeg_limpo, capacidades, produto_id, sessao_id } = req.body || {};
  if (!idOk(linha_id)) return res.status(400).json({ error: 'Linha obrigatória' });
  const buf = b64jpeg(jpeg);
  if (!buf) return res.status(400).json({ error: 'Quadro inválido' });
  if (buf.length > QUADRO_MAX) return res.status(413).json({ error: 'Quadro muito grande' });
  const id = Number(linha_id);
  const ant = QUADROS.get(id) || {};
  QUADROS.set(id, {
    buf, limpo: b64jpeg(jpeg_limpo) || buf, ts: Date.now(), contagem: Number(contagem) || 0,
    estado: String(estado || '').slice(0, 40), resumo: resumo ? String(resumo).slice(0, 80) : null, dispositivo: String(dispositivo || '').slice(0, 120),
    usuario: req.session.nome || req.session.username,
    produto_id: idOk(produto_id) ? Number(produto_id) : null, sessao_id: idOk(sessao_id) ? Number(sessao_id) : null,
    capacidades: capacidades && typeof capacidades === 'object' ? capacidades : (ant.capacidades || null)
  });
  res.json({ ok: true, comandos: (COMANDOS.get(id) || []).length });
});

router.get('/frame/:linha', requireAuth, (req, res) => {
  const q = QUADROS.get(Number(req.params.linha));
  if (!q) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Ts': String(q.ts) });
  res.send(q.buf);
});

/* ───────── Eventos ───────── */

const CLASSES_DET = ['caixa', 'peca', 'pallet'];   // ordem = índice de classe no modelo antigo (retângulos)
const CLASSES_SEG = ['peca', 'pallet'];            // modelo de contorno: caixa conta como peça
/* marcação = { c, x, y, w, h, pts? } — pts é o contorno [[x,y],…] (0–1); o retângulo sai do contorno */
const limparPts = pts => Array.isArray(pts) ? pts.filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])).slice(0, 300).map(p => [Math.min(1, Math.max(0, +(+p[0]).toFixed(4))), Math.min(1, Math.max(0, +(+p[1]).toFixed(4)))]) : [];
const limparMarc = arr => (Array.isArray(arr) ? arr : []).map(c => {
  if (!c) return null;
  const pts = limparPts(c.pts), o = { c: CLASSES_DET.includes(c.c) ? c.c : 'peca' };
  if (pts.length >= 3) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    Object.assign(o, { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), pts });
  } else if (isFinite(c.x) && isFinite(c.y) && isFinite(c.w) && isFinite(c.h)) Object.assign(o, { x: +c.x, y: +c.y, w: +c.w, h: +c.h });
  else return null;
  return o.w > 0.005 && o.h > 0.005 ? o : null;
}).filter(Boolean);
/* linha do rótulo YOLO-seg: classe + polígono (sem contorno → os 4 cantos do retângulo) */
const linhaSeg = c => {
  const pts = (c.pts && c.pts.length >= 3) ? c.pts : [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]];
  return `${c.c === 'pallet' ? 1 : 0} ` + pts.map(p => `${Math.min(1, Math.max(0, p[0])).toFixed(5)} ${Math.min(1, Math.max(0, p[1])).toFixed(5)}`).join(' ');
};
const ORIG = { ia: 1, ia_retirada: -1, manual_mais: 1, manual_menos: -1, troca_pallet: 0, estorno: -1 };   // ia_retirada: caixa tirada do pallet; estorno: a câmera desfez uma contagem

router.post('/eventos', requireAuth, naoPcp, async (req, res) => {
  try {
    const { linha_id, celula, sessao_id, origem, valor, ts, foto, mudanca_pct, dispositivo, detalhe } = req.body || {};
    if (!(origem in ORIG)) return res.status(400).json({ error: 'Origem inválida' });
    let linha = null;
    if (idOk(linha_id)) linha = await carregarLinha(linha_id);
    const cel = linha ? linha.celula : String(celula || '').trim();
    if (!cel) return res.status(400).json({ error: 'Célula obrigatória' });
    let sid = idOk(sessao_id) ? Number(sessao_id) : null;
    if (!sid && linha) { const s = await sessaoDeHoje(linha.produto_id); sid = s ? s.id : null; }
    let v = ORIG[origem];
    if ((origem === 'ia' || origem === 'ia_retirada') && idOk(valor)) v = ORIG[origem] * Math.min(50, Math.max(1, Number(valor)));   // várias caixas de uma vez (ou as que já estavam no pallet ao ligar)
    let fotoBuf = b64jpeg(foto);
    if (fotoBuf && fotoBuf.length > FOTO_MAX) fotoBuf = null;
    const quando = ts && !isNaN(Date.parse(ts)) ? new Date(ts) : new Date();
    const r = await pool.query(
      `INSERT INTO cont_eventos (linha_id, celula, sessao_id, ts, origem, valor, mudanca_pct, foto, dispositivo, usuario_id, detalhe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, ts, valor`,
      [linha ? linha.id : null, cel.slice(0, 80), sid, quando, origem, v,
       mudanca_pct != null && isFinite(Number(mudanca_pct)) ? Number(mudanca_pct) : null, fotoBuf,
       String(dispositivo || '').slice(0, 120), req.session.userId || null, detalhe ? String(detalhe).slice(0, 60) : null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function filtroEventos(q, params, where) {
  if (dataOk(q.data)) { params.push(q.data); where.push(diaLocal('e.ts', params.length)); }
  if (idOk(q.linha_id)) { params.push(Number(q.linha_id)); where.push(`e.linha_id = $${params.length}`); }
  if (q.celula) { params.push(q.celula); where.push(`e.celula = $${params.length}`); }
  if (idOk(q.sessao_id)) { params.push(Number(q.sessao_id)); where.push(`e.sessao_id = $${params.length}`); }
}

router.get('/eventos', requireAuth, async (req, res) => {
  try {
    const where = [], params = [];
    filtroEventos(req.query, params, where);
    const r = await pool.query(
      `SELECT e.id, e.linha_id, e.celula, e.sessao_id, e.ts, e.origem, e.valor, e.mudanca_pct, e.detalhe, (e.foto IS NOT NULL) AS tem_foto, e.dispositivo, u.nome AS usuario_nome
         FROM cont_eventos e LEFT JOIN users u ON u.id = e.usuario_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts, e.id`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/eventos/:id/foto', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).end();
    const r = await pool.query('SELECT foto FROM cont_eventos WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].foto) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(r.rows[0].foto);
  } catch (e) { res.status(500).end(); }
});

router.delete('/eventos/:id', requireAuth, naoPcp, async (req, res) => {
  try {
    await pool.query('DELETE FROM cont_eventos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── Análise de um dia/linha ─────────
   Ciclos previstos (cadenciador) + eventos reais, para o painel montar
   esperado × real, intervalo entre saídas × takt, etc. */
router.get('/analise', requireAuth, async (req, res) => {
  try {
    const data = dataOk(req.query.data) ? req.query.data : hoje();
    const where = [], params = [];
    filtroEventos({ ...req.query, data }, params, where);
    const eventos = (await pool.query(
      `SELECT e.id, e.linha_id, e.celula, e.sessao_id, e.ts, e.origem, e.valor, e.mudanca_pct, e.detalhe, (e.foto IS NOT NULL) AS tem_foto
         FROM cont_eventos e WHERE ${where.join(' AND ')} ORDER BY e.ts, e.id`, params)).rows;
    let sessao = null, ciclos = [], paradas = [];
    let sid = idOk(req.query.sessao_id) ? Number(req.query.sessao_id) : (eventos.find(e => e.sessao_id) || {}).sessao_id;
    if (!sid && idOk(req.query.linha_id) && data === hoje()) { const l = await carregarLinha(req.query.linha_id); const s = l && await sessaoDeHoje(l.produto_id); sid = s ? s.id : null; }
    if (sid) {
      sessao = (await pool.query(
        `SELECT s.id, s.data, s.takt_min::float AS takt_min, s.status, s.tempo_parado_seg, p.nome AS produto_nome, t.nome AS turno_nome,
                t.hora_inicio, t.hora_fim FROM cad_sessoes s JOIN cad_produtos p ON p.id = s.produto_id JOIN turnos t ON t.id = s.turno_id WHERE s.id = $1`, [sid])).rows[0] || null;
      ciclos = (await pool.query('SELECT numero, hora_prevista, concluido FROM cad_ciclos WHERE sessao_id=$1 ORDER BY numero', [sid])).rows;
      paradas = (await pool.query('SELECT inicio, fim, duracao_seg, motivo FROM cad_paradas WHERE sessao_id=$1 ORDER BY inicio', [sid])).rows;
    }
    res.json({ data, sessao, ciclos, paradas, eventos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Dias/linhas com contagem (histórico) */
router.get('/historico', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT to_char((e.ts AT TIME ZONE '${FUSO}')::date, 'YYYY-MM-DD') AS data, e.linha_id, e.celula, e.sessao_id, SUM(e.valor)::int AS contagem,
              COUNT(*) FILTER (WHERE e.origem='ia')::int AS ia, COUNT(*) FILTER (WHERE e.origem='ia_retirada')::int AS retiradas, COUNT(*) FILTER (WHERE e.origem='manual_mais')::int AS mais,
              COUNT(*) FILTER (WHERE e.origem='manual_menos')::int AS menos, COUNT(*) FILTER (WHERE e.origem='estorno')::int AS estornos,
              MIN(e.ts) AS primeiro, MAX(e.ts) AS ultimo,
              s.takt_min::float AS takt_min, p.nome AS produto_nome, t.nome AS turno_nome,
              (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos
         FROM cont_eventos e LEFT JOIN cad_sessoes s ON s.id = e.sessao_id
         LEFT JOIN cad_produtos p ON p.id = s.produto_id LEFT JOIN turnos t ON t.id = s.turno_id
        GROUP BY (e.ts AT TIME ZONE '${FUSO}')::date, e.linha_id, e.celula, e.sessao_id, s.id, s.takt_min, p.nome, t.nome
        ORDER BY (e.ts AT TIME ZONE '${FUSO}')::date DESC, e.celula`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════ IA de detecção: amostras → treino → modelo ═══════════
   O painel captura quadros da câmera e o usuário marca cada caixa/peça.
   O servidor treina (python/treinar.py, YOLOv8n a partir dos pesos Open Images)
   e guarda o ONNX; o aparelho baixa e roda localmente (onnxruntime-web). */

const PY = process.env.PYTHON_BIN || 'python3';
const TREINOS = new Map();   // chave linha:produto -> { estado, progresso, total, log, inicio, fim, erro }
const chaveTreino = (l, p) => `${l}:${p || 0}`;
let pyDisponivel = null;
function verificarPython(cb) {
  if (pyDisponivel && pyDisponivel.ok) return cb(pyDisponivel);   // erro não fica guardado: dá para verificar de novo depois de instalar
  execFile(PY, ['-c', 'import ultralytics, onnx, onnxruntime; print(ultralytics.__version__)'], { timeout: 180000, env: { ...process.env, YOLO_VERBOSE: 'False' } }, (err, out, errOut) => {
    if (!err) { pyDisponivel = { ok: true, versao: String(out).trim().split('\n').pop() }; return cb(pyDisponivel); }
    // o motivo real é a última linha do erro do Python (ex.: "ModuleNotFoundError: No module named 'ultralytics'")
    const linhas = String(errOut || '').split('\n').map(l => l.trim()).filter(Boolean);
    let motivo = linhas.length ? linhas[linhas.length - 1] : (err.code === 'ENOENT' ? `Python não encontrado (${PY})` : String(err.message || '').split('\n')[0]);
    if (/No module named/.test(motivo)) motivo += ' — os pacotes da IA não foram instalados no deploy. No Railway: Deployments › Build Logs, procure "AVISO: treino da IA" ou "IA: treino instalado".';
    pyDisponivel = { ok: false, motivo: motivo.slice(0, 400), python: PY };
    cb(pyDisponivel);
  });
}

router.get('/treino/disponivel', requireAuth, (req, res) => verificarPython(d => res.json(d)));

/* amostras */
router.get('/linhas/:id/amostras', requireAuth, async (req, res) => {
  try {
    const params = [req.params.id]; let where = 'linha_id = $1';
    if (idOk(req.query.produto_id)) { params.push(Number(req.query.produto_id)); where += ' AND produto_id = $2'; }
    const r = await pool.query(`SELECT id, produto_id, largura, altura, caixas, rotulo, created_at, jsonb_array_length(caixas) AS n FROM cont_amostras WHERE ${where} ORDER BY created_at DESC`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/amostras/:id/jpeg', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT jpeg FROM cont_amostras WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).send(r.rows[0].jpeg);
  } catch (e) { res.status(500).end(); }
});
router.post('/linhas/:id/amostras', requireAuth, naoPcp, async (req, res) => {
  try {
    const { produto_id, jpeg, caixas, largura, altura, da_camera, rotulo } = req.body || {};
    let buf = b64jpeg(jpeg);
    if (!buf && da_camera) { const q = QUADROS.get(Number(req.params.id)); buf = q && (q.limpo || q.buf); }   // usa o último quadro ao vivo, sem os desenhos
    if (!buf) return res.status(400).json({ error: 'Sem imagem (a câmera está transmitindo?)' });
    const cx = limparMarc(caixas);
    const r = await pool.query(
      `INSERT INTO cont_amostras (linha_id, produto_id, jpeg, largura, altura, caixas, rotulo, usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [req.params.id, idOk(produto_id) ? Number(produto_id) : null, buf, Number(largura) || 640, Number(altura) || 480, JSON.stringify(cx), ['vazio', 'com_pecas'].includes(rotulo) ? rotulo : null, req.session.userId || null]);
    res.json({ ...r.rows[0], n: cx.length, rotulo: ['vazio', 'com_pecas'].includes(rotulo) ? rotulo : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/amostras/:id', requireAuth, naoPcp, async (req, res) => {
  try {
    const cx = limparMarc(req.body.caixas);
    if ('rotulo' in req.body) await pool.query('UPDATE cont_amostras SET rotulo = $2 WHERE id = $1', [req.params.id, ['vazio', 'com_pecas'].includes(req.body.rotulo) ? req.body.rotulo : null]);
    if (Array.isArray(req.body.caixas)) await pool.query('UPDATE cont_amostras SET caixas = $2 WHERE id = $1', [req.params.id, JSON.stringify(cx)]);
    res.json({ ok: true, n: cx.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/amostras/:id', requireAuth, naoPcp, async (req, res) => {
  try { await pool.query('DELETE FROM cont_amostras WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🪄 sugere retângulos numa amostra: com o modelo treinado da câmera (se houver) ou com a IA genérica */
router.post('/amostras/:id/sugerir', requireAuth, naoPcp, (req, res) => {
  verificarPython(async d => {
    if (!d.ok) return res.status(503).json({ error: 'Sugestão indisponível: o treino da IA não está instalado neste servidor.' });
    let dir = null;
    try {
      const a = (await pool.query('SELECT id, linha_id, produto_id, jpeg FROM cont_amostras WHERE id = $1', [req.params.id])).rows[0];
      if (!a) return res.status(404).json({ error: 'Quadro não encontrado' });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugerir-'));
      const img = path.join(dir, 'q.jpg'); fs.writeFileSync(img, a.jpeg);
      const args = [path.join(__dirname, '..', 'python', 'sugerir.py'), '--imagem', img];
      let fonte = 'IA genérica';
      if (!req.body || !req.body.generica) {
        const m = idOk(req.body && req.body.modelo_id)
          ? (await pool.query(`SELECT ${CAMPOS_MOD} FROM cont_modelos m WHERE m.id = $1`, [req.body.modelo_id])).rows[0]
          : await modeloAtual(a.linha_id, idOk(req.body && req.body.produto_id) ? req.body.produto_id : a.produto_id);
        if (m && ['det', 'seg'].includes(m.tipo || 'det')) {
          const onnx = (await pool.query('SELECT onnx FROM cont_modelos WHERE id = $1', [m.id])).rows[0].onnx;
          const mp = path.join(dir, 'm.onnx'); fs.writeFileSync(mp, onnx);
          args.push('--modelo', mp, '--classes', (m.classes || CLASSES_DET).join(','), '--tipo', m.tipo || 'det');
          fonte = 'IA treinada' + (m.nome ? ' (' + m.nome + ')' : '');
        }
      }
      execFile(PY, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, YOLO_VERBOSE: 'False' } }, (err, stdout) => {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        const linha = String(stdout || '').split('\n').find(l => l.startsWith('SUGESTOES '));
        if (!linha) return res.status(500).json({ error: 'A IA não respondeu' + (err ? ': ' + String(err.message).split('\n')[0] : '') });
        try { res.json({ fonte, caixas: JSON.parse(linha.slice(10)) }); } catch (e) { res.status(500).json({ error: e.message }); }
      });
    } catch (e) { if (dir) fs.rm(dir, { recursive: true, force: true }, () => {}); res.status(500).json({ error: e.message }); }
  });
});

/* modelo treinado (o aparelho baixa) */
/* Qual modelo a câmera usa (nesta ordem):
   1) o modelo escolhido para o produto (cont_modelo_produto);
   2) o modelo PADRÃO da biblioteca (ex.: "Caixa/Pallet", serve para a maioria dos produtos);
   3) compatibilidade: o último modelo treinado nesta câmera (versões antigas, sem nome). */
const CAMPOS_MOD = `m.id, m.nome, m.padrao, m.linha_id, m.produto_id, m.imgsz, m.tipo, m.classes, m.metricas, m.amostras, m.created_at, COALESCE(m.updated_at, m.created_at) AS updated_at, octet_length(m.onnx) AS tamanho`;
const comChave = (m, origem) => m ? { ...m, origem, chave: `${m.id}.${new Date(m.updated_at).getTime()}` } : null;
async function modeloAtual(linhaId, produtoId) {
  const pid = idOk(produtoId) ? Number(produtoId) : null;
  if (pid) {
    const r = await pool.query(`SELECT ${CAMPOS_MOD} FROM cont_modelo_produto mp JOIN cont_modelos m ON m.id = mp.modelo_id WHERE mp.produto_id = $1`, [pid]);
    if (r.rows[0]) return comChave(r.rows[0], 'produto');
  }
  const p = await pool.query(`SELECT ${CAMPOS_MOD} FROM cont_modelos m WHERE m.padrao ORDER BY m.updated_at DESC NULLS LAST LIMIT 1`);
  if (p.rows[0]) return comChave(p.rows[0], 'padrao');
  const r = await pool.query(
    `SELECT ${CAMPOS_MOD} FROM cont_modelos m WHERE m.linha_id = $1 AND (m.produto_id = $2 OR m.produto_id IS NULL)
      ORDER BY (m.produto_id IS NOT NULL) DESC, m.created_at DESC LIMIT 1`, [linhaId, pid]);
  return comChave(r.rows[0], 'camera');
}
router.get('/linhas/:id/modelo', requireAuth, async (req, res) => {
  try {
    const m = await modeloAtual(req.params.id, req.query.produto_id);
    if (!m) return res.status(404).json({ error: 'Sem modelo treinado' });
    if (req.query.info) return res.json(m);
    const r = await pool.query('SELECT onnx FROM cont_modelos WHERE id = $1', [m.id]);
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Modelo-Id': String(m.id), 'X-Imgsz': String(m.imgsz) }).send(r.rows[0].onnx);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/linhas/:id/modelo/:mid', requireAuth, naoPcp, async (req, res) => {
  try { await pool.query('DELETE FROM cont_modelos WHERE id = $1 AND linha_id = $2', [req.params.mid, req.params.id]); await pool.query('UPDATE cont_linhas SET updated_at = NOW() WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───── biblioteca de modelos ───── */
router.get('/modelos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${CAMPOS_MOD}, l.celula AS linha_celula, l.nome AS linha_nome, pr.nome AS produto_nome,
        COALESCE((SELECT json_agg(json_build_object('id', p2.id, 'nome', p2.nome) ORDER BY p2.nome) FROM cont_modelo_produto mp JOIN cad_produtos p2 ON p2.id = mp.produto_id WHERE mp.modelo_id = m.id), '[]') AS produtos
      FROM cont_modelos m LEFT JOIN cont_linhas l ON l.id = m.linha_id LEFT JOIN cad_produtos pr ON pr.id = m.produto_id
      ORDER BY m.padrao DESC, (m.nome IS NULL), m.updated_at DESC NULLS LAST`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/modelos/:id', requireAuth, naoPcp, async (req, res) => {
  try {
    const { nome, padrao } = req.body || {};
    if (nome !== undefined) { if (!String(nome).trim()) return res.status(400).json({ error: 'Nome obrigatório' }); await pool.query('UPDATE cont_modelos SET nome = $2 WHERE id = $1', [req.params.id, String(nome).trim().slice(0, 80)]); }
    if (padrao === true) { await pool.query('UPDATE cont_modelos SET padrao = (id = $1)', [req.params.id]); }
    else if (padrao === false) await pool.query('UPDATE cont_modelos SET padrao = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/modelos/:id', requireAuth, naoPcp, async (req, res) => {
  try { await pool.query('DELETE FROM cont_modelos WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
/* 📤 exportar / 📥 importar modelo — arquivo .iamodelo = 1ª linha JSON (nome, tipo, imgsz, classes, métricas) + bytes do ONNX.
   Serve para levar um modelo treinado num servidor (PC) para outro (Railway), ou guardar uma cópia. */
router.get('/modelos/:id/exportar', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT nome, tipo, imgsz, classes, metricas, amostras, onnx FROM cont_modelos WHERE id = $1', [req.params.id]);
    const m = r.rows[0]; if (!m) return res.status(404).json({ error: 'Modelo não encontrado' });
    const cab = JSON.stringify({ formato: 'iamodelo-1', nome: m.nome, tipo: m.tipo, imgsz: m.imgsz, classes: m.classes, metricas: m.metricas, amostras: m.amostras, exportado_em: new Date().toISOString() });
    const nomeArq = (m.nome || 'modelo').replace(/[^\w\-]+/g, '_').slice(0, 40) + '.iamodelo';
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nomeArq}"` });
    res.send(Buffer.concat([Buffer.from(cab + '\n', 'utf8'), m.onnx]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/modelos/importar', requireAuth, naoPcp, express.raw({ type: '*/*', limit: '120mb' }), async (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length < 100) return res.status(400).json({ error: 'Arquivo vazio' });
    const nl = buf.indexOf(10); let cab = null;
    try { cab = nl > 0 && nl < 4000 ? JSON.parse(buf.slice(0, nl).toString('utf8')) : null; } catch (_) {}
    if (!cab || cab.formato !== 'iamodelo-1') return res.status(400).json({ error: 'Este arquivo não é um modelo exportado (.iamodelo)' });
    const onnx = buf.slice(nl + 1);
    if (onnx.length < 1000) return res.status(400).json({ error: 'Modelo sem conteúdo' });
    const nome = String(req.query.nome || cab.nome || 'Modelo importado').trim().slice(0, 80);
    const temPadrao = (await pool.query('SELECT 1 FROM cont_modelos WHERE padrao LIMIT 1')).rows.length > 0;
    const r = await pool.query('INSERT INTO cont_modelos (linha_id, produto_id, onnx, imgsz, tipo, classes, metricas, amostras, nome, padrao, updated_at) VALUES (NULL,NULL,$1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id',
      [onnx, Number(cab.imgsz) || 416, ['seg', 'det', 'cls'].includes(cab.tipo) ? cab.tipo : 'seg', JSON.stringify(cab.classes || CLASSES_SEG), JSON.stringify(cab.metricas || {}), Number(cab.amostras) || 0, nome, !temPadrao]);
    await pool.query('UPDATE cont_linhas SET updated_at = NOW()');
    res.json({ ok: true, id: r.rows[0].id, nome, padrao: !temPadrao, tamanho: onnx.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* modelo de um produto: { modelo_id } = usa esse; { modelo_id: null } = usa o padrão */
router.get('/produtos/:pid/modelo', requireAuth, async (req, res) => {
  try { const r = await pool.query('SELECT modelo_id FROM cont_modelo_produto WHERE produto_id = $1', [req.params.pid]); res.json({ modelo_id: r.rows[0] ? r.rows[0].modelo_id : null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/produtos/:pid/modelo', requireAuth, naoPcp, async (req, res) => {
  try {
    const mid = idOk(req.body && req.body.modelo_id) ? Number(req.body.modelo_id) : null;
    if (mid) await pool.query(`INSERT INTO cont_modelo_produto (produto_id, modelo_id) VALUES ($1, $2) ON CONFLICT (produto_id) DO UPDATE SET modelo_id = EXCLUDED.modelo_id, updated_at = NOW()`, [req.params.pid, mid]);
    else await pool.query('DELETE FROM cont_modelo_produto WHERE produto_id = $1', [req.params.pid]);
    res.json({ ok: true, modelo_id: mid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* treino (um por vez no servidor) */
let TREINO_ATUAL = null;
router.get('/treino/atual', requireAuth, (req, res) => res.json(TREINO_ATUAL ? { ...TREINO_ATUAL, log: TREINO_ATUAL.log.slice(-12) } : { estado: 'nenhum' }));
router.get('/linhas/:id/treino', requireAuth, (req, res) => {
  const t = TREINOS.get(chaveTreino(req.params.id, req.query.produto_id));
  res.json(t ? { ...t, log: t.log.slice(-12) } : { estado: 'nenhum' });
});
router.post('/linhas/:id/treinar', requireAuth, naoPcp, async (req, res) => {
  const linhaId = Number(req.params.id), produtoId = idOk(req.body && req.body.produto_id) ? Number(req.body.produto_id) : null;
  const chave = chaveTreino(linhaId, produtoId);
  if (TREINO_ATUAL && TREINO_ATUAL.estado === 'rodando') return res.status(409).json({ error: 'Já existe um treino rodando. Aguarde terminar.' });
  // destino: modelo_id = treina de novo (atualiza) um modelo da biblioteca; nome = cria um modelo novo
  const destinoId = idOk(req.body && req.body.modelo_id) ? Number(req.body.modelo_id) : null;
  const nomeNovo = String((req.body && req.body.nome) || '').trim().slice(0, 80);
  verificarPython(async d => {
    if (!d.ok) return res.status(503).json({ error: 'Treino indisponível neste servidor: ' + d.motivo + '. Veja python/README no projeto.' });
    try {
      // todas_cameras: junta os quadros marcados de todas as câmeras (vários ângulos) num modelo só
      const params = [], conds = [];
      if (!req.body.todas_cameras) { params.push(linhaId); conds.push(`linha_id = $${params.length}`); }
      if (produtoId && !req.body.todos_produtos) { params.push(produtoId); conds.push(`produto_id = $${params.length}`); }
      const where = conds.length ? conds.join(' AND ') : 'TRUE';
      const modo = ['cls', 'det'].includes(req.body.modo) ? req.body.modo : 'seg';   // padrão: contorno
      const am = (await pool.query(`SELECT id, jpeg, largura, altura, caixas, rotulo FROM cont_amostras WHERE ${where}`, params)).rows;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treino-'));
      const args = [];
      if (modo === 'seg') {
        // só entram quadros conferidos: pallet vazio (só o pallet) e quadros com peça(s)
        const marcadas = am.filter(a => (a.caixas || []).length);
        const comPeca = marcadas.filter(a => a.caixas.some(c => c.c !== 'pallet')).length, vazios = marcadas.length - comPeca;
        if (comPeca < 3) return res.status(400).json({ error: `Faltam quadros com peça: há ${comPeca} (mínimo 3, ideal 15+). Use o passo 2 (Peça).` });
        if (vazios < 1) return res.status(400).json({ error: 'Falta o pallet vazio: capture pelo menos 1 no passo 1 (ideal 3+).' });
        fs.mkdirSync(path.join(dir, 'images')); fs.mkdirSync(path.join(dir, 'labels'));
        for (const a of marcadas) {
          fs.writeFileSync(path.join(dir, 'images', `a${a.id}.jpg`), a.jpeg);
          fs.writeFileSync(path.join(dir, 'labels', `a${a.id}.txt`), a.caixas.map(linhaSeg).join('\n') + '\n');
        }
        args.push('--classes', CLASSES_SEG.join(','));
        am.length = 0; am.push(...marcadas);
      } else if (modo === 'det') {
        const marcadas = am.filter(a => (a.caixas || []).length);
        if (marcadas.length < 3) return res.status(400).json({ error: `Marque caixas em pelo menos 3 quadros (há ${marcadas.length}). O ideal são 15 ou mais, com a pilha em alturas diferentes.` });
        fs.mkdirSync(path.join(dir, 'images')); fs.mkdirSync(path.join(dir, 'labels'));
        for (const a of am) {
          fs.writeFileSync(path.join(dir, 'images', `a${a.id}.jpg`), a.jpeg);
          fs.writeFileSync(path.join(dir, 'labels', `a${a.id}.txt`), (a.caixas || []).map(c => `${Math.max(0, CLASSES_DET.indexOf(c.c || 'caixa'))} ${(c.x + c.w / 2).toFixed(5)} ${(c.y + c.h / 2).toFixed(5)} ${c.w.toFixed(5)} ${c.h.toFixed(5)}`).join('\n') + '\n');
        }
        args.push('--classes', CLASSES_DET.join(','));
      } else {
        const v = am.filter(a => a.rotulo === 'vazio'), c = am.filter(a => a.rotulo === 'com_pecas');
        if (v.length < 3 || c.length < 3) return res.status(400).json({ error: `Capture pelo menos 3 quadros de pallet VAZIO e 3 COM PEÇAS (há ${v.length} e ${c.length}). O ideal são 10 ou mais de cada.` });
        fs.mkdirSync(path.join(dir, 'vazio')); fs.mkdirSync(path.join(dir, 'com_pecas'));
        for (const a of am) if (a.rotulo) fs.writeFileSync(path.join(dir, a.rotulo, `a${a.id}.jpg`), a.jpeg);
        const l = await carregarLinha(linhaId, produtoId); const z = l && l.config.zona;
        if (z) args.push('--zona', `${z.x},${z.y},${z.w},${z.h}`);
      }
      const saida = path.join(dir, 'modelo.onnx');
      const epocas = Math.min(80, Math.max(5, Number(req.body.epocas) || 40));
      const imgsz = modo === 'cls' ? 224 : ([320, 416, 480, 640].includes(Number(req.body.imgsz)) ? Number(req.body.imgsz) : 416);
      let destinoNome = nomeNovo;
      if (destinoId) { const d0 = (await pool.query('SELECT nome FROM cont_modelos WHERE id = $1', [destinoId])).rows[0]; if (!d0) return res.status(404).json({ error: 'Modelo não encontrado' }); destinoNome = d0.nome || ('Modelo ' + destinoId); }
      if (!destinoNome) destinoNome = 'Caixa/Pallet';
      const t = { estado: 'rodando', progresso: 0, total: epocas, log: [], inicio: Date.now(), fim: null, erro: null, amostras: am.length, modo, modelo_nome: destinoNome, modelo_id: destinoId, linha_id: linhaId };
      TREINOS.set(chave, t); TREINO_ATUAL = t;
      const proc = spawn(PY, [path.join(__dirname, '..', 'python', 'treinar.py'), '--modo', modo, '--dados', dir, '--saida', saida, '--epocas', String(epocas), '--imgsz', String(imgsz), '--batch', '4', ...args], { env: { ...process.env, YOLO_VERBOSE: 'False', OMP_NUM_THREADS: '2' } });
      const ler = (chunk) => String(chunk).split('\n').forEach(l => {
        l = l.trim(); if (!l) return;
        const m = /^PROGRESSO (\d+)\/(\d+)/.exec(l); if (m) { t.progresso = Number(m[1]); t.total = Number(m[2]); }
        const k = /^METRICAS (.+)$/.exec(l); if (k) { try { t.metricas = JSON.parse(k[1]); } catch (_) {} }
        if (/^(PROGRESSO|METRICAS|ERRO|Error|error|Traceback)/.test(l) || l.length < 160) t.log.push(l.slice(0, 200)); if (t.log.length > 60) t.log.shift();
      });
      proc.stdout.on('data', ler); proc.stderr.on('data', ler);
      proc.on('close', async code => {
        t.fim = Date.now();
        try {
          if (code !== 0 || !fs.existsSync(saida)) throw new Error('Treino terminou com erro (código ' + code + '): ' + t.log.filter(l => /ERRO|Error/.test(l)).slice(-2).join(' | '));
          const onnx = fs.readFileSync(saida);
          const classes = modo === 'cls' ? JSON.stringify((t.metricas && t.metricas.classes) || ['com_pecas', 'vazio']) : JSON.stringify(modo === 'seg' ? CLASSES_SEG : CLASSES_DET);
          let id;
          if (destinoId) {   // treinou de novo um modelo da biblioteca: substitui (todos os produtos que usam ele recebem o novo)
            await pool.query('UPDATE cont_modelos SET onnx=$2, imgsz=$3, tipo=$4, classes=$5, metricas=$6, amostras=$7, updated_at=NOW() WHERE id=$1', [destinoId, onnx, imgsz, modo, classes, JSON.stringify(t.metricas || {}), am.length]);
            id = destinoId;
          } else {           // modelo novo; o primeiro com nome vira o padrão
            const temPadrao = (await pool.query('SELECT 1 FROM cont_modelos WHERE padrao LIMIT 1')).rows.length > 0;
            const r = await pool.query('INSERT INTO cont_modelos (linha_id, produto_id, onnx, imgsz, tipo, classes, metricas, amostras, nome, padrao, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id',
              [linhaId, req.body.todos_produtos ? null : produtoId, onnx, imgsz, modo, classes, JSON.stringify(t.metricas || {}), am.length, destinoNome, !temPadrao]);
            id = r.rows[0].id;
          }
          await pool.query('UPDATE cont_linhas SET updated_at = NOW() WHERE id = $1', [linhaId]);
          t.modelo_id = id;
          t.estado = 'concluido'; t.tamanho = onnx.length;
        } catch (e) { t.estado = 'erro'; t.erro = e.message; }
        fs.rm(dir, { recursive: true, force: true }, () => {});
      });
      proc.on('error', e => { t.estado = 'erro'; t.erro = e.message; t.fim = Date.now(); });
      res.json({ ok: true, amostras: am.length, epocas, imgsz, modelo_nome: destinoNome });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

module.exports = router;
