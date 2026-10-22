const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ======================== EPIs CRUD ========================

router.get('/', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM epis ORDER BY nome')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM epis WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    // Fotos ficam na tabela `fotos` (rota /api/fotos/epi/:id), não mais aqui
    const { nome, dur_qtd, dur_tipo, descricao, descartavel } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
    const r = await pool.query(
      'INSERT INTO epis (nome,dur_qtd,dur_tipo,descricao,descartavel) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome, dur_qtd||null, dur_tipo||null, descricao||null, descartavel === true]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { nome, dur_qtd, dur_tipo, descricao, descartavel } = req.body;
    const r = await pool.query(
      'UPDATE epis SET nome=$1,dur_qtd=$2,dur_tipo=$3,descricao=$4,descartavel=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [nome, dur_qtd, dur_tipo, descricao, descartavel === true, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM epis WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== ENTREGAS ========================

router.get('/entregas/todos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT ee.*, ep.nome as epi_nome, ep.dur_qtd, ep.dur_tipo, c.nome as colab_nome
      FROM epi_entregas ee
      JOIN epis ep ON ee.epi_id = ep.id
      JOIN colaboradores c ON ee.colaborador_id = c.id
      ORDER BY ee.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/entregas', requireAuth, async (req, res) => {
  try {
    const { epi_id, colaborador_id, qtd, dt, validade, motivo, obs } = req.body;
    if (!epi_id || !colaborador_id || !dt) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO epi_entregas (epi_id,colaborador_id,qtd,dt,validade,motivo,obs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [epi_id, colaborador_id, qtd||1, dt, validade||null, motivo||null, obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/entregas/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM epi_entregas WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== CHECKLISTS EPI ========================

router.get('/checklists/todos', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM epi_checklists ORDER BY data DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/checklists', requireAuth, async (req, res) => {
  try {
    const { data, turno, total, conformes, irregulares, pct, registros } = req.body;
    const r = await pool.query(
      'INSERT INTO epi_checklists (data,turno,total,conformes,irregulares,pct,registros) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [data, turno, total||0, conformes||0, irregulares||0, pct||0, JSON.stringify(registros||[])]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/checklists/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM epi_checklists WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
