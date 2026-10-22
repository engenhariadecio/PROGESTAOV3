const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { listarTurnos, calcularCiclos } = require('../lib/turnos');

const hoje = () => new Date().toISOString().slice(0, 10);

/* ═════════════ PRODUTOS / TAKT TIME ═════════════ */

/* GET /api/cadenciador/produtos?turno_id=1 — takt já resolvido para o turno */
router.get('/produtos', requireAuth, async (req, res) => {
  try {
    const { turno_id, todos } = req.query;
    const params = [];
    let taktSel = 'p.takt_min';

    if (turno_id) {
      params.push(turno_id);
      taktSel = `COALESCE(tt.takt_min, p.takt_min)`;
    }

    let sql = `
      SELECT p.id, p.nome, p.cod_decio, p.takt_min AS takt_padrao,
             ${taktSel}::float AS takt_min,
             p.celula_id, c.nome AS celula_nome, p.ativo, p.ordem
      FROM cad_produtos p
      LEFT JOIN celulas c ON c.id = p.celula_id
      ${turno_id ? 'LEFT JOIN cad_takt_turno tt ON tt.produto_id = p.id AND tt.turno_id = $1' : ''}
    `;
    if (todos !== '1') sql += ' WHERE p.ativo = TRUE';
    sql += ' ORDER BY p.ordem, p.nome';

    res.json((await pool.query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/produtos', requireAdmin, async (req, res) => {
  try {
    const { nome, cod_decio, takt_min, celula_id, ordem } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome do produto é obrigatório' });
    const takt = parseFloat(takt_min);
    if (!(takt > 0)) return res.status(400).json({ error: 'Takt time deve ser maior que zero' });

    const r = await pool.query(
      `INSERT INTO cad_produtos (nome,cod_decio,takt_min,celula_id,ordem)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [nome.trim(), cod_decio || null, takt, celula_id || null, ordem ?? 0]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe um produto com esse nome' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/produtos/:id', requireAdmin, async (req, res) => {
  try {
    const { nome, cod_decio, takt_min, celula_id, ordem, ativo } = req.body;
    if (takt_min !== undefined && !(parseFloat(takt_min) > 0)) {
      return res.status(400).json({ error: 'Takt time deve ser maior que zero' });
    }
    const r = await pool.query(
      `UPDATE cad_produtos SET
         nome=COALESCE($1,nome), cod_decio=COALESCE($2,cod_decio),
         takt_min=COALESCE($3,takt_min), celula_id=COALESCE($4,celula_id),
         ordem=COALESCE($5,ordem), ativo=COALESCE($6,ativo), updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [nome || null, cod_decio ?? null, takt_min ?? null, celula_id ?? null,
       ordem ?? null, typeof ativo === 'boolean' ? ativo : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/produtos/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM cad_produtos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PUT /api/cadenciador/produtos/takt-lote — salva vários takts de uma vez */
router.put('/produtos-takt-lote', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { turno_id, itens } = req.body;   // itens: [{ produto_id, takt_min }]
    if (!Array.isArray(itens) || !itens.length) {
      return res.status(400).json({ error: 'Envie ao menos um item' });
    }

    await client.query('BEGIN');
    for (const it of itens) {
      const takt = parseFloat(it.takt_min);
      if (!(takt > 0)) throw new Error(`Takt inválido para o produto ${it.produto_id}`);

      if (turno_id) {
        await client.query(
          `INSERT INTO cad_takt_turno (produto_id,turno_id,takt_min) VALUES ($1,$2,$3)
           ON CONFLICT (produto_id,turno_id) DO UPDATE SET takt_min=EXCLUDED.takt_min`,
          [it.produto_id, turno_id, takt]
        );
      } else {
        await client.query(
          'UPDATE cad_produtos SET takt_min=$1, updated_at=NOW() WHERE id=$2',
          [takt, it.produto_id]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, salvos: itens.length, escopo: turno_id ? 'turno' : 'padrão' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* DELETE /api/cadenciador/takt-turno — remove a sobreposição, volta ao takt padrão */
router.delete('/takt-turno', requireAdmin, async (req, res) => {
  try {
    const { produto_id, turno_id } = req.query;
    if (!produto_id || !turno_id) return res.status(400).json({ error: 'Informe produto_id e turno_id' });
    await pool.query('DELETE FROM cad_takt_turno WHERE produto_id=$1 AND turno_id=$2', [produto_id, turno_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ SESSÃO DE PRODUÇÃO ═════════════ */

async function carregarSessao(id) {
  const s = (await pool.query(`
    SELECT s.*, p.nome AS produto_nome, p.cod_decio, t.nome AS turno_nome, t.codigo AS turno_codigo,
           t.hora_inicio, t.hora_fim, t.cruza_meia_noite
    FROM cad_sessoes s
    JOIN cad_produtos p ON p.id = s.produto_id
    JOIN turnos t ON t.id = s.turno_id
    WHERE s.id = $1`, [id])).rows[0];
  if (!s) return null;

  const intervalos = (await pool.query(
    'SELECT * FROM turno_intervalos WHERE turno_id=$1 AND ativo=TRUE ORDER BY hora_inicio', [s.turno_id]
  )).rows;

  const ciclos = (await pool.query(
    'SELECT numero, hora_prevista, concluido, observacao FROM cad_ciclos WHERE sessao_id=$1 ORDER BY numero', [id]
  )).rows;

  const paradaAberta = (await pool.query(
    'SELECT * FROM cad_paradas WHERE sessao_id=$1 AND fim IS NULL ORDER BY inicio DESC LIMIT 1', [id]
  )).rows[0] || null;

  return { ...s, takt_min: parseFloat(s.takt_min), intervalos, ciclos, parada_aberta: paradaAberta };
}

/**
 * POST /api/cadenciador/sessoes
 * Abre (ou reabre) a sessão do dia para um produto + turno e gera a grade de ciclos.
 * body: { data?, turno_id, produto_id }
 */
router.post('/sessoes', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const data = req.body.data || hoje();
    const { turno_id, produto_id } = req.body;
    if (!turno_id || !produto_id) return res.status(400).json({ error: 'Informe o turno e o produto' });

    const turnos = await listarTurnos();
    const turno = turnos.find(t => t.id === Number(turno_id));
    if (!turno) return res.status(404).json({ error: 'Turno não encontrado' });

    const tk = await client.query(
      `SELECT COALESCE(tt.takt_min, p.takt_min)::float AS takt
       FROM cad_produtos p
       LEFT JOIN cad_takt_turno tt ON tt.produto_id=p.id AND tt.turno_id=$2
       WHERE p.id=$1`,
      [produto_id, turno_id]
    );
    if (!tk.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    const takt = tk.rows[0].takt;

    await client.query('BEGIN');

    const s = await client.query(
      `INSERT INTO cad_sessoes (data,turno_id,produto_id,takt_min) VALUES ($1,$2,$3,$4)
       ON CONFLICT (data,turno_id,produto_id) DO UPDATE SET updated_at=NOW()
       RETURNING id, tempo_parado_seg`,
      [data, turno_id, produto_id, takt]
    );
    const sessaoId = s.rows[0].id;
    const parado = s.rows[0].tempo_parado_seg || 0;

    const limite = parseInt(
      (await client.query(`SELECT valor FROM app_config WHERE chave='cad_limite_ciclos'`)).rows[0]?.valor || '500', 10
    );

    const ciclos = calcularCiclos(turno, takt, { tempoParadoSeg: parado, limite });

    // Recria a grade preservando o que já foi marcado/observado
    for (const c of ciclos) {
      await client.query(
        `INSERT INTO cad_ciclos (sessao_id,numero,hora_prevista) VALUES ($1,$2,$3)
         ON CONFLICT (sessao_id,numero) DO UPDATE SET hora_prevista=EXCLUDED.hora_prevista, updated_at=NOW()`,
        [sessaoId, c.numero, c.hora]
      );
    }
    // Remove ciclos que sobraram de um takt anterior maior
    await client.query('DELETE FROM cad_ciclos WHERE sessao_id=$1 AND numero > $2', [sessaoId, ciclos.length]);

    await client.query('COMMIT');
    res.json(await carregarSessao(sessaoId));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/cadenciador/sessoes', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* GET /api/cadenciador/sessoes/:id */
router.get('/sessoes/:id', requireAuth, async (req, res) => {
  try {
    const s = await carregarSessao(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/cadenciador/sessoes?data=&turno_id= */
router.get('/sessoes', requireAuth, async (req, res) => {
  try {
    const data = req.query.data || hoje();
    const params = [data];
    let sql = `
      SELECT s.id, s.data, s.takt_min::float, s.tempo_parado_seg, s.status,
             p.nome AS produto_nome, t.nome AS turno_nome, t.codigo AS turno_codigo,
             (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id=s.id) AS total_ciclos,
             (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id=s.id AND c.concluido) AS ciclos_ok
      FROM cad_sessoes s
      JOIN cad_produtos p ON p.id=s.produto_id
      JOIN turnos t ON t.id=s.turno_id
      WHERE s.data=$1`;
    if (req.query.turno_id) { params.push(req.query.turno_id); sql += ` AND s.turno_id=$${params.length}`; }
    sql += ' ORDER BY t.ordem, p.nome';
    res.json((await pool.query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ CICLOS ═════════════ */

/* PUT /api/cadenciador/sessoes/:id/ciclos/:numero */
router.put('/sessoes/:id/ciclos/:numero', requireAuth, async (req, res) => {
  try {
    const { concluido, observacao } = req.body;
    const r = await pool.query(
      `UPDATE cad_ciclos SET
         concluido = COALESCE($1, concluido),
         observacao = COALESCE($2, observacao),
         updated_at = NOW()
       WHERE sessao_id=$3 AND numero=$4 RETURNING *`,
      [typeof concluido === 'boolean' ? concluido : null,
       observacao ?? null, req.params.id, req.params.numero]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Ciclo não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/cadenciador/sessoes/:id/reset — limpa marcações e observações */
router.post('/sessoes/:id/reset', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE cad_ciclos SET concluido=TRUE, observacao=NULL, updated_at=NOW() WHERE sessao_id=$1',
      [req.params.id]
    );
    res.json(await carregarSessao(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ PARADAS DE LINHA ═════════════ */

/* POST /api/cadenciador/sessoes/:id/parar */
router.post('/sessoes/:id/parar', requireAuth, async (req, res) => {
  try {
    const aberta = await pool.query(
      'SELECT id FROM cad_paradas WHERE sessao_id=$1 AND fim IS NULL', [req.params.id]
    );
    if (aberta.rows.length) return res.status(409).json({ error: 'A linha já está parada' });

    const r = await pool.query(
      'INSERT INTO cad_paradas (sessao_id,motivo) VALUES ($1,$2) RETURNING *',
      [req.params.id, req.body.motivo || null]
    );
    await pool.query(`UPDATE cad_sessoes SET status='parada', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/cadenciador/sessoes/:id/continuar — fecha a parada e recalcula a grade */
router.post('/sessoes/:id/continuar', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const sessaoId = req.params.id;
    await client.query('BEGIN');

    const p = await client.query(
      'SELECT id, inicio FROM cad_paradas WHERE sessao_id=$1 AND fim IS NULL ORDER BY inicio DESC LIMIT 1',
      [sessaoId]
    );
    if (!p.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Não há parada aberta nesta sessão' });
    }

    const fech = await client.query(
      `UPDATE cad_paradas
         SET fim = NOW(), duracao_seg = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - inicio))::int)
       WHERE id=$1 RETURNING duracao_seg`,
      [p.rows[0].id]
    );
    const dur = fech.rows[0].duracao_seg;

    const s = await client.query(
      `UPDATE cad_sessoes SET tempo_parado_seg = COALESCE(tempo_parado_seg,0) + $1,
                              status='aberta', updated_at=NOW()
       WHERE id=$2 RETURNING turno_id, takt_min::float, tempo_parado_seg`,
      [dur, sessaoId]
    );
    const { turno_id, takt_min, tempo_parado_seg } = s.rows[0];

    const turnos = await listarTurnos();
    const turno = turnos.find(t => t.id === turno_id);

    const limite = parseInt(
      (await client.query(`SELECT valor FROM app_config WHERE chave='cad_limite_ciclos'`)).rows[0]?.valor || '500', 10
    );
    const ciclos = calcularCiclos(turno, takt_min, { tempoParadoSeg: tempo_parado_seg, limite });

    for (const c of ciclos) {
      await client.query(
        `INSERT INTO cad_ciclos (sessao_id,numero,hora_prevista) VALUES ($1,$2,$3)
         ON CONFLICT (sessao_id,numero) DO UPDATE SET hora_prevista=EXCLUDED.hora_prevista, updated_at=NOW()`,
        [sessaoId, c.numero, c.hora]
      );
    }
    await client.query('DELETE FROM cad_ciclos WHERE sessao_id=$1 AND numero > $2', [sessaoId, ciclos.length]);

    await client.query('COMMIT');
    res.json(await carregarSessao(sessaoId));
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* GET /api/cadenciador/sessoes/:id/paradas */
router.get('/sessoes/:id/paradas', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM cad_paradas WHERE sessao_id=$1 ORDER BY inicio DESC', [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
