const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { detectarTurno } = require('../lib/turnos');

const normUid = u => String(u || '').trim().toLowerCase();

async function param(chave, padrao) {
  const r = await pool.query('SELECT valor FROM app_config WHERE chave=$1', [chave]);
  return r.rows.length ? r.rows[0].valor : padrao;
}

/* ═════════════ CRACHÁS ═════════════ */

/* GET /api/ponto/crachas — lista para o seletor manual e para o admin */
router.get('/crachas', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, col.nome AS colab_nome, col.mat, col.turno AS colab_turno, col.status
      FROM ponto_crachas c
      LEFT JOIN colaboradores col ON col.id = c.colaborador_id
      ORDER BY COALESCE(col.nome, c.nome_cache)
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/crachas', requireAdmin, async (req, res) => {
  try {
    const { uid, colaborador_id, nome_cache } = req.body;
    if (!uid) return res.status(400).json({ error: 'Informe o UID do crachá' });
    if (!colaborador_id && !nome_cache) {
      return res.status(400).json({ error: 'Vincule o crachá a um colaborador' });
    }

    const r = await pool.query(
      `INSERT INTO ponto_crachas (uid,colaborador_id,nome_cache) VALUES ($1,$2,$3) RETURNING *`,
      [normUid(uid), colaborador_id || null, nome_cache || null]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Esse UID já está cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/crachas/:id', requireAdmin, async (req, res) => {
  try {
    const { uid, colaborador_id, nome_cache, ativo } = req.body;
    const r = await pool.query(
      `UPDATE ponto_crachas SET
         uid=COALESCE($1,uid), colaborador_id=COALESCE($2,colaborador_id),
         nome_cache=COALESCE($3,nome_cache), ativo=COALESCE($4,ativo)
       WHERE id=$5 RETURNING *`,
      [uid ? normUid(uid) : null, colaborador_id ?? null, nome_cache ?? null,
       typeof ativo === 'boolean' ? ativo : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Crachá não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Esse UID já está cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/crachas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM ponto_crachas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════ BATIDA DE PONTO ═════════════ */

/**
 * POST /api/ponto/registros
 * body: { uid } (leitura NFC)  ou  { colaborador_id } (batida manual)
 *
 * O turno é detectado pelo horário. O tipo (entrada/saída) alterna
 * conforme a quantidade de batidas do colaborador no dia.
 */
router.post('/registros', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { uid, colaborador_id, observacao, dispositivo } = req.body;

    let colab = null;
    let crachaUid = null;
    let origem = 'manual';

    if (uid) {
      origem = 'nfc';
      crachaUid = normUid(uid);
      const r = await client.query(
        `SELECT c.uid, c.ativo, c.nome_cache, col.id, col.nome, col.status
         FROM ponto_crachas c
         LEFT JOIN colaboradores col ON col.id = c.colaborador_id
         WHERE c.uid=$1`,
        [crachaUid]
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: 'Crachá não cadastrado', uid: crachaUid, codigo: 'CRACHA_DESCONHECIDO' });
      }
      if (r.rows[0].ativo === false) {
        return res.status(403).json({ error: 'Crachá desativado', codigo: 'CRACHA_INATIVO' });
      }
      colab = { id: r.rows[0].id, nome: r.rows[0].nome || r.rows[0].nome_cache, status: r.rows[0].status };
    } else if (colaborador_id) {
      if ((await param('ponto_permite_manual', 'true')) !== 'true') {
        return res.status(403).json({ error: 'A batida manual está desativada', codigo: 'MANUAL_DESATIVADO' });
      }
      const r = await client.query('SELECT id,nome,status FROM colaboradores WHERE id=$1', [colaborador_id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Colaborador não encontrado' });
      colab = r.rows[0];

      const c = await client.query(
        'SELECT uid FROM ponto_crachas WHERE colaborador_id=$1 AND ativo=TRUE LIMIT 1', [colab.id]
      );
      crachaUid = c.rows.length ? c.rows[0].uid : null;
    } else {
      return res.status(400).json({ error: 'Envie o UID do crachá ou o colaborador' });
    }

    if (!colab.nome) return res.status(400).json({ error: 'Crachá sem colaborador vinculado' });
    if (colab.status && colab.status !== 'Ativo') {
      return res.status(403).json({ error: `Colaborador com status "${colab.status}"`, codigo: 'COLAB_INATIVO' });
    }

    const agora = new Date();
    const data = agora.toISOString().slice(0, 10);
    const hora = agora.toTimeString().slice(0, 8);

    // Anti-duplicidade: bloqueia batidas repetidas em janela curta
    const bloqueioMin = parseInt(await param('ponto_bloqueio_min', '1'), 10) || 0;
    if (bloqueioMin > 0 && colab.id) {
      const dup = await client.query(
        `SELECT hora FROM ponto_registros
         WHERE colaborador_id=$1 AND marcado_em > NOW() - ($2 || ' minutes')::interval
         ORDER BY marcado_em DESC LIMIT 1`,
        [colab.id, String(bloqueioMin)]
      );
      if (dup.rows.length) {
        return res.status(429).json({
          error: `Ponto já registrado às ${dup.rows[0].hora}. Aguarde ${bloqueioMin} min.`,
          codigo: 'BATIDA_DUPLICADA'
        });
      }
    }

    const turno = await detectarTurno(hora);

    // entrada / saída alternam pela contagem de batidas do dia
    const qtd = await client.query(
      'SELECT COUNT(*)::int n FROM ponto_registros WHERE colaborador_id=$1 AND data=$2',
      [colab.id, data]
    );
    const tipo = qtd.rows[0].n % 2 === 0 ? 'entrada' : 'saida';

    const r = await client.query(
      `INSERT INTO ponto_registros
        (colaborador_id, cracha_uid, nome, turno_id, turno_codigo, data, hora, tipo, origem, dispositivo, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [colab.id, crachaUid, colab.nome, turno ? turno.id : null, turno ? turno.codigo : null,
       data, hora, tipo, origem, dispositivo || null, observacao || null]
    );

    res.json({
      ...r.rows[0],
      turno_nome: turno ? turno.nome : null,
      fora_de_turno: !turno
    });
  } catch (e) {
    console.error('POST /api/ponto/registros', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* GET /api/ponto/registros?periodo=hoje|semana|mes|tudo&colaborador_id=&turno_id=&data_ini=&data_fim= */
router.get('/registros', requireAuth, async (req, res) => {
  try {
    const { periodo, colaborador_id, turno_id, data_ini, data_fim, limite } = req.query;
    const where = [];
    const params = [];

    if (periodo === 'hoje')        where.push(`data = CURRENT_DATE`);
    else if (periodo === 'semana') where.push(`data >= CURRENT_DATE - INTERVAL '7 days'`);
    else if (periodo === 'mes')    where.push(`data >= date_trunc('month', CURRENT_DATE)`);

    if (data_ini) { params.push(data_ini); where.push(`data >= $${params.length}`); }
    if (data_fim) { params.push(data_fim); where.push(`data <= $${params.length}`); }
    if (colaborador_id) { params.push(colaborador_id); where.push(`colaborador_id = $${params.length}`); }
    if (turno_id) { params.push(turno_id); where.push(`turno_id = $${params.length}`); }

    let sql = `SELECT p.*, t.nome AS turno_nome
               FROM ponto_registros p
               LEFT JOIN turnos t ON t.id = p.turno_id`;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY p.data DESC, p.hora DESC';

    const lim = Math.min(parseInt(limite, 10) || 1000, 5000);
    params.push(lim);
    sql += ` LIMIT $${params.length}`;

    res.json((await pool.query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/ponto/registros/recentes — últimas batidas para o painel do totem */
router.get('/registros/recentes', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT nome, hora, tipo, turno_codigo FROM ponto_registros
       WHERE data = CURRENT_DATE ORDER BY marcado_em DESC LIMIT 6`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/ponto/resumo — KPIs do dia */
router.get('/resumo', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ponto_registros WHERE data = CURRENT_DATE)                    AS batidas_hoje,
        (SELECT COUNT(DISTINCT colaborador_id)::int FROM ponto_registros WHERE data = CURRENT_DATE) AS pessoas_hoje,
        (SELECT COUNT(*)::int FROM ponto_crachas WHERE ativo = TRUE)                             AS crachas_ativos,
        (SELECT COUNT(*)::int FROM colaboradores WHERE status = 'Ativo')                          AS colaboradores_ativos
    `);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* DELETE /api/ponto/registros/:id — correção pontual (admin) */
router.delete('/registros/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM ponto_registros WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* DELETE /api/ponto/registros — limpeza por período (admin) */
router.delete('/registros', requireAdmin, async (req, res) => {
  try {
    const { data_ini, data_fim } = req.query;
    if (!data_ini || !data_fim) {
      return res.status(400).json({ error: 'Informe data_ini e data_fim para limpar registros' });
    }
    const r = await pool.query(
      'DELETE FROM ponto_registros WHERE data BETWEEN $1 AND $2', [data_ini, data_fim]
    );
    res.json({ success: true, removidos: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
