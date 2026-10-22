const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

function styleHeader(sheet) {
  if (!sheet) return;
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C4984' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 25;
}

// GET /api/export/:modulo
router.get('/:modulo', requireAuth, async (req, res) => {
  const modulo = req.params.modulo;

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Décio — Sistema Integrado da Montagem';
    workbook.created = new Date();
    let sheet;

    // ── COLABORADORES ──
    if (modulo === 'colaboradores') {
      sheet = workbook.addWorksheet('Colaboradores');
      sheet.columns = [
        { header:'ID', key:'id', width:8 },
        { header:'Nome', key:'nome', width:30 },
        { header:'Matricula', key:'mat', width:15 },
        { header:'Cargo', key:'cargo', width:20 },
        { header:'Setor', key:'setor', width:20 },
        { header:'Turno', key:'turno', width:15 },
        { header:'Status', key:'status', width:12 },
        { header:'Admissao', key:'dt_admissao', width:12 },
        { header:'Desligamento', key:'dt_desligamento', width:14 }
      ];
      (await pool.query('SELECT * FROM colaboradores ORDER BY nome')).rows.forEach(r => sheet.addRow(r));
    }

    // ── FERRAMENTAS ──
    else if (modulo === 'ferramentas') {
      sheet = workbook.addWorksheet('Ferramentas');
      sheet.columns = [
        { header:'Codigo', key:'cod', width:12 },
        { header:'Nome', key:'nome', width:30 },
        { header:'Categoria', key:'cat', width:18 },
        { header:'Localizacao', key:'loc', width:25 },
        { header:'Status', key:'status', width:15 },
        { header:'Calibracao', key:'cal', width:14 },
        { header:'Preventiva', key:'prev', width:14 },
        { header:'Obs', key:'obs', width:30 }
      ];
      (await pool.query('SELECT * FROM ferramentas ORDER BY nome')).rows.forEach(r => sheet.addRow(r));
    }

    // ── CHECKLISTS DE FERRAMENTAS (conferências) ──
    else if (modulo === 'ferr-checklists') {
      const NOME = { ok:'OK', problema:'Com problema', nao_encontrada:'Nao encontrada', pendente:'Nao conferida' };
      sheet = workbook.addWorksheet('Conferencias');
      sheet.columns = [
        { header:'ID', key:'id', width:8 },
        { header:'Data', key:'data', width:14 },
        { header:'Hora', key:'hora', width:10 },
        { header:'Turno', key:'turno', width:12 },
        { header:'Responsavel', key:'responsavel_nome', width:25 },
        { header:'Total', key:'total', width:8 },
        { header:'OK', key:'ok', width:8 },
        { header:'Com problema', key:'problema', width:14 },
        { header:'Nao encontradas', key:'nao_encontrada', width:16 },
        { header:'Nao conferidas', key:'pendente', width:15 },
        { header:'Obs', key:'obs', width:40 }
      ];
      (await pool.query('SELECT * FROM ferr_checklists ORDER BY data DESC, hora DESC')).rows.forEach(r => sheet.addRow(r));

      const itens = workbook.addWorksheet('Itens');
      itens.columns = [
        { header:'Conferencia (ID)', key:'checklist_id', width:16 },
        { header:'Data', key:'data', width:14 },
        { header:'Hora', key:'hora', width:10 },
        { header:'Codigo', key:'cod', width:12 },
        { header:'Ferramenta', key:'nome', width:30 },
        { header:'Localizacao', key:'loc', width:22 },
        { header:'Status na hora', key:'status_ferr', width:15 },
        { header:'Situacao', key:'situacao', width:16 },
        { header:'Obs', key:'obs', width:40 }
      ];
      (await pool.query(`SELECT i.*, c.data, c.hora FROM ferr_checklist_itens i
                         JOIN ferr_checklists c ON c.id = i.checklist_id
                         ORDER BY c.data DESC, c.hora DESC, i.cod`)).rows
        .forEach(r => itens.addRow({ ...r, situacao: NOME[r.situacao] || r.situacao }));
      styleHeader(itens);
    }

    // ── ADVERTÊNCIAS ──
    else if (modulo === 'advertencias') {
      sheet = workbook.addWorksheet('Advertencias');
      sheet.columns = [
        { header:'Data', key:'data', width:12 },
        { header:'Colaborador', key:'colab', width:30 },
        { header:'Tipo', key:'tipo', width:12 },
        { header:'Dias suspensao', key:'dias_suspensao', width:14 },
        { header:'Motivo', key:'motivo', width:30 },
        { header:'Descricao', key:'descricao', width:50 },
        { header:'Aplicada por', key:'aplicada_por', width:25 },
        { header:'Testemunhas', key:'testemunhas', width:30 },
        { header:'Assinou', key:'assinou', width:10 },
        { header:'Obs', key:'obs', width:30 }
      ];
      (await pool.query(`
        SELECT to_char(a.data,'DD/MM/YYYY') data, COALESCE(c.nome, a.colaborador_nome) colab, a.tipo, a.dias_suspensao,
               a.motivo, a.descricao, a.aplicada_por, a.testemunhas,
               CASE WHEN a.assinou IS TRUE THEN 'Sim' WHEN a.assinou IS FALSE THEN 'Recusou' ELSE '' END assinou, a.obs
          FROM tr_advertencias a LEFT JOIN colaboradores c ON c.id=a.colaborador_id
         ORDER BY a.data DESC`)).rows.forEach(r => sheet.addRow(r));
    }

    // ── LIMPEZA ──
    else if (modulo === 'limpeza') {
      sheet = workbook.addWorksheet('Limpezas feitas');
      sheet.columns = [
        { header:'Data', key:'feito_em', width:12 },
        { header:'Hora', key:'feito_hora', width:8 },
        { header:'Item', key:'item', width:30 },
        { header:'Local', key:'local', width:22 },
        { header:'Quem fez', key:'quem', width:28 },
        { header:'Obs', key:'obs', width:40 }
      ];
      (await pool.query(`
        SELECT to_char(a.feito_em,'DD/MM/YYYY') feito_em, to_char(a.feito_hora,'HH24:MI') feito_hora,
               i.nome item, i.local, COALESCE(f.nome, c.nome) quem, a.obs
          FROM lp_agenda a JOIN lp_itens i ON i.id=a.item_id
          LEFT JOIN colaboradores c ON c.id=a.colaborador_id
          LEFT JOIN colaboradores f ON f.id=a.feito_por_id
         WHERE a.status='feito' ORDER BY a.feito_em DESC, a.feito_hora DESC`)).rows.forEach(r => sheet.addRow(r));

      const it = workbook.addWorksheet('Itens');
      it.columns = [
        { header:'Item', key:'nome', width:30 }, { header:'Local', key:'local', width:22 },
        { header:'Frequencia', key:'freq', width:16 }, { header:'Aviso (dias)', key:'aviso_dias', width:12 },
        { header:'Responsavel', key:'responsavel', width:28 }, { header:'Ultima', key:'ultima', width:12 },
        { header:'Ativo', key:'ativo', width:8 }, { header:'Descricao', key:'descricao', width:40 }
      ];
      (await pool.query(`
        SELECT i.nome, i.local, i.freq_qtd || ' ' || i.freq_tipo freq, i.aviso_dias, c.nome responsavel,
               to_char((SELECT MAX(feito_em) FROM lp_agenda a WHERE a.item_id=i.id AND a.status='feito'),'DD/MM/YYYY') ultima,
               CASE WHEN i.ativo THEN 'Sim' ELSE 'Nao' END ativo, i.descricao
          FROM lp_itens i LEFT JOIN colaboradores c ON c.id=i.responsavel_id ORDER BY i.nome`)).rows.forEach(r => it.addRow(r));
      styleHeader(it);
    }

    // ── EMPRESTIMOS ──
    else if (modulo === 'emprestimos') {
      sheet = workbook.addWorksheet('Emprestimos');
      sheet.columns = [
        { header:'Ferramenta', key:'ferr_nome', width:25 },
        { header:'Codigo', key:'ferr_cod', width:12 },
        { header:'Colaborador', key:'colab_nome', width:25 },
        { header:'Retirada', key:'dt', width:20 },
        { header:'Devolucao', key:'dev_dt', width:20 },
        { header:'Status', key:'status_text', width:12 },
        { header:'Obs', key:'obs', width:25 }
      ];
      const rows = (await pool.query(`
        SELECT e.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as colab_nome
        FROM emprestimos e JOIN ferramentas f ON e.ferramenta_id=f.id
        JOIN colaboradores c ON e.colaborador_id=c.id ORDER BY e.dt DESC
      `)).rows;
      rows.forEach(r => { r.status_text = r.devolvido ? 'Devolvido' : 'Pendente'; sheet.addRow(r); });
    }

    // ── MANUTENCOES ──
    else if (modulo === 'manutencoes') {
      sheet = workbook.addWorksheet('Manutencoes');
      sheet.columns = [
        { header:'Ferramenta', key:'ferr_nome', width:25 },
        { header:'Codigo', key:'ferr_cod', width:12 },
        { header:'Tipo', key:'tipo', width:15 },
        { header:'Responsavel', key:'resp_nome', width:25 },
        { header:'Envio', key:'env', width:14 },
        { header:'Retorno', key:'ret', width:14 },
        { header:'Descricao', key:'descricao', width:40 }
      ];
      const rows = (await pool.query(`
        SELECT m.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as resp_nome
        FROM manutencoes m JOIN ferramentas f ON m.ferramenta_id=f.id
        LEFT JOIN colaboradores c ON m.responsavel_id=c.id ORDER BY m.created_at DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── EPIs ──
    else if (modulo === 'epis') {
      sheet = workbook.addWorksheet('EPIs');
      sheet.columns = [
        { header:'Nome', key:'nome', width:30 },
        { header:'Durabilidade Qtd', key:'dur_qtd', width:15 },
        { header:'Durabilidade Tipo', key:'dur_tipo', width:15 },
        { header:'Descricao', key:'descricao', width:40 }
      ];
      (await pool.query('SELECT * FROM epis ORDER BY nome')).rows.forEach(r => sheet.addRow(r));
    }

    // ── EPI ENTREGAS ──
    else if (modulo === 'epi-entregas') {
      sheet = workbook.addWorksheet('Entregas EPIs');
      sheet.columns = [
        { header:'EPI', key:'epi_nome', width:25 },
        { header:'Colaborador', key:'colab_nome', width:25 },
        { header:'Qtd', key:'qtd', width:8 },
        { header:'Entrega', key:'dt', width:20 },
        { header:'Validade', key:'validade', width:14 },
        { header:'Motivo', key:'motivo', width:25 },
        { header:'Obs', key:'obs', width:25 }
      ];
      const rows = (await pool.query(`
        SELECT ee.*, ep.nome as epi_nome, c.nome as colab_nome
        FROM epi_entregas ee JOIN epis ep ON ee.epi_id=ep.id
        JOIN colaboradores c ON ee.colaborador_id=c.id ORDER BY ee.dt DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── BH LANCAMENTOS ──
    else if (modulo === 'bh-lancamentos') {
      sheet = workbook.addWorksheet('Lancamentos BH');
      sheet.columns = [
        { header:'Colaborador', key:'colab_nome', width:25 },
        { header:'Tipo', key:'tipo', width:12 },
        { header:'Minutos', key:'minutos', width:10 },
        { header:'Data', key:'data', width:14 },
        { header:'Motivo', key:'motivo', width:20 },
        { header:'Justificativa', key:'justificativa', width:35 }
      ];
      const rows = (await pool.query(`
        SELECT l.*, c.nome as colab_nome FROM bh_lancamentos l
        JOIN colaboradores c ON l.colaborador_id=c.id ORDER BY l.data DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── BH CONVITES ──
    else if (modulo === 'bh-convites') {
      sheet = workbook.addWorksheet('Convites BH');
      sheet.columns = [
        { header:'Colaborador', key:'colab_nome', width:25 },
        { header:'Data Convite', key:'data', width:14 },
        { header:'Data Proposta', key:'data_banco', width:14 },
        { header:'Resposta', key:'resposta', width:15 },
        { header:'Obs', key:'obs', width:30 }
      ];
      const rows = (await pool.query(`
        SELECT cv.*, c.nome as colab_nome FROM bh_convites cv
        JOIN colaboradores c ON cv.colaborador_id=c.id ORDER BY cv.data DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── BH ATRASOS ──
    else if (modulo === 'bh-atrasos') {
      sheet = workbook.addWorksheet('Atrasos');
      sheet.columns = [
        { header:'Colaborador', key:'colab_nome', width:25 },
        { header:'Data', key:'data', width:14 },
        { header:'Ponto', key:'ponto', width:10 },
        { header:'Linha', key:'linha', width:10 },
        { header:'Diff (min)', key:'diff', width:10 },
        { header:'Motivo', key:'motivo', width:20 },
        { header:'Obs', key:'obs', width:25 }
      ];
      const rows = (await pool.query(`
        SELECT a.*, c.nome as colab_nome FROM bh_atrasos a
        JOIN colaboradores c ON a.colaborador_id=c.id ORDER BY a.data DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── TREINAMENTOS ──
    else if (modulo === 'treinamentos') {
      sheet = workbook.addWorksheet('Treinamentos');
      sheet.columns = [
        { header:'Nome', key:'nome', width:30 },
        { header:'Categoria', key:'categoria', width:15 },
        { header:'Carga Horaria', key:'carga_horaria', width:14 },
        { header:'Validade (meses)', key:'validade_meses', width:15 },
        { header:'Descricao', key:'descricao', width:40 }
      ];
      (await pool.query('SELECT * FROM treinamentos ORDER BY nome')).rows.forEach(r => sheet.addRow(r));
    }

    // ── TR REGISTROS ──
    else if (modulo === 'tr-registros') {
      sheet = workbook.addWorksheet('Registros Treinamentos');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Colaborador', key:'colab_nome', width:25 },
        { header:'Treinamento', key:'treino_nome', width:30 },
        { header:'Validade', key:'validade', width:14 },
        { header:'Instrutor', key:'instrutor', width:20 },
        { header:'Local', key:'local_treino', width:20 },
        { header:'Obs', key:'obs', width:30 }
      ];
      const rows = (await pool.query(`
        SELECT r.*, c.nome as colab_nome, t.nome as treino_nome
        FROM tr_registros r JOIN colaboradores c ON r.colaborador_id=c.id
        JOIN treinamentos t ON r.treinamento_id=t.id ORDER BY r.data DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── DIARIO ──
    else if (modulo === 'diario') {
      sheet = workbook.addWorksheet('Diario de Bordo');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Hora', key:'hora', width:10 },
        { header:'Turno', key:'turno', width:12 },
        { header:'Categoria', key:'categoria', width:22 },
        { header:'Prioridade', key:'prioridade', width:12 },
        { header:'Status', key:'status', width:12 },
        { header:'Descricao', key:'descricao', width:45 },
        { header:'Acao Tomada', key:'acao', width:35 }
      ];
      (await pool.query('SELECT * FROM db_registros ORDER BY data DESC, hora DESC NULLS LAST')).rows.forEach(r => sheet.addRow(r));
    }

    // ── DB RESUMOS ──
    else if (modulo === 'db-resumos') {
      sheet = workbook.addWorksheet('Resumos');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Turno', key:'turno', width:12 },
        { header:'Texto', key:'texto', width:60 },
        { header:'Obs', key:'obs', width:40 }
      ];
      (await pool.query('SELECT * FROM db_resumos ORDER BY data DESC')).rows.forEach(r => sheet.addRow(r));
    }

    // ── CL ATIVIDADES ──
    else if (modulo === 'cl-atividades') {
      sheet = workbook.addWorksheet('Atividades Checklist');
      sheet.columns = [
        { header:'Nome', key:'nome', width:30 },
        { header:'Frequencia', key:'freq', width:15 },
        { header:'Inicio', key:'inicio', width:14 },
        { header:'Status', key:'status', width:12 },
        { header:'Descricao', key:'descricao', width:40 }
      ];
      (await pool.query('SELECT * FROM cl_atividades ORDER BY nome')).rows.forEach(r => sheet.addRow(r));
    }

    // ── CL EXECUCOES ──
    else if (modulo === 'cl-execucoes') {
      sheet = workbook.addWorksheet('Execucoes Checklist');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Atividade', key:'ativ_nome', width:30 },
        { header:'Frequencia', key:'ativ_freq', width:15 },
        { header:'Hora', key:'hora', width:10 }
      ];
      const rows = (await pool.query(`
        SELECT e.*, a.nome as ativ_nome, a.freq as ativ_freq
        FROM cl_execucoes e JOIN cl_atividades a ON e.atividade_id=a.id
        ORDER BY e.data DESC, e.hora DESC NULLS LAST
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }


    // ── PONTO NFC ──
    else if (modulo === 'ponto') {
      sheet = workbook.addWorksheet('Registros de Ponto');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Hora', key:'hora', width:12 },
        { header:'Colaborador', key:'nome', width:34 },
        { header:'Tipo', key:'tipo', width:12 },
        { header:'Turno', key:'turno_nome', width:14 },
        { header:'Origem', key:'origem', width:10 },
        { header:'UID Cracha', key:'cracha_uid', width:18 },
        { header:'Observacao', key:'observacao', width:30 }
      ];
      const { data_ini, data_fim, turno_id } = req.query;
      const where = []; const params = [];
      if (data_ini) { params.push(data_ini); where.push(`p.data >= $${params.length}`); }
      if (data_fim) { params.push(data_fim); where.push(`p.data <= $${params.length}`); }
      if (turno_id) { params.push(turno_id); where.push(`p.turno_id = $${params.length}`); }
      let q = `SELECT p.*, t.nome AS turno_nome FROM ponto_registros p
               LEFT JOIN turnos t ON t.id = p.turno_id`;
      if (where.length) q += ' WHERE ' + where.join(' AND ');
      q += ' ORDER BY p.data DESC, p.hora DESC';
      (await pool.query(q, params)).rows.forEach(r => sheet.addRow(r));
    }

    // ── CRACHAS NFC ──
    else if (modulo === 'crachas') {
      sheet = workbook.addWorksheet('Crachas NFC');
      sheet.columns = [
        { header:'UID', key:'uid', width:20 },
        { header:'Colaborador', key:'colab_nome', width:34 },
        { header:'Matricula', key:'mat', width:14 },
        { header:'Turno', key:'colab_turno', width:14 },
        { header:'Ativo', key:'ativo', width:10 }
      ];
      const rows = (await pool.query(`
        SELECT c.uid, c.ativo, COALESCE(col.nome, c.nome_cache) AS colab_nome, col.mat, col.turno AS colab_turno
        FROM ponto_crachas c LEFT JOIN colaboradores col ON col.id = c.colaborador_id
        ORDER BY colab_nome
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── CADENCIADOR: takt times ──
    else if (modulo === 'takt') {
      sheet = workbook.addWorksheet('Takt Times');
      sheet.columns = [
        { header:'Produto', key:'nome', width:38 },
        { header:'Cod. Decio', key:'cod_decio', width:16 },
        { header:'Takt padrao (min)', key:'takt_padrao', width:18 },
        { header:'Celula', key:'celula_nome', width:18 },
        { header:'Ativo', key:'ativo', width:10 }
      ];
      const rows = (await pool.query(`
        SELECT p.nome, p.cod_decio, p.takt_min::float AS takt_padrao, c.nome AS celula_nome, p.ativo
        FROM cad_produtos p LEFT JOIN celulas c ON c.id = p.celula_id
        ORDER BY p.ordem, p.nome
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── CADENCIADOR: ciclos de uma sessao ──
    else if (modulo === 'ciclos') {
      sheet = workbook.addWorksheet('Ciclos');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Turno', key:'turno_nome', width:14 },
        { header:'Produto', key:'produto_nome', width:34 },
        { header:'Takt (min)', key:'takt_min', width:12 },
        { header:'Ciclo', key:'numero', width:10 },
        { header:'Horario previsto', key:'hora_prevista', width:18 },
        { header:'Status', key:'status_txt', width:18 },
        { header:'Observacao', key:'observacao', width:34 }
      ];
      const { sessao_id, data } = req.query;
      const params = []; const where = [];
      if (sessao_id) { params.push(sessao_id); where.push(`s.id = $${params.length}`); }
      if (data) { params.push(data); where.push(`s.data = $${params.length}`); }
      let q = `SELECT s.data, t.nome AS turno_nome, p.nome AS produto_nome, s.takt_min::float,
                      ci.numero, ci.hora_prevista, ci.concluido, ci.observacao
               FROM cad_ciclos ci
               JOIN cad_sessoes s ON s.id = ci.sessao_id
               JOIN turnos t ON t.id = s.turno_id
               JOIN cad_produtos p ON p.id = s.produto_id`;
      if (where.length) q += ' WHERE ' + where.join(' AND ');
      q += ' ORDER BY s.data DESC, t.ordem, p.nome, ci.numero';
      (await pool.query(q, params)).rows.forEach(r => {
        sheet.addRow({ ...r, status_txt: r.concluido ? 'CONCLUIDO' : 'NAO CONCLUIDO' });
      });
    }

    // ── CADENCIADOR: paradas de linha ──
    else if (modulo === 'paradas') {
      sheet = workbook.addWorksheet('Paradas de Linha');
      sheet.columns = [
        { header:'Data', key:'data', width:14 },
        { header:'Turno', key:'turno_nome', width:14 },
        { header:'Produto', key:'produto_nome', width:34 },
        { header:'Inicio', key:'inicio', width:22 },
        { header:'Fim', key:'fim', width:22 },
        { header:'Duracao (min)', key:'duracao_min', width:15 },
        { header:'Motivo', key:'motivo', width:34 }
      ];
      const rows = (await pool.query(`
        SELECT s.data, t.nome AS turno_nome, p.nome AS produto_nome,
               pa.inicio, pa.fim, ROUND(pa.duracao_seg/60.0, 2)::float AS duracao_min, pa.motivo
        FROM cad_paradas pa
        JOIN cad_sessoes s ON s.id = pa.sessao_id
        JOIN turnos t ON t.id = s.turno_id
        JOIN cad_produtos p ON p.id = s.produto_id
        ORDER BY pa.inicio DESC
      `)).rows;
      rows.forEach(r => sheet.addRow(r));
    }

    // ── CONTADOR POR CÂMERA (eventos do dia) ──
    else if (modulo === 'contador') {
      sheet = workbook.addWorksheet('Contador');
      sheet.columns = [
        { header:'Data', key:'data', width:12 },
        { header:'Hora', key:'hora', width:10 },
        { header:'Celula', key:'celula', width:18 },
        { header:'Produto', key:'produto', width:24 },
        { header:'Turno', key:'turno', width:12 },
        { header:'Takt (min)', key:'takt', width:11 },
        { header:'Origem', key:'origem', width:16 },
        { header:'Valor', key:'valor', width:8 },
        { header:'Acumulado', key:'acum', width:11 },
        { header:'Intervalo (min)', key:'intervalo', width:15 },
        { header:'x Takt', key:'xtakt', width:9 },
        { header:'Mudanca (%)', key:'mudanca', width:12 },
        { header:'Dispositivo', key:'disp', width:28 },
        { header:'Usuario', key:'usuario', width:20 }
      ];
      const params = [], where = [];
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.data || ''))) { params.push(req.query.data); where.push(`(e.ts AT TIME ZONE '${Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'}')::date = $${params.length}::date`); }
      if (req.query.celula) { params.push(req.query.celula); where.push(`e.celula = $${params.length}`); }
      const rows = (await pool.query(
        `SELECT e.celula, e.ts, e.origem, e.valor, e.mudanca_pct, e.dispositivo, u.nome AS usuario,
                s.takt_min::float AS takt, p.nome AS produto, t.nome AS turno
           FROM cont_eventos e LEFT JOIN users u ON u.id = e.usuario_id
           LEFT JOIN cad_sessoes s ON s.id = e.sessao_id LEFT JOIN cad_produtos p ON p.id = s.produto_id LEFT JOIN turnos t ON t.id = s.turno_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.celula, e.ts`, params)).rows;
      const ORIG = { ia:'Camera: colocada', ia_retirada:'Camera: retirada', manual_mais:'+1 manual', manual_menos:'-1 manual', troca_pallet:'Troca de pallet', estorno:'Estorno automatico' };
      let cel = null, acum = 0, ant = null;
      rows.forEach(r => {
        const dia = new Date(r.ts); const diaStr = dia.toLocaleDateString('pt-BR');
        if (cel !== r.celula + diaStr) { cel = r.celula + diaStr; acum = 0; ant = null; }
        acum += r.valor;
        let intervalo = null;
        if (r.valor > 0) { if (ant) intervalo = Math.round((dia - ant) / 600) / 100; ant = dia; }
        sheet.addRow({ data: diaStr, hora: dia.toLocaleTimeString('pt-BR'), celula: r.celula, produto: r.produto || '', turno: r.turno || '',
          takt: r.takt, origem: ORIG[r.origem] || r.origem, valor: r.valor, acum, intervalo,
          xtakt: intervalo != null && r.takt ? Math.round(intervalo / r.takt * 100) / 100 : null,
          mudanca: r.mudanca_pct != null ? Number(r.mudanca_pct) : null, disp: r.dispositivo || '', usuario: r.usuario || '' });
      });
    }

    else {
      return res.status(400).json({ error: 'Modulo invalido: ' + modulo });
    }

    styleHeader(sheet);

    const filename = `decio_${modulo}_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
