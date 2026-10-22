const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/*
 * Módulo Limpeza
 *
 * Itens:   GET/POST /itens · PUT/DELETE /itens/:id · POST /itens/:id/feito (registra limpeza agora)
 * Agenda:  GET /agenda?de=&ate=&status= · POST /agenda · POST /agenda/gerar
 *          PUT /agenda/:id · PUT /agenda/:id/feito · PUT /agenda/:id/reabrir · DELETE /agenda/:id
 *
 * Datas saem sempre como texto 'YYYY-MM-DD' (to_char) para a tela não ter que
 * lidar com fuso horário.
 */

const FREQ = ['dias', 'semanas', 'meses'];
const idOk = v => /^\d+$/.test(String(v));
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const hoje = () => new Date().toISOString().slice(0, 10);
const inteiro = (v, padrao) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : padrao);

/** Soma a frequência a uma data 'YYYY-MM-DD' (meses respeitam o calendário: 31/01 + 1 mês = 28/02). */
function somarFreq(iso, qtd, tipo) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (tipo === 'meses') {
    const alvo = new Date(Date.UTC(y, m - 1 + qtd, 1));
    const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
    alvo.setUTCDate(Math.min(d, ultimo));
    return alvo.toISOString().slice(0, 10);
  }
  dt.setUTCDate(dt.getUTCDate() + qtd * (tipo === 'semanas' ? 7 : 1));
  return dt.toISOString().slice(0, 10);
}

const SELECT_ITENS = `
  SELECT i.id, i.nome, i.local, i.descricao, i.freq_qtd, i.freq_tipo, i.aviso_dias, i.responsavel_id,
         i.ativo, to_char(i.inicio, 'YYYY-MM-DD') AS inicio, i.created_at, i.updated_at,
         c.nome AS responsavel_nome,
         to_char((SELECT MAX(a.feito_em) FROM lp_agenda a WHERE a.item_id = i.id AND a.status = 'feito'), 'YYYY-MM-DD') AS ultima,
         (SELECT COUNT(*)::int FROM lp_agenda a WHERE a.item_id = i.id AND a.status = 'feito') AS total_feitas,
         to_char((SELECT MIN(a.data) FROM lp_agenda a WHERE a.item_id = i.id AND a.status = 'agendado' AND a.data >= CURRENT_DATE), 'YYYY-MM-DD') AS proximo_agendamento
    FROM lp_itens i
    LEFT JOIN colaboradores c ON c.id = i.responsavel_id`;

const SELECT_AGENDA = `
  SELECT a.id, a.item_id, a.colaborador_id, to_char(a.data, 'YYYY-MM-DD') AS data, a.turno, a.status,
         to_char(a.feito_em, 'YYYY-MM-DD') AS feito_em, to_char(a.feito_hora, 'HH24:MI') AS feito_hora,
         a.feito_por_id, a.obs, a.created_at,
         i.nome AS item_nome, i.local AS item_local, i.freq_qtd, i.freq_tipo,
         c.nome AS colaborador_nome, f.nome AS feito_por_nome
    FROM lp_agenda a
    JOIN lp_itens i ON i.id = a.item_id
    LEFT JOIN colaboradores c ON c.id = a.colaborador_id
    LEFT JOIN colaboradores f ON f.id = a.feito_por_id`;

/** Calcula 'proxima' (vencimento) para cada item: última feita + frequência, ou o início. */
function comProxima(rows) {
  return rows.map(i => ({
    ...i,
    proxima: i.ultima ? somarFreq(i.ultima, i.freq_qtd, i.freq_tipo) : i.inicio
  }));
}

function camposItem(b) {
  return {
    nome: (b.nome || '').trim(),
    local: (b.local || '').trim() || null,
    descricao: (b.descricao || '').trim() || null,
    freq_qtd: inteiro(b.freq_qtd, 1),
    freq_tipo: FREQ.includes(b.freq_tipo) ? b.freq_tipo : 'dias',
    aviso_dias: Number.isInteger(Number(b.aviso_dias)) && Number(b.aviso_dias) >= 0 ? Number(b.aviso_dias) : 2,
    responsavel_id: idOk(b.responsavel_id) ? Number(b.responsavel_id) : null,
    inicio: dataOk(b.inicio) ? b.inicio : hoje(),
    ativo: b.ativo !== false
  };
}

/* ───────── ITENS ───────── */

