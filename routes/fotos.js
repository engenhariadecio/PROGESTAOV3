const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ENTIDADES, LIMITES, lerDataURL } = require('../lib/fotos');

/*
 * GET    /api/fotos/arquivo/:id           imagem (use ?mini=1 para a miniatura)
 * DELETE /api/fotos/arquivo/:id           remove uma foto
 * GET    /api/fotos/:entidade             { registro_id: [ids das fotos] } — para as listagens
 * GET    /api/fotos/:entidade/:registro   metadados das fotos de um registro
 * POST   /api/fotos/:entidade/:registro   envia uma foto { imagem, miniatura, largura, altura }
 *
 * As rotas /arquivo vêm primeiro para não serem capturadas por /:entidade/:registro.
 */

const idValido = v => /^\d+$/.test(String(v)) && Number(v) > 0 && Number(v) < 2147483647;

function entidadeValida(req, res) {
  const tabela = ENTIDADES[req.params.entidade];
  if (!tabela) { res.status(400).json({ error: 'Tipo de cadastro não aceita fotos' }); return null; }
  return tabela;
}

/* ───────── Arquivo ───────── */

router.get('/arquivo/:id', requireAuth, async (req, res) => {
  try {
    if (!idValido(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const mini = req.query.mini === '1';

    // Fotos antigas (migradas) não têm miniatura: nesse caso serve a imagem inteira
    const r = await pool.query(
      mini
        ? 'SELECT mime, COALESCE(miniatura, dados) AS bin, (miniatura IS NOT NULL) AS eh_mini FROM fotos WHERE id = $1'
        : 'SELECT mime, dados AS bin, FALSE AS eh_mini FROM fotos WHERE id = $1',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Foto não encontrada' });

    const { mime, bin, eh_mini } = r.rows[0];
    const etag = `"f${req.params.id}${mini ? 'm' : ''}"`;

    // Uma foto nunca é editada, só excluída — o navegador pode guardar em cache à vontade
    res.set({
      'Content-Type': eh_mini ? 'image/jpeg' : mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.send(bin);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/arquivo/:id', requireAuth, async (req, res) => {
  try {
    if (!idValido(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    await pool.query('DELETE FROM fotos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── Por entidade ───────── */

router.get('/:entidade', requireAuth, async (req, res) => {
  try {
    if (!entidadeValida(req, res)) return;
    const r = await pool.query(
      `SELECT registro_id, array_agg(id ORDER BY ordem, id) AS ids
         FROM fotos WHERE entidade = $1 GROUP BY registro_id`,
      [req.params.entidade]
    );
    const mapa = {};
    r.rows.forEach(x => { mapa[x.registro_id] = x.ids; });
    res.json(mapa);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:entidade/:registro', requireAuth, async (req, res) => {
  try {
    if (!entidadeValida(req, res)) return;
    if (!idValido(req.params.registro)) return res.status(400).json({ error: 'ID inválido' });
    const r = await pool.query(
      `SELECT id, largura, altura, tamanho, ordem, created_at
         FROM fotos WHERE entidade = $1 AND registro_id = $2 ORDER BY ordem, id`,
      [req.params.entidade, req.params.registro]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:entidade/:registro', requireAuth, async (req, res) => {
  try {
    const tabela = entidadeValida(req, res);
    if (!tabela) return;
    const registroId = req.params.registro;
    if (!idValido(registroId)) return res.status(400).json({ error: 'ID inválido' });

    const img = lerDataURL(req.body.imagem);
    if (!img) return res.status(400).json({ error: 'Imagem inválida — use JPG, PNG ou WEBP' });
    if (img.buf.length > LIMITES.bytesImagem) {
      return res.status(413).json({ error: 'Imagem muito grande (máx. 5 MB depois de comprimida)' });
    }

    let mini = null;
    if (req.body.miniatura) {
      const m = lerDataURL(req.body.miniatura);
      if (m && m.mime === 'image/jpeg' && m.buf.length <= LIMITES.bytesMiniatura) mini = m.buf;
    }

    // O registro precisa existir — evita fotos órfãs apontando para IDs soltos
    const existe = await pool.query(`SELECT 1 FROM ${tabela} WHERE id = $1`, [registroId]);
    if (!existe.rows.length) return res.status(404).json({ error: 'Registro não encontrado' });

    const qtd = await pool.query(
      'SELECT COUNT(*)::int AS n, COALESCE(MAX(ordem), 0) AS ult FROM fotos WHERE entidade = $1 AND registro_id = $2',
      [req.params.entidade, registroId]
    );
    if (qtd.rows[0].n >= LIMITES.fotosPorRegistro) {
      return res.status(400).json({ error: `Limite de ${LIMITES.fotosPorRegistro} fotos por registro` });
    }

    const inteiro = v => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 100000 ? Number(v) : null);

    const r = await pool.query(
      `INSERT INTO fotos (entidade, registro_id, mime, dados, miniatura, largura, altura, tamanho, ordem, enviado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, largura, altura, tamanho, ordem, created_at`,
      [req.params.entidade, registroId, img.mime, img.buf, mini,
       inteiro(req.body.largura), inteiro(req.body.altura), img.buf.length,
       qtd.rows[0].ult + 1, req.session.userId || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
