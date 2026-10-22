const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * Aniversários dos próximos N dias.
 * A versão anterior usava HAVING sem GROUP BY — inválido no Postgres.
 * Aqui o cálculo vira subquery e o filtro vira WHERE.
 */
function sqlAniversarios(campo, rotuloIdade) {
  return `
    SELECT * FROM (
      SELECT id, nome, mat, cargo, setor, turno, status, ${campo},
        (
          CASE
            WHEN to_date(to_char(CURRENT_DATE,'YYYY') || to_char(${campo},'-MM-DD'), 'YYYY-MM-DD') >= CURRENT_DATE
            THEN to_date(to_char(CURRENT_DATE,'YYYY') || to_char(${campo},'-MM-DD'), 'YYYY-MM-DD') - CURRENT_DATE
            ELSE to_date(to_char(CURRENT_DATE + INTERVAL '1 year','YYYY') || to_char(${campo},'-MM-DD'), 'YYYY-MM-DD') - CURRENT_DATE
          END
        ) AS dias_faltam,
        EXTRACT(YEAR FROM AGE(CURRENT_DATE, ${campo}))::int AS ${rotuloIdade}
      FROM colaboradores
      WHERE ${campo} IS NOT NULL AND status = 'Ativo'
    ) t
    WHERE dias_faltam <= $1
    ORDER BY dias_faltam ASC
  `;
}

/* Desligado leva data (hoje, se não informada). Qualquer outro status zera a data. */
function dataDesligamento(status, dt) {
  if (status !== 'Desligado') return null;
  return dt || new Date().toISOString().slice(0, 10);
}

/* GET /api/colaboradores            todos (histórico, relatórios)
   GET /api/colaboradores?ativos=1   sem os desligados (para selects de lançamento) */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, turno, q, ativos } = req.query;
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (ativos) where.push(`status IS DISTINCT FROM 'Desligado'`);
    if (turno)  { params.push(turno);  where.push(`turno = $${params.length}`); }
    if (q)      { params.push('%' + q.toLowerCase() + '%'); where.push(`LOWER(nome) LIKE $${params.length}`); }

    let sql = 'SELECT * FROM colaboradores';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY nome';

    res.json((await pool.query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/colaboradores/aniversarios-empresa?dias=7 */
router.get('/aniversarios-empresa', requireAuth, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias, 10) || 7;
    const r = await pool.query(sqlAniversarios('dt_admissao', 'anos_empresa'), [dias]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/colaboradores/aniversarios-pessoal?dias=7 */
router.get('/aniversarios-pessoal', requireAuth, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias, 10) || 7;
    const r = await pool.query(sqlAniversarios('dt_nascimento', 'idade'), [dias]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/colaboradores/:id */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM colaboradores WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Colaborador não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/colaboradores */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nome, mat, cargo, setor, turno, status, dt_admissao, dt_nascimento } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const desl = dataDesligamento(status, req.body.dt_desligamento);

    const r = await pool.query(
      `INSERT INTO colaboradores (nome,mat,cargo,setor,turno,status,dt_admissao,dt_nascimento,dt_desligamento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [nome.trim(), mat || null, cargo || null, setor || 'Montagem',
       turno || null, status || 'Ativo', dt_admissao || null, dt_nascimento || null, desl]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PUT /api/colaboradores/:id */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { nome, mat, cargo, setor, turno, status, dt_admissao, dt_nascimento } = req.body;
    const desl = dataDesligamento(status, req.body.dt_desligamento);
    const r = await pool.query(
      `UPDATE colaboradores SET
         nome=COALESCE($1,nome), mat=$2, cargo=$3, setor=$4, turno=$5,
         status=COALESCE($6,status), dt_admissao=$7, dt_nascimento=$8, dt_desligamento=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [nome || null, mat || null, cargo || null, setor || null, turno || null,
       status || null, dt_admissao || null, dt_nascimento || null, desl, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Colaborador não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* DELETE /api/colaboradores/:id */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM colaboradores WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23503') {
      return res.status(409).json({
        error: 'Este colaborador tem registros vinculados. Em vez de excluir, edite e marque o status "Desligado" — o histórico dele é mantido.'
      });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