router.get('/itens', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(SELECT_ITENS + ' ORDER BY i.ativo DESC, i.nome');
    res.json(comProxima(r.rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/itens', requireAuth, async (req, res) => {
  try {
    const c = camposItem(req.body);
    if (!c.nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const r = await pool.query(
      `INSERT INTO lp_itens (nome, local, descricao, freq_qtd, freq_tipo, aviso_dias, responsavel_id, inicio, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.nome, c.local, c.descricao, c.freq_qtd, c.freq_tipo, c.aviso_dias, c.responsavel_id, c.inicio, c.ativo]
    );
    const full = await pool.query(SELECT_ITENS + ' WHERE i.id = $1', [r.rows[0].id]);
    res.json(comProxima(full.rows)[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/itens/:id', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const c = camposItem(req.body);
    if (!c.nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const r = await pool.query(
      `UPDATE lp_itens SET nome=$1, local=$2, descricao=$3, freq_qtd=$4, freq_tipo=$5, aviso_dias=$6,
              responsavel_id=$7, inicio=$8, ativo=$9, updated_at=NOW()
       WHERE id=$10 RETURNING id`,
      [c.nome, c.local, c.descricao, c.freq_qtd, c.freq_tipo, c.aviso_dias, c.responsavel_id, c.inicio, c.ativo, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Item não encontrado' });
    const full = await pool.query(SELECT_ITENS + ' WHERE i.id = $1', [req.params.id]);
    res.json(comProxima(full.rows)[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/itens/:id', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    await pool.query('DELETE FROM lp_itens WHERE id=$1', [req.params.id]);   // agenda e fotos vão junto
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Registra uma limpeza feita agora (sem agendamento prévio). Se havia um
   agendamento em aberto para esse item, o mais próximo é dado como feito
   em vez de criar uma linha nova. */
router.post('/itens/:id/feito', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const feito_em = dataOk(req.body.feito_em) ? req.body.feito_em : hoje();
    const feito_hora = /^\d{2}:\d{2}/.test(req.body.feito_hora || '') ? req.body.feito_hora.slice(0, 5) : new Date().toTimeString().slice(0, 5);
    const quem = idOk(req.body.feito_por_id) ? Number(req.body.feito_por_id) : null;
    const obs = (req.body.obs || '').trim() || null;

    const item = await pool.query('SELECT id FROM lp_itens WHERE id=$1', [req.params.id]);
    if (!item.rows.length) return res.status(404).json({ error: 'Item não encontrado' });

    const aberto = await pool.query(
      `SELECT id FROM lp_agenda WHERE item_id=$1 AND status='agendado' ORDER BY ABS(data - $2::date), id LIMIT 1`,
      [req.params.id, feito_em]
    );
    let r;
    if (aberto.rows.length) {
      r = await pool.query(
        `UPDATE lp_agenda SET status='feito', feito_em=$1, feito_hora=$2, feito_por_id=COALESCE($3, colaborador_id),
                obs=COALESCE($4, obs) WHERE id=$5 RETURNING id`,
        [feito_em, feito_hora, quem, obs, aberto.rows[0].id]
      );
    } else {
      r = await pool.query(
        `INSERT INTO lp_agenda (item_id, colaborador_id, data, status, feito_em, feito_hora, feito_por_id, obs)
         VALUES ($1,$2,$3,'feito',$3,$4,$2,$5) RETURNING id`,
        [req.params.id, quem, feito_em, feito_hora, obs]
      );
    }
    const full = await pool.query(SELECT_AGENDA + ' WHERE a.id = $1', [r.rows[0].id]);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── AGENDA ───────── */

router.get('/agenda', requireAuth, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (dataOk(req.query.de))  { params.push(req.query.de);  where.push(`a.data >= $${params.length}`); }
    if (dataOk(req.query.ate)) { params.push(req.query.ate); where.push(`a.data <= $${params.length}`); }
    if (req.query.status)      { params.push(req.query.status); where.push(`a.status = $${params.length}`); }
    if (idOk(req.query.item_id)) { params.push(Number(req.query.item_id)); where.push(`a.item_id = $${params.length}`); }
    const sql = SELECT_AGENDA + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY a.data, a.status, i.nome, a.id';
    res.json((await pool.query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/agenda', requireAuth, async (req, res) => {
  try {
    const { item_id, colaborador_id, data, turno, obs } = req.body;
    if (!idOk(item_id) || !dataOk(data)) return res.status(400).json({ error: 'Item e data são obrigatórios' });
    const r = await pool.query(
      `INSERT INTO lp_agenda (item_id, colaborador_id, data, turno, obs) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [item_id, idOk(colaborador_id) ? Number(colaborador_id) : null, data, turno || null, (obs || '').trim() || null]
    );
    const full = await pool.query(SELECT_AGENDA + ' WHERE a.id = $1', [r.rows[0].id]);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Gera os agendamentos de todos os itens ativos (ou dos informados) da
   próxima limpeza prevista até a data `ate`, pulando o que já está agendado.
   Usa o responsável padrão do item. Pode rodar quantas vezes quiser. */
router.post('/agenda/gerar', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ate = dataOk(req.body.ate) ? req.body.ate : null;
    if (!ate) return res.status(400).json({ error: 'Informe até quando gerar' });
    const somenteIds = Array.isArray(req.body.item_ids) ? req.body.item_ids.filter(idOk).map(Number) : null;
    const pularFds = req.body.pular_fds !== false;
    // sábado/domingo → segunda-feira seguinte
    const diaUtil = iso => {
      const [y, m, d] = iso.split('-').map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return dow === 6 ? somarFreq(iso, 2, 'dias') : dow === 0 ? somarFreq(iso, 1, 'dias') : iso;
    };

    let itens = comProxima((await client.query(SELECT_ITENS + ' WHERE i.ativo = TRUE')).rows);
    if (somenteIds) itens = itens.filter(i => somenteIds.includes(i.id));

    const h = hoje();
    let criados = 0;
    await client.query('BEGIN');
    for (const it of itens) {
      const existentes = new Set((await client.query(
        `SELECT to_char(data,'YYYY-MM-DD') d FROM lp_agenda WHERE item_id=$1 AND status='agendado'`, [it.id]
      )).rows.map(r => r.d));
      // vencido → primeiro agendamento é hoje; depois segue a frequência
      let d = it.proxima < h ? h : it.proxima;
      let guarda = 0;
      while (d <= ate && guarda++ < 400) {
        const dia = pularFds ? diaUtil(d) : d;
        if (dia <= ate && !existentes.has(dia)) {
          await client.query(
            `INSERT INTO lp_agenda (item_id, colaborador_id, data) VALUES ($1,$2,$3)`,
            [it.id, it.responsavel_id, dia]
          );
          existentes.add(dia);
          criados++;
        }
        d = somarFreq(d, it.freq_qtd, it.freq_tipo);
      }
    }
    await client.query('COMMIT');
    res.json({ criados, itens: itens.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.put('/agenda/:id/feito', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const feito_em = dataOk(req.body.feito_em) ? req.body.feito_em : hoje();
    const feito_hora = /^\d{2}:\d{2}/.test(req.body.feito_hora || '') ? req.body.feito_hora.slice(0, 5) : new Date().toTimeString().slice(0, 5);
    const quem = idOk(req.body.feito_por_id) ? Number(req.body.feito_por_id) : null;
    const r = await pool.query(
      `UPDATE lp_agenda SET status='feito', feito_em=$1, feito_hora=$2,
              feito_por_id=COALESCE($3, colaborador_id), obs=COALESCE($4, obs)
       WHERE id=$5 RETURNING id`,
      [feito_em, feito_hora, quem, (req.body.obs || '').trim() || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const full = await pool.query(SELECT_AGENDA + ' WHERE a.id = $1', [req.params.id]);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/agenda/:id/reabrir', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    await pool.query(
      `UPDATE lp_agenda SET status='agendado', feito_em=NULL, feito_hora=NULL, feito_por_id=NULL WHERE id=$1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/agenda/:id', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const { colaborador_id, data, turno, obs } = req.body;
    if (data !== undefined && !dataOk(data)) return res.status(400).json({ error: 'Data inválida' });
    const r = await pool.query(
      `UPDATE lp_agenda SET
         colaborador_id = CASE WHEN $1::text IS NULL THEN colaborador_id ELSE NULLIF($1::text,'')::int END,
         data = COALESCE($2::date, data),
         turno = CASE WHEN $3::text IS NULL THEN turno ELSE NULLIF($3::text,'') END,
         obs   = CASE WHEN $4::text IS NULL THEN obs   ELSE NULLIF($4::text,'') END
       WHERE id=$5 RETURNING id`,
      [colaborador_id === undefined ? null : String(colaborador_id ?? ''), data || null,
       turno === undefined ? null : String(turno ?? ''), obs === undefined ? null : String(obs ?? ''), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const full = await pool.query(SELECT_AGENDA + ' WHERE a.id = $1', [req.params.id]);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/agenda/:id', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    await pool.query('DELETE FROM lp_agenda WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.somarFreq = somarFreq;
