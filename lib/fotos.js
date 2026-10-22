const { pool } = require('../db');

/**
 * Fotos dos cadastros do ProGestão e do Diário de Bordo.
 *
 * Cada foto é uma linha da tabela `fotos`, ligada ao registro por
 * (entidade, registro_id). Assim as listagens continuam leves — a imagem só
 * trafega quando alguém abre a miniatura ou a foto ampliada.
 *
 * Para liberar fotos em um novo cadastro basta acrescentar uma linha aqui:
 * o schema cria o gatilho de limpeza e a rota passa a aceitar a entidade.
 */
const ENTIDADES = {
  ferramenta:  'ferramentas',
  epi:         'epis',
  treinamento: 'treinamentos',
  atividade:   'cl_atividades',
  produto:     'prod_produtos',
  diario:      'db_registros',
  resumo:      'db_resumos',
  lp_item:     'lp_itens',
  advertencia: 'tr_advertencias'
};

const LIMITES = {
  bytesImagem:    5 * 1024 * 1024,   // depois da compressão no navegador fica em ~150–500 KB
  bytesMiniatura: 300 * 1024,
  fotosPorRegistro: 20
};

/** Identifica o formato pelos primeiros bytes — o mime informado pelo cliente não é confiável. */
function detectarMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;   // SVG e demais formatos ficam de fora de propósito
}

/** "data:image/jpeg;base64,AAAA" → { buf, mime } ou null */
function lerDataURL(texto) {
  if (typeof texto !== 'string') return null;
  const m = texto.match(/^data:[^;,]*;base64,(.+)$/s);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  const mime = detectarMime(buf);
  return mime ? { buf, mime } : null;
}

/**
 * Migração única das fotos antigas, que ficavam em base64 dentro das próprias
 * tabelas (epis.foto, ferramentas.foto, db_registros.foto/fotos).
 * Cada registro é movido numa transação: a coluna antiga só é limpa depois
 * que as fotos estão gravadas na tabela nova. Rodar de novo não duplica nada.
 */
async function migrarFotosAntigas() {
  let movidas = 0;

  const fontes = [
    { tabela: 'epis',         entidade: 'epi',        colunas: ['foto'] },
    { tabela: 'ferramentas',  entidade: 'ferramenta', colunas: ['foto'] },
    { tabela: 'db_registros', entidade: 'diario',     colunas: ['foto', 'fotos'] }
  ];

  for (const f of fontes) {
    const filtro = f.colunas.map(c => `(${c} IS NOT NULL AND ${c} <> '' AND ${c} <> '[]')`).join(' OR ');
    let ids;
    try {
      ids = (await pool.query(`SELECT id FROM ${f.tabela} WHERE ${filtro}`)).rows.map(r => r.id);
    } catch (e) {
      console.warn(`  ! Migração de fotos (${f.tabela}) ignorada:`, e.message.split('\n')[0]);
      continue;
    }

    for (const id of ids) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = (await client.query(
          `SELECT ${f.colunas.join(', ')} FROM ${f.tabela} WHERE id = $1 FOR UPDATE`, [id]
        )).rows[0];
        if (!row) { await client.query('ROLLBACK'); continue; }

        // db_registros.fotos é um array JSON; db_registros.foto é a 1ª foto repetida
        let lista = [];
        if (row.fotos) { try { lista = JSON.parse(row.fotos); } catch { lista = []; } }
        if (!Array.isArray(lista)) lista = [];
        if (!lista.length && row.foto) lista = [row.foto];

        let ordem = 0;
        for (const item of lista) {
          const img = lerDataURL(item);
          if (!img) continue;
          await client.query(
            `INSERT INTO fotos (entidade, registro_id, mime, dados, tamanho, ordem)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [f.entidade, id, img.mime, img.buf, img.buf.length, ++ordem]
          );
          movidas++;
        }

        const limpar = f.colunas.map(c => `${c} = NULL`).join(', ');
        await client.query(`UPDATE ${f.tabela} SET ${limpar} WHERE id = $1`, [id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.warn(`  ! Foto antiga de ${f.tabela}#${id} não migrada:`, e.message);
      } finally {
        client.release();
      }
    }
  }

  if (movidas) console.log(`  ✓ ${movidas} foto(s) antiga(s) movida(s) para a tabela de fotos`);
}

module.exports = { ENTIDADES, LIMITES, detectarMime, lerDataURL, migrarFotosAntigas };
