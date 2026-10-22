require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./index');

/**
 * Popula o banco com os dados que já existiam nos 3 sistemas originais:
 *  - 18 crachás NFC (antes fixos no COLLABORATOR_MAP do index.html do Ponto)
 *  - 69 produtos com takt time (antes fixos no PRODUTOS_PADRAO do Cadenciador)
 *  - Turnos + intervalos (antes constantes TURNO_INICIO/TURNO_FIM/INTERVALOS)
 *
 * É idempotente: rodar de novo não duplica nada.
 */

const PRODUTOS_PADRAO = [
  { nome: "PATCH PANEL PPD24", takt: 15.0 },
  { nome: "PATCH PANEL PPDB24", takt: 15.0 },
  { nome: "RACK MRD 3U 470MM", takt: 10.5 },
  { nome: "RACK MRD 5U 470MM", takt: 10.5 },
  { nome: "RACK MRD 8U 470MM", takt: 11.0 },
  { nome: "RACK MRD 12U 470MM", takt: 11.5 },
  { nome: "RACK MRD 16U 470MM", takt: 8.0 },
  { nome: "RACK MRD 3U BS", takt: 10.5 },
  { nome: "RACK MRD 5U BS", takt: 10.5 },
  { nome: "RACK MRD 8U BS", takt: 11.0 },
  { nome: "RACK MRD 12U BS", takt: 11.5 },
  { nome: "RACK 5U BS OUTDOOR", takt: 4.0 },
  { nome: "RACK 8U BS OUTDOOR", takt: 5.0 },
  { nome: "RACK 12U BS OUTDOOR", takt: 5.0 },
  { nome: "RACK 24U TORRE", takt: 2.0 },
  { nome: "RACK 36U TORRE", takt: 4.0 },
  { nome: "RACK 44U TORRE", takt: 2.0 },
  { nome: "RACK RPD PA 1657", takt: 4.0 },
  { nome: "RACK RPD PA 2057", takt: 4.0 },
  { nome: "RACK RPD PA 2457", takt: 2.0 },
  { nome: "RACK RPD PA 2857", takt: 5.0 },
  { nome: "RACK RPD PA 3257", takt: 5.0 },
  { nome: "RACK RPD PA 3657", takt: 2.0 },
  { nome: "RACK RPD PA 4057", takt: 4.0 },
  { nome: "RACK RPD PA 4457", takt: 2.0 },
  { nome: "RACK RPD PP 4457", takt: 5.0 },
  { nome: "RACK RPD PA 1667", takt: 4.0 },
  { nome: "RACK RPD PA 2067", takt: 2.0 },
  { nome: "RACK RPD PA 2467", takt: 9.0 },
  { nome: "RACK RPD PA 2867", takt: 4.0 },
  { nome: "RACK RPD PA 3267", takt: 4.0 },
  { nome: "RACK RPD PA 3667", takt: 3.0 },
  { nome: "RACK RPD PA 4067", takt: 2.0 },
  { nome: "RACK RPD PA 4467", takt: 2.0 },
  { nome: "RACK RPD PP 4467", takt: 2.0 },
  { nome: "RACK RPD PA 2487", takt: 3.0 },
  { nome: "RACK RPD PA 2887", takt: 3.0 },
  { nome: "RACK RPD PA 3287", takt: 2.0 },
  { nome: "RACK RPD PA 3687", takt: 4.0 },
  { nome: "RACK RPD PA 4087", takt: 3.0 },
  { nome: "RACK RPD PA 4487", takt: 5.0 },
  { nome: "RACK RPD PP 4487", takt: 2.0 },
  { nome: "RACK RPD PA 3217", takt: 4.0 },
  { nome: "RACK RPD PA 3617", takt: 2.0 },
  { nome: "RACK RPD PA 4017", takt: 4.0 },
  { nome: "RACK RPD PA 4417", takt: 3.0 },
  { nome: "RACK RPD PP 4417", takt: 2.0 },
  { nome: "ORG CABOS VERTICAL 36U", takt: 2.0 },
  { nome: "ORG CABOS VERTICAL 44U", takt: 4.0 },
  { nome: "RACK ESTRUTURA RPD-4495", takt: 4.0 },
  { nome: "ENTERPRISE 44U (FECHADO)", takt: 2.0 },
  { nome: "ENTERPRISE 44U (ABERTO)", takt: 3.0 },
  { nome: "L 800", takt: 43.0 },
  { nome: "L 600", takt: 43.0 },
  { nome: "L 400", takt: 31.5 },
  { nome: "L 290", takt: 20.0 },
  { nome: "TELESC 800", takt: 18.0 },
  { nome: "TELESC 600", takt: 18.0 },
  { nome: "TELESC 400", takt: 15.0 },
  { nome: "ALT 40", takt: 13.5 },
  { nome: "ALT 80", takt: 13.5 },
  { nome: "BAND CHANTELIER", takt: 4.0 },
  { nome: "CONJUNTO FRENTE FALSA", takt: 25.0 },
  { nome: "CONJUNTO FRENTE FALSA (5ND)", takt: 20.0 },
  { nome: "RACK MRM 3U", takt: 6.25 },
  { nome: "RACK MRM 5U", takt: 6.25 },
  { nome: "CAIXA ORG LIGHT", takt: 7.0 },
  { nome: "CAIXA ORG. PRETA", takt: 4.333 },
  { nome: "CAIXA ORG. BRANCA", takt: 4.333 }
];

