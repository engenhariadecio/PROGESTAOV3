const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ======================== ADVERTÊNCIAS ========================
const TIPOS_ADV = ['Verbal', 'Escrita', 'Suspensão'];

const SELECT_ADV = `
  SELECT a.id, a.colaborador_id, COALESCE(c.nome, a.colaborador_nome) AS colab_nome, a.colaborador_nome,
         to_char(a.data, 'YYYY-MM-DD') AS data, a.tipo, a.dias_suspensao, a.motivo, a.descricao,
         a.aplicada_por, a.testemunhas, a.assinou, a.obs, a.created_at, u.nome AS registrado_por_nome
    FROM tr_advertencias a
    LEFT JOIN colaboradores c ON c.id = a.colaborador_id
    LEFT JOIN users u ON u.id = a.registrado_por`;

router.get('/tr-advertencias', requireAuth, async (req, res) => {
  try { res.json((await pool.query(SELECT_ADV + ' ORDER BY a.data DESC, a.id DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-advertencias', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    if (!/^\d+$/.test(String(b.colaborador_id || ''))) return res.status(400).json({ error: 'Colaborador obrigatório' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.data || ''))) return res.status(400).json({ error: 'Data obrigatória' });
    const motivo = (b.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Motivo obrigatório' });
    const tipo = TIPOS_ADV.includes(b.tipo) ? b.tipo : 'Verbal';
    const dias = tipo === 'Suspensão' && Number.isInteger(Number(b.dias_suspensao)) && Number(b.dias_suspensao) > 0 ? Number(b.dias_suspensao) : null;

    const colab = await pool.query('SELECT nome FROM colaboradores WHERE id=$1', [b.colaborador_id]);
    if (!colab.rows.length) return res.status(404).json({ error: 'Colaborador não encontrado' });
    // quem aplicou: o informado, senão o usuário logado
    let aplicada = (b.aplicada_por || '').trim();
    if (!aplicada) {
      const u = await pool.query('SELECT nome, username FROM users WHERE id=$1', [req.session.userId]);
      aplicada = u.rows[0] ? (u.rows[0].nome || u.rows[0].username) : null;
    }
    const assinou = b.assinou === true || b.assinou === 'true' ? true : b.assinou === false || b.assinou === 'false' ? false : null;

    const r = await pool.query(
      `INSERT INTO tr_advertencias (colaborador_id, colaborador_nome, data, tipo, dias_suspensao, motivo, descricao,
                                    aplicada_por, testemunhas, assinou, obs, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.colaborador_id, colab.rows[0].nome, b.data, tipo, dias, motivo, (b.descricao || '').trim() || null,
       aplicada, (b.testemunhas || '').trim() || null, assinou, (b.obs || '').trim() || null, req.session.userId || null]
    );
    res.json((await pool.query(SELECT_ADV + ' WHERE a.id=$1', [r.rows[0].id])).rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/tr-advertencias/:id', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.data || ''))) return res.status(400).json({ error: 'Data obrigatória' });
    const motivo = (b.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Motivo obrigatório' });
    const tipo = TIPOS_ADV.includes(b.tipo) ? b.tipo : 'Verbal';
    const dias = tipo === 'Suspensão' && Number.isInteger(Number(b.dias_suspensao)) && Number(b.dias_suspensao) > 0 ? Number(b.dias_suspensao) : null;
    const assinou = b.assinou === true || b.assinou === 'true' ? true : b.assinou === false || b.assinou === 'false' ? false : null;
    const r = await pool.query(
      `UPDATE tr_advertencias SET data=$1, tipo=$2, dias_suspensao=$3, motivo=$4, descricao=$5, aplicada_por=$6,
              testemunhas=$7, assinou=$8, obs=$9 WHERE id=$10 RETURNING id`,
      [b.data, tipo, dias, motivo, (b.descricao || '').trim() || null, (b.aplicada_por || '').trim() || null,
       (b.testemunhas || '').trim() || null, assinou, (b.obs || '').trim() || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrada' });
    res.json((await pool.query(SELECT_ADV + ' WHERE a.id=$1', [req.params.id])).rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-advertencias/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tr_advertencias WHERE id=$1', [req.params.id]);   // fotos vão pelo gatilho
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== TREINAMENTOS CRUD ========================

router.get('/treinamentos', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM treinamentos ORDER BY nome')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/treinamentos', requireAuth, async (req, res) => {
  try {
    const { nome, categoria, carga_horaria, validade_meses, descricao } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
    const r = await pool.query(
      'INSERT INTO treinamentos (nome,categoria,carga_horaria,validade_meses,descricao) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome, categoria||null, carga_horaria||0, validade_meses||0, descricao||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/treinamentos/:id', requireAuth, async (req, res) => {
  try {
    const { nome, categoria, carga_horaria, validade_meses, descricao } = req.body;
    const r = await pool.query(
      'UPDATE treinamentos SET nome=$1,categoria=$2,carga_horaria=$3,validade_meses=$4,descricao=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [nome, categoria, carga_horaria, validade_meses, descricao, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/treinamentos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM treinamentos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== REGISTROS ========================

router.get('/tr-registros', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, c.nome as colab_nome, t.nome as treino_nome, t.validade_meses
      FROM tr_registros r
      JOIN colaboradores c ON r.colaborador_id = c.id
      JOIN treinamentos t ON r.treinamento_id = t.id
      ORDER BY r.data DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-registros', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, treinamento_id, data, validade, instrutor, local_treino, obs, presenca_id } = req.body;
    if (!colaborador_id || !treinamento_id || !data) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO tr_registros (colaborador_id,treinamento_id,data,validade,instrutor,local_treino,obs,presenca_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [colaborador_id, treinamento_id, data, validade||null, instrutor||null, local_treino||null, obs||null, presenca_id||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-registros/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM tr_registros WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== PRESENCAS ========================

router.get('/tr-presencas', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, t.nome as treino_nome FROM tr_presencas p
      JOIN treinamentos t ON p.treinamento_id = t.id ORDER BY p.data DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-presencas', requireAuth, async (req, res) => {
  try {
    const { treinamento_id, data, instrutor, local_treino, lista } = req.body;
    if (!treinamento_id || !data) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO tr_presencas (treinamento_id,data,instrutor,local_treino,lista) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [treinamento_id, data, instrutor||null, local_treino||null, JSON.stringify(lista||[])]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-presencas/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tr_registros WHERE presenca_id=$1', [req.params.id]);
    await pool.query('DELETE FROM tr_presencas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== AGENDA ========================

router.get('/tr-agenda', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, t.nome as treino_nome FROM tr_agenda a
      JOIN treinamentos t ON a.treinamento_id = t.id ORDER BY a.data
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-agenda', requireAuth, async (req, res) => {
  try {
    const { treinamento_id, data, hora, local_treino, obs } = req.body;
    if (!treinamento_id || !data) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO tr_agenda (treinamento_id,data,hora,local_treino,obs) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [treinamento_id, data, hora||null, local_treino||null, obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-agenda/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM tr_agenda WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
