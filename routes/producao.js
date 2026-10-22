const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// =====================================================
// HELPERS
// =====================================================

function mesDaData(dataISO) {
  if (!dataISO) return null;
  return String(dataISO).substring(0, 7);
}

// Valida string composta apenas por dígitos numéricos (ex: N° OP)
function validarDigitos(valor, qtd) {
  if (!valor) return false;
  const s = String(valor).trim();
  const re = new RegExp(`^\\d{${qtd}}$`);
  return re.test(s);
}

// Valida string alfanumérica (letras + números) — usada para séries
function validarAlfanumerico(valor, qtd) {
  if (!valor) return false;
  const s = String(valor).trim().toUpperCase();
  const re = new RegExp(`^[A-Z0-9]{${qtd}}$`);
  return re.test(s);
}

/* O realizado de um plano é SEMPRE a soma dos apontamentos diários ligados a
   ele — nunca um valor somado/subtraído aos poucos (que acabava divergindo
   depois de edições e exclusões). */
const SQL_RECALC = `UPDATE prod_planos p SET realizado = COALESCE((
    SELECT SUM(a.realizado) FROM prod_apontamentos_detalhados a WHERE a.plano_id = p.id), 0)`;
async function recalcRealizado(planoId, client) {
  const db = client || pool;
  if (planoId) await db.query(SQL_RECALC + ' WHERE p.id = $1', [planoId]);
  else await db.query(SQL_RECALC);
}

async function atualizarStatusPlano(planoId, client) {
  const db = client || pool;
  await recalcRealizado(planoId, db);
  const r = await db.query('SELECT meta, realizado, data_limite FROM prod_planos WHERE id=$1', [planoId]);
  if (!r.rows.length) return;
  const p = r.rows[0];
  const meta = parseFloat(p.meta) || 0;
  const realizado = parseFloat(p.realizado) || 0;
  const pct = meta > 0 ? (realizado / meta) * 100 : 0;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const dl = p.data_limite ? new Date(p.data_limite) : null;
  let status = 'em_andamento';
  if (pct >= 100) status = 'concluido';
  else if (dl && dl < hoje) status = 'atrasado';
  await db.query('UPDATE prod_planos SET status=$1 WHERE id=$2', [status, planoId]);
}

/* Colunas garantidas por db/schema.js — nada de ALTER TABLE no import. */

// =====================================================
// PROD-PLANOS
// =====================================================

router.get('/prod-planos', requireAuth, async (req, res) => {
  try {
    const { mes } = req.query;
    await recalcRealizado();   // garante que a lista reflete exatamente os apontamentos
    // obs_qtd / ultima_obs: a tabela mostra o balão sem precisar de outra chamada
    let q = `SELECT p.*,
               (SELECT COUNT(*)::int FROM prod_plano_obs o WHERE o.plano_id = p.id) AS obs_qtd,
               (SELECT o.texto FROM prod_plano_obs o WHERE o.plano_id = p.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS ultima_obs
             FROM prod_planos p`;
    const params = [];
    if (mes) { params.push(mes); q += ' WHERE p.mes=$1'; }
    q += ' ORDER BY p.data_limite ASC NULLS LAST, p.id DESC';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /prod-planos', err);
    res.status(500).json({ error: 'Erro ao listar planos' });
  }
});

/* ───── Células (cadastro dentro do módulo Produção) ─────
   Mesma tabela `celulas` da administração. Aqui qualquer usuário de operação
   edita; o PCP só lê (bloqueado pelo middleware). Horas disponíveis por dia
   = operadores × horas_operador (padrão 7 h). */
router.get('/prod-celulas', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, (c.operadores * c.horas_operador) AS horas_dia,
              (SELECT COUNT(*)::int FROM prod_apontamentos_detalhados a WHERE a.celula = c.nome) AS apontamentos
         FROM celulas c ORDER BY c.nome`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao listar células' }); }
});

function camposCelula(b) {
  return {
    nome: (b.nome || '').trim(),
    categoria: (b.categoria || '').trim() || null,
    descricao: (b.descricao || '').trim() || null,
    operadores: Math.max(0, parseInt(b.operadores) || 0),
    horas_operador: parseFloat(b.horas_operador) > 0 ? parseFloat(b.horas_operador) : 7,
    turno: ['1', '2', '3'].includes(String(b.turno)) ? String(b.turno) : null,
    ativa: b.ativa !== false
  };
}

router.post('/prod-celulas', requireAuth, async (req, res) => {
  try {
    const c = camposCelula(req.body);
    if (!c.nome) return res.status(400).json({ error: 'Nome da célula obrigatório' });
    const r = await pool.query(
      `INSERT INTO celulas (nome, categoria, descricao, operadores, horas_operador, turno, ativa)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [c.nome, c.categoria, c.descricao, c.operadores, c.horas_operador, c.turno, c.ativa]);
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma célula com esse nome' });
    res.status(500).json({ error: 'Erro ao criar célula' });
  }
});