const CRACHAS_PADRAO = [
  { uid: "44:e3:64:a2", nome: "ALEXANDRO DA SILVA SANTOS" },
  { uid: "65:e5:2e:0f", nome: "DANIEL LOPES" },
  { uid: "b1:7c:37:dd", nome: "SANDRA DA SILVA" },
  { uid: "b5:a6:ed:73", nome: "JOSÉ CARLOS DA SILVA PEREIRA" },
  { uid: "cb:af:94:55", nome: "JUAN MATEUS DA SILVA FARIAS DOS ANJOS" },
  { uid: "f1:40:52:dd", nome: "ANDRE LUIZ BOTELHO" },
  { uid: "bb:50:b0:54", nome: "ALAN VITOR HERMES" },
  { uid: "bb:9c:dc:54", nome: "GIOVANI DA SILVA CAMPOS" },
  { uid: "69:7a:12:84", nome: "HENDERLAYNE NAYARA DAS MERCES CORDOVIL" },
  { uid: "cb:6f:b7:54", nome: "GABRIEL MACÁRIO" },
  { uid: "f4:be:41:a1", nome: "JAQUELINE DOS REIS ROQUE" },
  { uid: "59:69:6d:84", nome: "JULIA DANIELA SILVA DA SILVA" },
  { uid: "9b:28:88:cd", nome: "TIAGO SANTOS SANTANA" },
  { uid: "9b:fe:20:1c", nome: "CINTIA SUVAN" },
  { uid: "a5:05:0a:74", nome: "BRUNO KAUAN BARBOSA PRUDENCIO" },
  { uid: "eb:f6:bc:eb", nome: "HUGO DE ABREU" },
  { uid: "6b:06:44:55", nome: "TIAGO DIAS CORREIA" },
  { uid: "fb:d7:a1:cd", nome: "MARCIO VINICIUS DE JESUS" }
];

/* Turno 1 = os valores que estavam hard-coded no Cadenciador.
   Turnos 2 e 3 vêm desativados; ative e ajuste no Painel Administrador. */
const TURNOS_PADRAO = [
  {
    codigo: 'T1', nome: 'Turno 1', inicio: '06:00:00', fim: '17:30:00', ordem: 1, ativo: true,
    intervalos: [
      { nome: 'Café 1', inicio: '08:20:00', fim: '08:35:00', aviso: 'Intervalo iniciado, bom café a todos!' },
      { nome: 'Almoço', inicio: '11:30:00', fim: '12:30:00', aviso: 'Intervalo iniciado, bom almoço a todos!' },
      { nome: 'Café 2', inicio: '13:50:00', fim: '14:05:00', aviso: 'Intervalo iniciado, bom café a todos!' }
    ]
  },
  {
    codigo: 'T2', nome: 'Turno 2', inicio: '17:30:00', fim: '23:59:00', ordem: 2, ativo: false,
    intervalos: [
      { nome: 'Janta', inicio: '20:00:00', fim: '20:45:00', aviso: 'Intervalo iniciado, boa janta a todos!' }
    ]
  },
  {
    codigo: 'T3', nome: 'Turno 3', inicio: '22:00:00', fim: '06:00:00', ordem: 3, ativo: false, cruza: true,
    intervalos: [
      { nome: 'Ceia', inicio: '02:00:00', fim: '02:30:00', aviso: 'Intervalo iniciado, boa ceia a todos!' }
    ]
  }
];

const CELULAS_PADRAO = ['Célula 01', 'Célula 02', 'Célula 03', 'Célula 04', 'Montagem Geral'];

