const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ======================== ATIVIDADES ========================

router.get('/cl-atividades', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM cl_atividades ORDER BY horario ASC NULLS LAST, nome ASC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cl-atividades', requireAuth, async (req, res) => {
  try {
    const { nome, freq, inicio, status, descricao, horario, horario2 } = req.body;
    if (!nome || !freq || !inicio) return res.status(400).json({ error: 'Nome, frequencia e inicio obrigatorios' });
    const r = await pool.query(
      'INSERT INTO cl_atividades (nome,freq,inicio,status,descricao,horario,horario2) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [nome, freq, inicio, status||'Ativa', descricao||null, horario||null, horario2||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/cl-atividades/:id', requireAuth, async (req, res) => {
  try {
    const { nome, freq, inicio, status, descricao, horario, horario2 } = req.body;
    const r = await pool.query(
      'UPDATE cl_atividades SET nome=$1,freq=$2,inicio=$3,status=$4,descricao=$5,horario=$6,horario2=$7,updated_at=NOW() WHERE id=$8 RETURNING *',
      [nome, freq, inicio, status, descricao, horario||null, horario2||null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cl-atividades/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cl_execucoes WHERE atividade_id=$1', [req.params.id]);
    await pool.query('DELETE FROM cl_atividades WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== EXECUCOES ========================

router.get('/cl-execucoes', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, a.nome as ativ_nome, a.freq as ativ_freq
      FROM cl_execucoes e JOIN cl_atividades a ON e.atividade_id = a.id
      ORDER BY e.data DESC, e.hora DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cl-execucoes', requireAuth, async (req, res) => {
  try {
    const { atividade_id, data, hora } = req.body;
    if (!atividade_id || !data) return res.status(400).json({ error: 'Atividade e data obrigatorios' });
    const r = await pool.query(
      'INSERT INTO cl_execucoes (atividade_id,data,hora) VALUES ($1,$2,$3) RETURNING *',
      [atividade_id, data, hora||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cl-execucoes/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM cl_execucoes WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cl-execucoes/desfazer/:ativId/:data', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cl_execucoes WHERE atividade_id=$1 AND data=$2', [req.params.ativId, req.params.data]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cl-execucoes/desfazer-um/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cl_execucoes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