router.put('/prod-celulas/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const c = camposCelula(req.body);
    if (!c.nome) return res.status(400).json({ error: 'Nome da célula obrigatório' });
    await client.query('BEGIN');
    const antiga = await client.query('SELECT nome FROM celulas WHERE id=$1', [req.params.id]);
    if (!antiga.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Célula não encontrada' }); }
    const r = await client.query(
      `UPDATE celulas SET nome=$1, categoria=$2, descricao=$3, operadores=$4, horas_operador=$5, turno=$6, ativa=$7
       WHERE id=$8 RETURNING *`,
      [c.nome, c.categoria, c.descricao, c.operadores, c.horas_operador, c.turno, c.ativa, req.params.id]);
    // os apontamentos guardam o nome da célula: renomear acompanha
    if (antiga.rows[0].nome !== c.nome) {
      await client.query('UPDATE prod_apontamentos_detalhados SET celula=$1 WHERE celula=$2', [c.nome, antiga.rows[0].nome]);
    }
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma célula com esse nome' });
    res.status(500).json({ error: 'Erro ao atualizar célula' });
  } finally { client.release(); }
});

router.delete('/prod-celulas/:id', requireAuth, async (req, res) => {
  try {
    const c = await pool.query('SELECT nome FROM celulas WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Célula não encontrada' });
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM prod_apontamentos_detalhados WHERE celula=$1', [c.rows[0].nome]);
    if (n.rows[0].n > 0) return res.status(400).json({ error: `Esta célula tem ${n.rows[0].n} apontamento(s). Marque como inativa em vez de excluir.` });
    await pool.query('DELETE FROM celulas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir célula' }); }
});

/* ───── Observações do status do plano ───── */
router.get('/prod-planos/:id/observacoes', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, plano_id, texto, status_na_hora, autor_id, autor_nome, created_at
         FROM prod_plano_obs WHERE plano_id=$1 ORDER BY created_at DESC, id DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao listar observações' }); }
});

