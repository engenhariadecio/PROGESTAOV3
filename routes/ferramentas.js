const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/*
 * A tela de ferramentas usa nomes longos (codigo, categoria, localizacao,
 * calibracao_venc...) e o banco usa os curtos (cod, cat, loc, cal...).
 * As rotas aceitam os dois e devolvem os dois, para a tela e o Excel funcionarem.
 */
const SELECT_FERR = `SELECT id, nome, cod, cat, loc, status, cal, prev, obs, created_at, updated_at,
  cod AS codigo, cat AS categoria, loc AS localizacao, cal AS calibracao_venc, prev AS preventiva_venc
  FROM ferramentas`;

function camposFerramenta(b) {
  const v = (curto, longo) => (b[curto] !== undefined ? b[curto] : b[longo]);
  return {
    nome: b.nome,
    cod:  v('cod', 'codigo'),
    cat:  v('cat', 'categoria'),
    loc:  v('loc', 'localizacao'),
    status: b.status,
    cal:  v('cal', 'calibracao_venc'),
    prev: v('prev', 'preventiva_venc'),
    obs:  b.obs
  };
}

// ======================== CHECKLISTS (conferências salvas) ========================
/*
 * GET    /api/ferramentas/checklists          histórico (cabeçalhos com totais)
 * GET    /api/ferramentas/checklists/:id      cabeçalho + itens
 * POST   /api/ferramentas/checklists          { data, hora, turno, obs, itens: [{ ferramenta_id, situacao, obs }] }
 * DELETE /api/ferramentas/checklists/:id
 *
 * Ficam antes das rotas /:id para não serem capturadas por elas.
 * Cada item guarda uma cópia do código/nome/status da ferramenta naquele
 * momento: se ela for renomeada ou excluída depois, o histórico continua legível.
 */
const SITUACOES = ['ok', 'problema', 'nao_encontrada', 'pendente'];

