const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ==================== SETORES ====================

// Listar todos os setores
router.get('/db-setores', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM db_setores ORDER BY nome');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Criar setor (ignora duplicata)
router.post('/db-setores', requireAuth, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
    const r = await pool.query(
      'INSERT INTO db_setores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING RETURNING *',
      [nome.trim()]
    );
    if (r.rows.length === 0) {
      const existing = await pool.query('SELECT * FROM db_setores WHERE nome=$1', [nome.trim()]);
      return res.json(existing.rows[0]);
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir setor
router.delete('/db-setores/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM db_setores WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== REGISTROS ====================

router.get('/db-registros', requireAuth, async (req, res) => {
  try {
    // Sem as colunas antigas foto/fotos: as imagens agora ficam na tabela `fotos`
    const r = await pool.query(
      `SELECT id, tipo, data, hora, turno, categoria, prioridade, status, descricao, acao,
              envolvidos, previsao_conclusao, created_at, updated_at
         FROM db_registros ORDER BY data DESC, hora DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/db-registros', requireAuth, async (req, res) => {
  try {
    // Fotos são enviadas à parte, em /api/fotos/diario/:id
    const { tipo, data, hora, turno, categoria, prioridade, status, descricao, acao, envolvidos, previsao_conclusao } = req.body;
    if (!data || !descricao) return res.status(400).json({ error: 'Data e descricao obrigatorios' });

    const tipoFinal = (tipo === 'ocorrencia') ? 'ocorrencia' : 'pendencia';
    // Ocorrência não usa prioridade, status nem previsão
    const pri  = tipoFinal === 'ocorrencia' ? null : (prioridade || 'Baixa');
    const st   = tipoFinal === 'ocorrencia' ? null : (status || 'Pendente');
    const prev = tipoFinal === 'ocorrencia' ? null : (previsao_conclusao || null);

    const r = await pool.query(
      `INSERT INTO db_registros
        (tipo, data, hora, turno, categoria, prioridade, status, descricao, acao, envolvidos, previsao_conclusao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tipoFinal, data, hora || null, turno || null, categoria || null, pri, st,
       descricao, acao || null, JSON.stringify(envolvidos || []), prev]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/db-registros/:id', requireAuth, async (req, res) => {
  try {
    const { tipo, data, hora, turno, categoria, prioridade, status, descricao, acao, envolvidos, previsao_conclusao } = req.body;
    if (!data || !descricao) return res.status(400).json({ error: 'Data e descricao obrigatorios' });

    const tipoFinal = (tipo === 'ocorrencia') ? 'ocorrencia' : 'pendencia';
    const pri  = tipoFinal === 'ocorrencia' ? null : (prioridade || 'Baixa');
    const st   = tipoFinal === 'ocorrencia' ? null : (status || 'Pendente');
    const prev = tipoFinal === 'ocorrencia' ? null : (previsao_conclusao || null);

    const r = await pool.query(
      `UPDATE db_registros SET
         tipo=$1, data=$2, hora=$3, turno=$4, categoria=$5, prioridade=$6, status=$7,
         descricao=$8, acao=$9, envolvidos=$10, previsao_conclusao=$11,
         updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [tipoFinal, data, hora || null, turno || null, categoria || null, pri, st,
       descricao, acao || null, JSON.stringify(envolvidos || []), prev, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/db-registros/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM db_registros WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== RESUMOS ====================

router.get('/db-resumos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM db_resumos ORDER BY data DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/db-resumos', requireAuth, async (req, res) => {
  try {
    const { data, turno, texto, obs } = req.body;
    if (!data || !texto) return res.status(400).json({ error: 'Data e texto obrigatorios' });
    const r = await pool.query(
      'INSERT INTO db_resumos (data,turno,texto,obs) VALUES ($1,$2,$3,$4) RETURNING *',
      [data, turno || null, texto, obs || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/db-resumos/:id', requireAuth, async (req, res) => {
  try {
    const { data, turno, texto, obs } = req.body;
    if (!data || !texto) return res.status(400).json({ error: 'Data e texto obrigatorios' });
    const r = await pool.query(
      'UPDATE db_resumos SET data=$1, turno=$2, texto=$3, obs=$4, updated_at=NOW() WHERE id=$5 RETURNING *',
      [data, turno || null, texto, obs || null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/db-resumos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM db_resumos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