router.post('/prod-planos/:id/observacoes', requireAuth, async (req, res) => {
  try {
    const texto = (req.body.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'Escreva a observação' });
    await atualizarStatusPlano(req.params.id);   // o status gravado só muda em apontamentos; recalcula para registrar o atual
    const plano = await pool.query('SELECT status FROM prod_planos WHERE id=$1', [req.params.id]);
    if (!plano.rows.length) return res.status(404).json({ error: 'Plano não encontrado' });
    const u = await pool.query('SELECT nome, username FROM users WHERE id=$1', [req.session.userId]);
    const autor = u.rows[0] ? (u.rows[0].nome || u.rows[0].username) : null;
    const r = await pool.query(
      `INSERT INTO prod_plano_obs (plano_id, texto, status_na_hora, autor_id, autor_nome)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, texto, plano.rows[0].status, req.session.userId || null, autor]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar observação' }); }
});

/* Só o admin ou quem escreveu pode apagar */
router.delete('/prod-plano-obs/:id', requireAuth, async (req, res) => {
  try {
    const o = await pool.query('SELECT autor_id FROM prod_plano_obs WHERE id=$1', [req.params.id]);
    if (!o.rows.length) return res.status(404).json({ error: 'Não encontrada' });
    if (req.session.role !== 'admin' && o.rows[0].autor_id !== req.session.userId) {
      return res.status(403).json({ error: 'Só o administrador ou o autor pode excluir' });
    }
    await pool.query('DELETE FROM prod_plano_obs WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir observação' }); }
});

router.get('/prod-planos/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM prod_planos WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Plano não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /prod-planos/:id', err);
    res.status(500).json({ error: 'Erro ao buscar plano' });
  }
});

router.post('/prod-planos', requireAuth, async (req, res) => {
  try {
    const { data_limite, cod_decio, cod_intelbras, descricao, produto, meta, observacoes, num_op } = req.body;
    if (!data_limite) return res.status(400).json({ error: 'Data limite obrigatória' });
    if (!cod_decio) return res.status(400).json({ error: 'Código Décio obrigatório' });

    // Valida num_op se fornecido (opcional, mas se vier precisa ter 8 dígitos)
    let opFinal = null;
    if (num_op && String(num_op).trim() !== '') {
      if (!validarDigitos(num_op, 8)) {
        return res.status(400).json({ error: 'N° OP deve ter exatos 8 dígitos numéricos' });
      }
      opFinal = String(num_op).trim();
    }

    const mes = mesDaData(data_limite);
    const prod = produto || descricao || cod_decio;
    const r = await pool.query(
      `INSERT INTO prod_planos (mes, data_limite, cod_decio, cod_intelbras, descricao, produto, meta, observacoes, num_op, realizado, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'em_andamento') RETURNING *`,
      [mes, data_limite, cod_decio, cod_intelbras || null, descricao || null, prod, meta || 0, observacoes || null, opFinal]
    );
    await atualizarStatusPlano(r.rows[0].id);
    const final = await pool.query('SELECT * FROM prod_planos WHERE id=$1', [r.rows[0].id]);
    res.json(final.rows[0]);
  } catch (err) {
    console.error('POST /prod-planos', err);
    res.status(500).json({ error: 'Erro ao criar plano' });
  }
});

router.put('/prod-planos/:id', requireAuth, async (req, res) => {
  try {
    const { data_limite, cod_decio, cod_intelbras, descricao, produto, meta, observacoes, num_op } = req.body;

    // Valida num_op se fornecido
    let opFinal;
    if (num_op === undefined || num_op === null) {
      opFinal = undefined; // não mexe
    } else if (String(num_op).trim() === '') {
      opFinal = null; // limpa a OP
    } else {
      if (!validarDigitos(num_op, 8)) {
        return res.status(400).json({ error: 'N° OP deve ter exatos 8 dígitos numéricos' });
      }
      opFinal = String(num_op).trim();
    }

    const mes = data_limite ? mesDaData(data_limite) : null;
    const prod = produto || descricao || cod_decio;
    await pool.query(
      `UPDATE prod_planos
       SET data_limite=COALESCE($1,data_limite),
           mes=COALESCE($2,mes),
           cod_decio=COALESCE($3,cod_decio),
           cod_intelbras=COALESCE($4,cod_intelbras),
           descricao=COALESCE($5,descricao),
           produto=COALESCE($6,produto),
           meta=COALESCE($7,meta),
           observacoes=COALESCE($8,observacoes),
           num_op = CASE WHEN $10::boolean THEN $9 ELSE num_op END
       WHERE id=$11`,
      [
        data_limite || null, mes, cod_decio || null, cod_intelbras || null,
        descricao || null, prod || null, meta ?? null, observacoes || null,
        opFinal === undefined ? null : opFinal,
        opFinal !== undefined,
        req.params.id
      ]
    );
    await atualizarStatusPlano(req.params.id);
    const r = await pool.query('SELECT * FROM prod_planos WHERE id=$1', [req.params.id]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /prod-planos/:id', err);
    res.status(500).json({ error: 'Erro ao atualizar plano' });
  }
});

router.delete('/prod-planos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM prod_planos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /prod-planos/:id', err);
    res.status(500).json({ error: 'Erro ao excluir plano' });
  }
});

// =====================================================
// PROD-APONTAMENTOS (simples)
// =====================================================

router.get('/prod-apontamentos', requireAuth, async (req, res) => {
  try {
    const { plano_id, mes } = req.query;
    let q = `SELECT a.*, p.mes, p.cod_decio, p.cod_intelbras, p.descricao
             FROM prod_apontamentos a LEFT JOIN prod_planos p ON p.id = a.plano_id`;
    const params = [];
    const where = [];
    if (plano_id) { params.push(plano_id); where.push(`a.plano_id=$${params.length}`); }
    if (mes) { params.push(mes); where.push(`p.mes=$${params.length}`); }
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY a.data DESC, a.id DESC';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /prod-apontamentos', err);
    res.status(500).json({ error: 'Erro ao listar apontamentos' });
  }
});

router.post('/prod-apontamentos', requireAuth, async (req, res) => {
  try {
    const { plano_id, data, quantidade, observacoes } = req.body;
    if (!plano_id) return res.status(400).json({ error: 'Plano obrigatório' });
    const r = await pool.query(
      `INSERT INTO prod_apontamentos (plano_id, data, quantidade, observacoes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [plano_id, data || new Date(), quantidade || 0, observacoes || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('POST /prod-apontamentos', err);
    res.status(500).json({ error: 'Erro ao criar apontamento' });
  }
});

router.delete('/prod-apontamentos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM prod_apontamentos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /prod-apontamentos/:id', err);
    res.status(500).json({ error: 'Erro ao excluir apontamento' });
  }
});

