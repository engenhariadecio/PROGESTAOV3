const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// Justificado (atestado, declaração) fica registrado mas não entra no saldo
const TIPOS = ['Crédito', 'Débito', 'Desconto', 'Justificado'];

// ======================== LANCAMENTOS ========================

router.get('/bh-lancamentos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT l.*, c.nome as colab_nome, c.turno as colab_turno
      FROM bh_lancamentos l JOIN colaboradores c ON l.colaborador_id = c.id
      ORDER BY l.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bh-lancamentos', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, tipo, minutos, data, motivo, justificativa } = req.body;
    if (!colaborador_id || !data || !minutos) return res.status(400).json({ error: 'Campos obrigatorios' });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido (Crédito, Débito, Desconto ou Justificado)' });
    const r = await pool.query(
      'INSERT INTO bh_lancamentos (colaborador_id,tipo,minutos,data,motivo,justificativa) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [colaborador_id, tipo, minutos, data, motivo||null, justificativa||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/bh-lancamentos/:id', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, tipo, minutos, data, motivo, justificativa } = req.body;
    if (!colaborador_id || !data || !minutos) return res.status(400).json({ error: 'Campos obrigatorios' });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido (Crédito, Débito, Desconto ou Justificado)' });
    const r = await pool.query(
      `UPDATE bh_lancamentos
         SET colaborador_id=$1, tipo=$2, minutos=$3, data=$4, motivo=$5, justificativa=$6
       WHERE id=$7 RETURNING *`,
      [colaborador_id, tipo, minutos, data, motivo||null, justificativa||null, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bh-lancamentos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM bh_lancamentos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== CONVITES ========================

router.get('/bh-convites', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT cv.*, c.nome as colab_nome FROM bh_convites cv
      JOIN colaboradores c ON cv.colaborador_id = c.id ORDER BY cv.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bh-convites', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, data, data_banco, resposta, obs } = req.body;
    if (!colaborador_id || !data || !data_banco) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO bh_convites (colaborador_id,data,data_banco,resposta,obs) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [colaborador_id, data, data_banco, resposta||'Pendente', obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// >>> NOVO: PUT para AJUSTE/EDIÇÃO de convite <<<
router.put('/bh-convites/:id', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, data, data_banco, resposta, obs } = req.body;
    if (!colaborador_id || !data || !data_banco) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      `UPDATE bh_convites
         SET colaborador_id=$1, data=$2, data_banco=$3, resposta=$4, obs=$5
       WHERE id=$6 RETURNING *`,
      [colaborador_id, data, data_banco, resposta||'Pendente', obs||null, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Convite nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bh-convites/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM bh_convites WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== ATRASOS (mantido no backend, oculto na UI) ========================

router.get('/bh-atrasos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, c.nome as colab_nome FROM bh_atrasos a
      JOIN colaboradores c ON a.colaborador_id = c.id ORDER BY a.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bh-atrasos', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, data, ponto, linha, diff, motivo, obs } = req.body;
    if (!colaborador_id || !data || !ponto || !linha) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO bh_atrasos (colaborador_id,data,ponto,linha,diff,motivo,obs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [colaborador_id, data, ponto, linha, diff||0, motivo||null, obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bh-atrasos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM bh_atrasos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== EVENTOS (mantido no backend, oculto na UI) ========================

router.get('/bh-eventos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, c.nome as colab_nome FROM bh_eventos e
      LEFT JOIN colaboradores c ON e.colaborador_id = c.id ORDER BY e.data DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bh-eventos', requireAuth, async (req, res) => {
  try {
    const { tipo, abrangencia, colaborador_id, data, hora, descricao } = req.body;
    if (!data) return res.status(400).json({ error: 'Data obrigatoria' });
    const r = await pool.query(
      'INSERT INTO bh_eventos (tipo,abrangencia,colaborador_id,data,hora,descricao) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [tipo, abrangencia||null, colaborador_id||null, data, hora||null, descricao||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bh-eventos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM bh_eventos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