const CONFIG_PADRAO = [
  ['empresa_nome',        'Décio Indústria Metalúrgica', 'Nome exibido no cabeçalho'],
  ['empresa_setor',       'Setor de Montagem',           'Subtítulo exibido no portal'],
  ['ponto_permite_manual','true',                        'Permite bater ponto pelo seletor de nome (sem NFC)'],
  ['ponto_bloqueio_min',  '1',                           'Minutos mínimos entre duas batidas do mesmo crachá'],
  ['cad_voz_ativa',       'true',                        'Avisos de voz do Cadenciador'],
  ['cad_limite_ciclos',   '500',                         'Máximo de ciclos calculados por turno']
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* ── Usuário administrador ── */
    const admUser = process.env.ADMIN_USER || 'admin';
    const admPass = process.env.ADMIN_PASS || 'Decio@2026';
    const admNome = process.env.ADMIN_NOME || 'Administrador';
    const jaExiste = await client.query('SELECT id FROM users WHERE username=$1', [admUser]);
    if (jaExiste.rows.length === 0) {
      const hash = await bcrypt.hash(admPass, 10);
      await client.query(
        'INSERT INTO users (username,password,nome,role) VALUES ($1,$2,$3,$4)',
        [admUser, hash, admNome, 'admin']
      );
      console.log(`  ✓ Administrador criado: ${admUser}`);
    }

    /* ── Parâmetros gerais ── */
    for (const [chave, valor, descricao] of CONFIG_PADRAO) {
      await client.query(
        `INSERT INTO app_config (chave,valor,descricao) VALUES ($1,$2,$3)
         ON CONFLICT (chave) DO NOTHING`,
        [chave, valor, descricao]
      );
    }

    /* ── Turnos + intervalos ── */
    for (const t of TURNOS_PADRAO) {
      const r = await client.query(
        `INSERT INTO turnos (codigo,nome,hora_inicio,hora_fim,cruza_meia_noite,ordem,ativo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (codigo) DO NOTHING
         RETURNING id`,
        [t.codigo, t.nome, t.inicio, t.fim, !!t.cruza, t.ordem, t.ativo]
      );
      if (r.rows.length) {
        for (const i of t.intervalos) {
          await client.query(
            `INSERT INTO turno_intervalos (turno_id,nome,hora_inicio,hora_fim,aviso_voz)
             VALUES ($1,$2,$3,$4,$5)`,
            [r.rows[0].id, i.nome, i.inicio, i.fim, i.aviso]
          );
        }
      }
    }

    /* ── Células ── */
    for (const nome of CELULAS_PADRAO) {
      await client.query(
        'INSERT INTO celulas (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING',
        [nome]
      );
    }

    /* ── Colaboradores + crachás NFC ── */
    const t1 = await client.query("SELECT nome FROM turnos WHERE codigo='T1'");
    const turnoT1 = t1.rows[0] ? t1.rows[0].nome : 'Turno 1';

    /* Só no primeiro boot (banco sem nenhum colaborador). Antes isso rodava
       sempre e recriava como "Ativo" qualquer montador padrão que o admin
       tivesse excluído — a cada deploy os desligados voltavam. */
    const jaTemColab = (await client.query('SELECT 1 FROM colaboradores LIMIT 1')).rows.length > 0;
    for (const c of jaTemColab ? [] : CRACHAS_PADRAO) {
      let colab = await client.query('SELECT id FROM colaboradores WHERE nome=$1', [c.nome]);
      if (colab.rows.length === 0) {
        colab = await client.query(
          `INSERT INTO colaboradores (nome,setor,turno,status) VALUES ($1,'Montagem',$2,'Ativo') RETURNING id`,
          [c.nome, turnoT1]
        );
      }
      await client.query(
        `INSERT INTO ponto_crachas (uid,colaborador_id,nome_cache) VALUES ($1,$2,$3)
         ON CONFLICT (uid) DO UPDATE SET colaborador_id=EXCLUDED.colaborador_id, nome_cache=EXCLUDED.nome_cache`,
        [c.uid.toLowerCase(), colab.rows[0].id, c.nome]
      );
    }

    /* ── Produtos do Cadenciador (takt time) ── */
    let ordem = 0;
    for (const p of PRODUTOS_PADRAO) {
      await client.query(
        `INSERT INTO cad_produtos (nome,takt_min,ordem) VALUES ($1,$2,$3)
         ON CONFLICT (nome) DO NOTHING`,
        [p.nome, p.takt, ++ordem]
      );
    }

    await client.query('COMMIT');

    const cnt = async (t) => (await pool.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
    console.log(`  ✓ Seed concluído — ${await cnt('turnos')} turnos, ${await cnt('celulas')} células, ` +
                `${await cnt('colaboradores')} colaboradores, ${await cnt('ponto_crachas')} crachás, ` +
                `${await cnt('cad_produtos')} produtos`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed };

/* Permite rodar isolado: npm run db:seed */
if (require.main === module) {
  const { initDB } = require('./schema');
  initDB()
    .then(seed)
    .then(() => { console.log('Pronto.'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