// =====================================================
// PROD-APONTAMENTOS-DETALHADOS
// =====================================================

router.get('/prod-apontamentos-detalhados', requireAuth, async (req, res) => {
  try {
    const { data_ini, data_fim, turno, celula, num_op, cod_decio, mes } = req.query;
    const params = [];
    const where = [];
    if (data_ini) { params.push(data_ini); where.push(`data_execucao >= $${params.length}`); }
    if (data_fim) { params.push(data_fim); where.push(`data_execucao <= $${params.length}`); }
    if (turno) { params.push(turno); where.push(`turno = $${params.length}`); }
    if (celula) { params.push(celula); where.push(`celula = $${params.length}`); }
    if (num_op) { params.push(num_op); where.push(`num_op = $${params.length}`); }
    if (cod_decio) { params.push(cod_decio); where.push(`cod_decio = $${params.length}`); }
    if (mes) { params.push(mes); where.push(`to_char(data_execucao,'YYYY-MM') = $${params.length}`); }
    let q = 'SELECT * FROM prod_apontamentos_detalhados';
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY data_execucao DESC, id DESC';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /prod-apontamentos-detalhados', err);
    res.status(500).json({ error: 'Erro ao listar apontamentos detalhados' });
  }
});

router.get('/prod-apontamentos-detalhados/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM prod_apontamentos_detalhados WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Apontamento não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /prod-apontamentos-detalhados/:id', err);
    res.status(500).json({ error: 'Erro ao buscar apontamento' });
  }
});

