const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { listarTurnos, detectarTurno } = require('../lib/turnos');

const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
const normHora = h => (HORA_RE.test(h || '') ? (h.length === 5 ? h + ':00' : h) : null);

/* ═════════════ TURNOS ═════════════ */

/* GET /api/config/turnos?ativos=1 */
router.get('/turnos', requireAuth, async (req, res) => {
  try {
    res.json(await listarTurnos({ apenasAtivos: req.query.ativos === '1' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/config/turnos/atual — qual turno cobre o horário informado (ou agora) */
router.get('/turnos/atual', requireAuth, async (req, res) => {
  try {
    const hora = normHora(req.query.hora) || new Date().toTimeString().slice(0, 8);
    const turno = await detectarTurno(hora);
    res.json({ hora, turno });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/config/turnos */
router.post('/turnos', requireAdmin, async (req, res) => {
  try {
    const { codigo, nome, hora_inicio, hora_fim, cruza_meia_noite, tolerancia_min, ordem, ativo } = req.body;
    if (!codigo || !nome) return res.status(400).json({ error: 'Código e nome são obrigatórios' });

    const ini = normHora(hora_inicio), fim = normHora(hora_fim);
    if (!ini || !fim) return res.status(400).json({ error: 'Horários devem estar no formato HH:MM' });

    const r = await pool.query(
      `INSERT INTO turnos (codigo,nome,hora_inicio,hora_fim,cruza_meia_noite,tolerancia_min,ordem,ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [codigo.trim().toUpperCase(), nome.trim(), ini, fim,
       !!cruza_meia_noite, tolerancia_min ?? 5, ordem ?? 0, ativo !== false]
    );
    res.json({ ...r.rows[0], intervalos: [] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe um turno com esse código' });
    res.status(500).json({ error: e.message });
  }
});

/* PUT /api/config/turnos/:id */
router.put('/turnos/:id', requireAdmin, async (req, res) => {
  try {
    const { codigo, nome, hora_inicio, hora_fim, cruza_meia_noite, tolerancia_min, ordem, ativo } = req.body;
    const ini = hora_inicio ? normHora(hora_inicio) : null;
    const fim = hora_fim ? normHora(hora_fim) : null;
    if (hora_inicio && !ini) return res.status(400).json({ error: 'Hora de início inválida' });
    if (hora_fim && !fim) return res.status(400).json({ error: 'Hora de fim inválida' });

    const r = await pool.query(
      `UPDATE turnos SET
         codigo=COALESCE($1,codigo), nome=COALESCE($2,nome),
         hora_inicio=COALESCE($3,hora_inicio), hora_fim=COALESCE($4,hora_fim),
         cruza_meia_noite=COALESCE($5,cruza_meia_noite),
         tolerancia_min=COALESCE($6,tolerancia_min),
         ordem=COALESCE($7,ordem), ativo=COALESCE($8,ativo), updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [codigo ? codigo.trim().toUpperCase() : null, nome || null, ini, fim,
       typeof cruza_meia_noite === 'boolean' ? cruza_meia_noite : null,
       tolerancia_min ?? null, ordem ?? null,
       typeof ativo === 'boolean' ? ativo : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Turno não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* DELETE /api/config/turnos/:id */
router.delete('/turnos/:id', requireAdmin, async (req, res) => {
  try {
    const uso = await pool.query('SELECT COUNT(*)::int n FROM cad_sessoes WHERE turno_id=$1', [req.params.id]);
    if (uso.rows[0].n > 0) {
      return res.status(409).json({
        error: 'Este turno já tem sessões de produção registradas. Desative-o em vez de excluir.'
      });
    }
    await pool.query('DELETE FROM turnos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ INTERVALOS DO TURNO ═════════════ */

router.post('/turnos/:id/intervalos', requireAdmin, async (req, res) => {
  try {
    const { nome, hora_inicio, hora_fim, aviso_voz } = req.body;
    const ini = normHora(hora_inicio), fim = normHora(hora_fim);
    if (!nome) return res.status(400).json({ error: 'Nome do intervalo é obrigatório' });
    if (!ini || !fim) return res.status(400).json({ error: 'Horários devem estar no formato HH:MM' });

    const r = await pool.query(
      `INSERT INTO turno_intervalos (turno_id,nome,hora_inicio,hora_fim,aviso_voz)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, nome.trim(), ini, fim, aviso_voz || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/intervalos/:id', requireAdmin, async (req, res) => {
  try {
    const { nome, hora_inicio, hora_fim, aviso_voz, ativo } = req.body;
    const r = await pool.query(
      `UPDATE turno_intervalos SET
         nome=COALESCE($1,nome),
         hora_inicio=COALESCE($2,hora_inicio),
         hora_fim=COALESCE($3,hora_fim),
         aviso_voz=COALESCE($4,aviso_voz),
         ativo=COALESCE($5,ativo)
       WHERE id=$6 RETURNING *`,
      [nome || null, hora_inicio ? normHora(hora_inicio) : null, hora_fim ? normHora(hora_fim) : null,
       aviso_voz ?? null, typeof ativo === 'boolean' ? ativo : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Intervalo não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/intervalos/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM turno_intervalos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ CÉLULAS ═════════════ */

router.get('/celulas', requireAuth, async (_req, res) => {
  try {
    res.json((await pool.query('SELECT * FROM celulas ORDER BY nome')).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/celulas', requireAdmin, async (req, res) => {
  try {
    const { nome, descricao, categoria, operadores, horas_operador } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
    const r = await pool.query(
      'INSERT INTO celulas (nome,descricao,categoria,operadores,horas_operador) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome.trim(), descricao || null, categoria || null, Math.max(0, parseInt(operadores) || 0), parseFloat(horas_operador) > 0 ? parseFloat(horas_operador) : 7]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma célula com esse nome' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/celulas/:id', requireAdmin, async (req, res) => {
  try {
    const { nome, descricao, ativa, categoria, operadores, horas_operador } = req.body;
    const r = await pool.query(
      `UPDATE celulas SET nome=COALESCE($1,nome), descricao=COALESCE($2,descricao),
       ativa=COALESCE($3,ativa), categoria=COALESCE($4,categoria), operadores=COALESCE($5,operadores),
       horas_operador=COALESCE($6,horas_operador) WHERE id=$7 RETURNING *`,
      [nome || null, descricao ?? null, typeof ativa === 'boolean' ? ativa : null, categoria ?? null,
       operadores === undefined ? null : Math.max(0, parseInt(operadores) || 0),
       parseFloat(horas_operador) > 0 ? parseFloat(horas_operador) : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Célula não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/celulas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM celulas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ PARÂMETROS GERAIS ═════════════ */

router.get('/parametros', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query('SELECT chave,valor,descricao FROM app_config ORDER BY chave');
    const mapa = {};
    r.rows.forEach(x => { mapa[x.chave] = x.valor; });
    res.json({ mapa, lista: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/parametros', requireAdmin, async (req, res) => {
  try {
    const entradas = Object.entries(req.body || {});
    if (!entradas.length) return res.status(400).json({ error: 'Nenhum parâmetro enviado' });

    for (const [chave, valor] of entradas) {
      await pool.query(
        `INSERT INTO app_config (chave,valor,updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
        [chave, String(valor)]
      );
    }
    res.json({ success: true, atualizados: entradas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