router.get('/checklists', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ferr_checklists ORDER BY data DESC, hora DESC, id DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/checklists/:id', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const cab = await pool.query('SELECT * FROM ferr_checklists WHERE id=$1', [req.params.id]);
    if (!cab.rows.length) return res.status(404).json({ error: 'Checklist não encontrado' });
    const itens = await pool.query(
      'SELECT * FROM ferr_checklist_itens WHERE checklist_id=$1 ORDER BY cod, nome, id',
      [req.params.id]
    );
    res.json({ ...cab.rows[0], itens: itens.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/checklists', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { data, hora, turno, obs } = req.body;
    const itens = Array.isArray(req.body.itens) ? req.body.itens : [];
    if (!data) return res.status(400).json({ error: 'Data obrigatória' });
    if (!itens.length) return res.status(400).json({ error: 'Checklist sem ferramentas' });

    // Situação vem da tela; o resto (código, nome, status) vem do cadastro atual
    const ids = [...new Set(itens.map(i => Number(i.ferramenta_id)).filter(n => Number.isInteger(n) && n > 0))];
    const ferr = await client.query('SELECT id, cod, nome, cat, loc, status FROM ferramentas WHERE id = ANY($1)', [ids]);
    const porId = new Map(ferr.rows.map(f => [f.id, f]));

    // Uma linha por ferramenta; se vier repetida, vale a última
    const porFerr = new Map();
    for (const it of itens) {
      const f = porId.get(Number(it.ferramenta_id));
      if (!f) continue;
      const sit = SITUACOES.includes(it.situacao) ? it.situacao : 'pendente';
      porFerr.set(f.id, [f.id, f.cod, f.nome, f.cat, f.loc, f.status, sit, (it.obs || '').trim() || null]);
    }
    const linhas = [...porFerr.values()];
    const cont = { ok: 0, problema: 0, nao_encontrada: 0, pendente: 0 };
    linhas.forEach(l => cont[l[6]]++);
    if (!linhas.length) return res.status(400).json({ error: 'Nenhuma ferramenta válida no checklist' });
    if (cont.pendente === linhas.length) return res.status(400).json({ error: 'Marque pelo menos uma ferramenta antes de salvar' });

    const usuario = await client.query('SELECT nome, username FROM users WHERE id=$1', [req.session.userId]);
    const respNome = usuario.rows[0] ? (usuario.rows[0].nome || usuario.rows[0].username) : null;

    await client.query('BEGIN');
    const cab = await client.query(
      `INSERT INTO ferr_checklists (data, hora, turno, responsavel_id, responsavel_nome, obs, total, ok, problema, nao_encontrada, pendente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [data, hora || new Date().toTimeString().slice(0, 8), turno || null, req.session.userId || null, respNome,
       (obs || '').trim() || null, linhas.length, cont.ok, cont.problema, cont.nao_encontrada, cont.pendente]
    );
    const cid = cab.rows[0].id;
    for (const l of linhas) {
      await client.query(
        `INSERT INTO ferr_checklist_itens (checklist_id, ferramenta_id, cod, nome, cat, loc, status_ferr, situacao, obs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [cid, ...l]
      );
    }
    await client.query('COMMIT');
    res.json(cab.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.delete('/checklists/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ferr_checklists WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== FERRAMENTAS CRUD ========================

// GET /api/ferramentas
router.get('/', requireAuth, async (req, res) => {
  try { res.json((await pool.query(SELECT_FERR + ' ORDER BY nome')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ferramentas/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(SELECT_FERR + ' WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nome, cod, cat, loc, status, cal, prev, obs } = camposFerramenta(req.body);
    if (!nome || !cod) return res.status(400).json({ error: 'Nome e codigo obrigatorios' });
    const r = await pool.query(
      'INSERT INTO ferramentas (nome,cod,cat,loc,status,cal,prev,obs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nome, cod, cat||null, loc||null, status||'Disponível', cal||null, prev||null, obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { nome, cod, cat, loc, status, cal, prev, obs } = camposFerramenta(req.body);
    if (!nome || !cod) return res.status(400).json({ error: 'Nome e codigo obrigatorios' });
    const r = await pool.query(
      'UPDATE ferramentas SET nome=$1,cod=$2,cat=$3,loc=$4,status=$5,cal=$6,prev=$7,obs=$8,updated_at=NOW() WHERE id=$9 RETURNING *',
      [nome, cod, cat||null, loc||null, status||'Disponível', cal||null, prev||null, obs||null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ferramentas/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ferramentas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== EMPRESTIMOS ========================

// GET /api/ferramentas/emprestimos/todos
router.get('/emprestimos/todos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as colab_nome,
             e.dt AS retirado_em, e.dev_dt AS devolvido_em
      FROM emprestimos e
      JOIN ferramentas f ON e.ferramenta_id = f.id
      JOIN colaboradores c ON e.colaborador_id = c.id
      ORDER BY e.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas/emprestimos
router.post('/emprestimos', requireAuth, async (req, res) => {
  try {
    const { ferramenta_id, colaborador_id, obs } = req.body;
    const dt = req.body.dt || req.body.retirado_em;
    if (!ferramenta_id || !colaborador_id || !dt) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO emprestimos (ferramenta_id,colaborador_id,dt,obs) VALUES ($1,$2,$3,$4) RETURNING *',
      [ferramenta_id, colaborador_id, dt, obs||null]
    );
    await pool.query('UPDATE ferramentas SET status=$1 WHERE id=$2', ['Em Uso', ferramenta_id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/emprestimos/:id/devolver
router.put('/emprestimos/:id/devolver', requireAuth, async (req, res) => {
  try {
    const dev_dt = req.body.dev_dt || req.body.devolvido_em || new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      'UPDATE emprestimos SET dev_dt=$1, devolvido=TRUE WHERE id=$2 RETURNING *',
      [dev_dt, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    const emp = r.rows[0];
    const pend = await pool.query(
      'SELECT COUNT(*) FROM emprestimos WHERE ferramenta_id=$1 AND devolvido=FALSE',
      [emp.ferramenta_id]
    );
    if (parseInt(pend.rows[0].count) === 0) {
      await pool.query('UPDATE ferramentas SET status=$1 WHERE id=$2', ['Disponível', emp.ferramenta_id]);
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ferramentas/emprestimos/:id
router.delete('/emprestimos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM emprestimos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== MANUTENCOES ========================

// GET /api/ferramentas/manutencoes/todos
router.get('/manutencoes/todos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as resp_nome, c.nome as colab_nome,
             m.env AS dt_envio, m.ret AS dt_retorno
      FROM manutencoes m
      JOIN ferramentas f ON m.ferramenta_id = f.id
      LEFT JOIN colaboradores c ON m.responsavel_id = c.id
      ORDER BY m.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas/manutencoes
router.post('/manutencoes', requireAuth, async (req, res) => {
  try {
    const { ferramenta_id, tipo, responsavel_id, descricao } = req.body;
    const env = req.body.env || req.body.dt_envio;
    const ret = req.body.ret || req.body.dt_retorno;
    if (!ferramenta_id || !env || !descricao) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO manutencoes (ferramenta_id,tipo,responsavel_id,env,ret,descricao) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [ferramenta_id, tipo, responsavel_id||null, env, ret||null, descricao]
    );
    if (!ret) await pool.query('UPDATE ferramentas SET status=$1 WHERE id=$2', ['Manutenção', ferramenta_id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/manutencoes/:id
router.put('/manutencoes/:id', requireAuth, async (req, res) => {
  try {
    // A tela manda só { dt_retorno } ao registrar o retorno: o que não veio é mantido
    const b = req.body;
    const env = b.env !== undefined ? b.env : b.dt_envio;
    const ret = b.ret !== undefined ? b.ret : b.dt_retorno;
    const r = await pool.query(
      `UPDATE manutencoes SET
         tipo = COALESCE($1, tipo),
         responsavel_id = CASE WHEN $2::text IS NULL THEN responsavel_id ELSE NULLIF($2::text, '')::int END,
         env = COALESCE($3, env),
         ret = CASE WHEN $4::text IS NULL THEN ret ELSE NULLIF($4::text, '')::date END,
         descricao = COALESCE($5, descricao),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [b.tipo ?? null, b.responsavel_id === undefined ? null : String(b.responsavel_id ?? ''),
       env || null, ret === undefined ? null : String(ret ?? ''), b.descricao ?? null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    // Voltou da manutenção: libera a ferramenta
    if (r.rows[0].ret) {
      await pool.query(
        "UPDATE ferramentas SET status='Disponível' WHERE id=$1 AND status='Manutenção'",
        [r.rows[0].ferramenta_id]
      );
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ferramentas/manutencoes/:id
router.delete('/manutencoes/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM manutencoes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