// 🔧 POST: vincula o apontamento ao plano com mesma OP
router.post('/prod-apontamentos-detalhados', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    let {
      data_execucao, turno, celula, num_op, serie_inicial, serie_final,
      cod_decio, cod_intelbras, descricao, categoria,
      meta, realizado, hora_reportada_total, observacoes
    } = req.body;

    if (serie_inicial) serie_inicial = String(serie_inicial).trim().toUpperCase();
    if (serie_final) serie_final = String(serie_final).trim().toUpperCase();

    if (!data_execucao) return res.status(400).json({ error: 'Data de execução obrigatória' });
    if (!turno) return res.status(400).json({ error: 'Turno obrigatório' });
    if (!celula) return res.status(400).json({ error: 'Célula obrigatória' });
    if (!validarDigitos(num_op, 8)) return res.status(400).json({ error: 'N° OP deve ter exatos 8 dígitos numéricos' });
    if (!validarAlfanumerico(serie_inicial, 13)) return res.status(400).json({ error: 'N° Série Inicial deve ter exatos 13 caracteres (letras/números)' });
    if (!validarAlfanumerico(serie_final, 13)) return res.status(400).json({ error: 'N° Série Final deve ter exatos 13 caracteres (letras/números)' });
    if (!cod_decio) return res.status(400).json({ error: 'Código Décio obrigatório' });

    // 🔍 Busca o plano pela OP (vinculação direta por número da ordem de produção)
    const planoRes = await client.query(
      'SELECT id FROM prod_planos WHERE num_op = $1 LIMIT 1',
      [num_op]
    );

    if (!planoRes.rows.length) {
      return res.status(400).json({
        error: `OP ${num_op} não cadastrada no plano mensal. Cadastre o plano com essa OP antes de fazer o apontamento.`
      });
    }

    const planoId = planoRes.rows[0].id;

    await client.query('BEGIN');

    const r = await client.query(
      `INSERT INTO prod_apontamentos_detalhados
       (data_execucao, turno, celula, num_op, serie_inicial, serie_final,
        cod_decio, cod_intelbras, descricao, categoria,
        meta, realizado, hora_reportada_total, observacoes, plano_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        data_execucao, turno, celula, num_op, serie_inicial, serie_final,
        cod_decio, cod_intelbras || null, descricao || null, categoria || null,
        meta || 0, realizado || 0, hora_reportada_total || 0,
        observacoes || null, planoId
      ]
    );

    await atualizarStatusPlano(planoId, client);   // recalcula o realizado pela soma dos apontamentos

    await client.query('COMMIT');
    res.json({ ...r.rows[0], plano_encontrado: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /prod-apontamentos-detalhados', err);
    res.status(500).json({ error: 'Erro ao criar apontamento detalhado' });
  } finally {
    client.release();
  }
});

/* Editar apontamento: tira o realizado antigo do plano antigo e soma o novo
   no plano da OP informada (que pode ser outra). */
router.put('/prod-apontamentos-detalhados/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    let {
      data_execucao, turno, celula, num_op, serie_inicial, serie_final,
      cod_decio, cod_intelbras, descricao, categoria,
      meta, realizado, hora_reportada_total, observacoes
    } = req.body;
    if (serie_inicial) serie_inicial = String(serie_inicial).trim().toUpperCase();
    if (serie_final) serie_final = String(serie_final).trim().toUpperCase();

    if (!data_execucao) return res.status(400).json({ error: 'Data de execução obrigatória' });
    if (!turno) return res.status(400).json({ error: 'Turno obrigatório' });
    if (!celula) return res.status(400).json({ error: 'Célula obrigatória' });
    if (!validarDigitos(num_op, 8)) return res.status(400).json({ error: 'N° OP deve ter exatos 8 dígitos numéricos' });
    if (!validarAlfanumerico(serie_inicial, 13)) return res.status(400).json({ error: 'N° Série Inicial deve ter exatos 13 caracteres (letras/números)' });
    if (!validarAlfanumerico(serie_final, 13)) return res.status(400).json({ error: 'N° Série Final deve ter exatos 13 caracteres (letras/números)' });
    if (!cod_decio) return res.status(400).json({ error: 'Código Décio obrigatório' });

    const planoRes = await client.query('SELECT id FROM prod_planos WHERE num_op = $1 LIMIT 1', [num_op]);
    if (!planoRes.rows.length) {
      return res.status(400).json({ error: `OP ${num_op} não cadastrada no plano mensal.` });
    }
    const novoPlano = planoRes.rows[0].id;

    await client.query('BEGIN');
    const ap = await client.query('SELECT * FROM prod_apontamentos_detalhados WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!ap.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Apontamento não encontrado' });
    }
    const antigo = ap.rows[0];

    const r = await client.query(
      `UPDATE prod_apontamentos_detalhados SET
         data_execucao=$1, turno=$2, celula=$3, num_op=$4, serie_inicial=$5, serie_final=$6,
         cod_decio=$7, cod_intelbras=$8, descricao=$9, categoria=$10,
         meta=$11, realizado=$12, hora_reportada_total=$13, observacoes=$14, plano_id=$15
       WHERE id=$16 RETURNING *`,
      [data_execucao, turno, celula, num_op, serie_inicial, serie_final,
       cod_decio, cod_intelbras || null, descricao || null, categoria || null,
       meta || 0, realizado || 0, hora_reportada_total || 0, observacoes || null, novoPlano, req.params.id]
    );
    await atualizarStatusPlano(novoPlano, client);
    if (antigo.plano_id && antigo.plano_id !== novoPlano) await atualizarStatusPlano(antigo.plano_id, client);

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /prod-apontamentos-detalhados/:id', err);
    res.status(500).json({ error: 'Erro ao atualizar apontamento' });
  } finally {
    client.release();
  }
});

router.delete('/prod-apontamentos-detalhados/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ap = await client.query('SELECT * FROM prod_apontamentos_detalhados WHERE id=$1', [req.params.id]);
    if (!ap.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Apontamento não encontrado' });
    }
    const a = ap.rows[0];
    await client.query('DELETE FROM prod_apontamentos_detalhados WHERE id=$1', [req.params.id]);
    if (a.plano_id) await atualizarStatusPlano(a.plano_id, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /prod-apontamentos-detalhados/:id', err);
    res.status(500).json({ error: 'Erro ao excluir apontamento' });
  } finally {
    client.release();
  }
});

module.exports = router;
