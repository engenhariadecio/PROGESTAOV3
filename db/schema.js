const { pool } = require('./index');
const { ENTIDADES, migrarFotosAntigas } = require('../lib/fotos');

/**
 * Schema único e idempotente do Sistema Integrado da Montagem.
 * Pode rodar em banco vazio ou já populado — nada aqui destrói dados.
 *
 * Os nomes de coluna foram derivados das rotas reais (routes/*.js).
 * O schema antigo do ProGestão estava dessincronizado e quebrava em runtime.
 */

const SQL_BASE = `
/* ══════════════ NÚCLEO ══════════════ */

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(100) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  nome        VARCHAR(200),
  role        VARCHAR(50) DEFAULT 'user',
  ativo       BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_config (
  chave       VARCHAR(80) PRIMARY KEY,
  valor       TEXT,
  descricao   TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default",
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

/* ══════════════ TURNOS (compartilhado pelos 3 sistemas) ══════════════ */

CREATE TABLE IF NOT EXISTS turnos (
  id                SERIAL PRIMARY KEY,
  codigo            VARCHAR(10) UNIQUE NOT NULL,
  nome              VARCHAR(60) NOT NULL,
  hora_inicio       TIME NOT NULL,
  hora_fim          TIME NOT NULL,
  cruza_meia_noite  BOOLEAN DEFAULT FALSE,
  tolerancia_min    INTEGER DEFAULT 5,
  ordem             INTEGER DEFAULT 0,
  ativo             BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS turno_intervalos (
  id           SERIAL PRIMARY KEY,
  turno_id     INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  nome         VARCHAR(60) NOT NULL,
  hora_inicio  TIME NOT NULL,
  hora_fim     TIME NOT NULL,
  aviso_voz    TEXT,
  ativo        BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_turno_intervalos_turno ON turno_intervalos(turno_id);

CREATE TABLE IF NOT EXISTS celulas (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(80) UNIQUE NOT NULL,
  descricao   TEXT,
  ativa       BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

/* ══════════════ COLABORADORES ══════════════ */

CREATE TABLE IF NOT EXISTS colaboradores (
  id             SERIAL PRIMARY KEY,
  nome           VARCHAR(200) NOT NULL,
  mat            VARCHAR(50),
  cargo          VARCHAR(120),
  setor          VARCHAR(120) DEFAULT 'Montagem',
  turno          VARCHAR(60),
  status         VARCHAR(40) DEFAULT 'Ativo',
  dt_admissao    DATE,
  dt_nascimento  DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_colab_status ON colaboradores(status);

/* ══════════════ SISTEMA 1 — PONTO NFC ══════════════ */

CREATE TABLE IF NOT EXISTS ponto_crachas (
  id              SERIAL PRIMARY KEY,
  uid             VARCHAR(64) UNIQUE NOT NULL,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  nome_cache      VARCHAR(200),
  ativo           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crachas_colab ON ponto_crachas(colaborador_id);

CREATE TABLE IF NOT EXISTS ponto_registros (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  cracha_uid      VARCHAR(64),
  nome            VARCHAR(200) NOT NULL,
  turno_id        INTEGER REFERENCES turnos(id) ON DELETE SET NULL,
  turno_codigo    VARCHAR(10),
  data            DATE NOT NULL,
  hora            TIME NOT NULL,
  marcado_em      TIMESTAMPTZ DEFAULT NOW(),
  tipo            VARCHAR(20) DEFAULT 'entrada',
  origem          VARCHAR(20) DEFAULT 'nfc',
  dispositivo     VARCHAR(160),
  observacao      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ponto_data   ON ponto_registros(data DESC);
CREATE INDEX IF NOT EXISTS idx_ponto_colab  ON ponto_registros(colaborador_id, data);
CREATE INDEX IF NOT EXISTS idx_ponto_turno  ON ponto_registros(turno_id);

/* ══════════════ SISTEMA 2 — CADENCIADOR DE PRODUÇÃO ══════════════ */

CREATE TABLE IF NOT EXISTS cad_produtos (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(200) UNIQUE NOT NULL,
  cod_decio   VARCHAR(50),
  takt_min    NUMERIC(8,3) NOT NULL DEFAULT 1,
  celula_id   INTEGER REFERENCES celulas(id) ON DELETE SET NULL,
  ordem       INTEGER DEFAULT 0,
  ativo       BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

/* Takt específico por turno — sobrepõe cad_produtos.takt_min quando existir */
CREATE TABLE IF NOT EXISTS cad_takt_turno (
  id          SERIAL PRIMARY KEY,
  produto_id  INTEGER NOT NULL REFERENCES cad_produtos(id) ON DELETE CASCADE,
  turno_id    INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  takt_min    NUMERIC(8,3) NOT NULL,
  CONSTRAINT uq_takt_produto_turno UNIQUE (produto_id, turno_id)
);

CREATE TABLE IF NOT EXISTS cad_sessoes (
  id                SERIAL PRIMARY KEY,
  data              DATE NOT NULL,
  turno_id          INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  produto_id        INTEGER NOT NULL REFERENCES cad_produtos(id) ON DELETE CASCADE,
  takt_min          NUMERIC(8,3) NOT NULL,
  tempo_parado_seg  INTEGER DEFAULT 0,
  status            VARCHAR(20) DEFAULT 'aberta',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_sessao UNIQUE (data, turno_id, produto_id)
);

CREATE TABLE IF NOT EXISTS cad_ciclos (
  id             SERIAL PRIMARY KEY,
  sessao_id      INTEGER NOT NULL REFERENCES cad_sessoes(id) ON DELETE CASCADE,
  numero         INTEGER NOT NULL,
  hora_prevista  TIME NOT NULL,
  concluido      BOOLEAN DEFAULT TRUE,
  observacao     TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_ciclo UNIQUE (sessao_id, numero)
);

CREATE TABLE IF NOT EXISTS cad_paradas (
  id            SERIAL PRIMARY KEY,
  sessao_id     INTEGER NOT NULL REFERENCES cad_sessoes(id) ON DELETE CASCADE,
  inicio        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fim           TIMESTAMPTZ,
  duracao_seg   INTEGER DEFAULT 0,
  motivo        TEXT
);
CREATE INDEX IF NOT EXISTS idx_paradas_sessao ON cad_paradas(sessao_id);

/* ══════════════ SISTEMA 3 — PROGESTÃO ══════════════ */

/* ── Ferramentas ── */
CREATE TABLE IF NOT EXISTS ferramentas (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(200) NOT NULL,
  cod         VARCHAR(100) NOT NULL,
  cat         VARCHAR(120),
  loc         VARCHAR(200),
  status      VARCHAR(50) DEFAULT 'Disponível',
  cal         DATE,
  prev        DATE,
  obs         TEXT,
  foto        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS emprestimos (
  id              SERIAL PRIMARY KEY,
  ferramenta_id   INTEGER REFERENCES ferramentas(id) ON DELETE CASCADE,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  dt              DATE NOT NULL,
  dev_dt          DATE,
  devolvido       BOOLEAN DEFAULT FALSE,
  obs             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_emp_ferr ON emprestimos(ferramenta_id);

CREATE TABLE IF NOT EXISTS manutencoes (
  id              SERIAL PRIMARY KEY,
  ferramenta_id   INTEGER REFERENCES ferramentas(id) ON DELETE CASCADE,
  tipo            VARCHAR(60),
  responsavel_id  INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  env             DATE NOT NULL,
  ret             DATE,
  descricao       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checklist_ferramentas (
  id             SERIAL PRIMARY KEY,
  ferramenta_id  INTEGER REFERENCES ferramentas(id) ON DELETE CASCADE,
  checked        BOOLEAN DEFAULT FALSE,
  obs            TEXT,
  data           DATE NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_checklist_ferr_data UNIQUE (ferramenta_id, data)
);

/* Conferências salvas do ferramental: um cabeçalho por checklist e um item por
   ferramenta, com a situação encontrada. checklist_ferramentas (acima) era a
   versão antiga, por dia, que nunca chegou a funcionar com a tela — fica só
   para não apagar dados de quem já tinha. */
CREATE TABLE IF NOT EXISTS ferr_checklists (
  id               SERIAL PRIMARY KEY,
  data             DATE NOT NULL,
  hora             TIME NOT NULL,
  turno            VARCHAR(60),
  responsavel_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  responsavel_nome VARCHAR(200),
  obs              TEXT,
  total            INTEGER DEFAULT 0,
  ok               INTEGER DEFAULT 0,
  problema         INTEGER DEFAULT 0,
  nao_encontrada   INTEGER DEFAULT 0,
  pendente         INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ferr_cl_data ON ferr_checklists(data DESC, hora DESC);

CREATE TABLE IF NOT EXISTS ferr_checklist_itens (
  id             SERIAL PRIMARY KEY,
  checklist_id   INTEGER NOT NULL REFERENCES ferr_checklists(id) ON DELETE CASCADE,
  ferramenta_id  INTEGER REFERENCES ferramentas(id) ON DELETE SET NULL,
  cod            VARCHAR(100),
  nome           VARCHAR(200),
  cat            VARCHAR(120),
  loc            VARCHAR(200),
  status_ferr    VARCHAR(50),
  situacao       VARCHAR(20) NOT NULL DEFAULT 'pendente',
  obs            TEXT
);
CREATE INDEX IF NOT EXISTS idx_ferr_cl_itens ON ferr_checklist_itens(checklist_id);

/* ── EPIs ── */
CREATE TABLE IF NOT EXISTS epis (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(200) NOT NULL,
  dur_qtd     INTEGER,
  dur_tipo    VARCHAR(40),
  descricao   TEXT,
  foto        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS epi_entregas (
  id              SERIAL PRIMARY KEY,
  epi_id          INTEGER REFERENCES epis(id) ON DELETE CASCADE,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE CASCADE,
  qtd             INTEGER DEFAULT 1,
  dt              DATE NOT NULL,
  validade        DATE,
  motivo          VARCHAR(120),
  obs             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS epi_checklists (
  id           SERIAL PRIMARY KEY,
  data         DATE NOT NULL,
  turno        VARCHAR(60),
  total        INTEGER DEFAULT 0,
  conformes    INTEGER DEFAULT 0,
  irregulares  INTEGER DEFAULT 0,
  pct          NUMERIC(6,2) DEFAULT 0,
  registros    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

/* ── Banco de Horas ── */
CREATE TABLE IF NOT EXISTS bh_lancamentos (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE CASCADE,
  tipo            VARCHAR(40),
  minutos         INTEGER NOT NULL,
  data            DATE NOT NULL,
  motivo          VARCHAR(200),
  justificativa   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bh_lanc_colab ON bh_lancamentos(colaborador_id);

CREATE TABLE IF NOT EXISTS bh_convites (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  data_banco      DATE NOT NULL,
  resposta        VARCHAR(40) DEFAULT 'Pendente',
  obs             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bh_atrasos (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  ponto           TIME NOT NULL,
  linha           TIME NOT NULL,
  diff            INTEGER DEFAULT 0,
  motivo          VARCHAR(200),
  obs             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bh_eventos (
  id              SERIAL PRIMARY KEY,
  tipo            VARCHAR(60),
  abrangencia     VARCHAR(60),
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  hora            TIME,
  descricao       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ── Treinamentos ── */
CREATE TABLE IF NOT EXISTS treinamentos (
  id              SERIAL PRIMARY KEY,
  nome            VARCHAR(200) NOT NULL,
  categoria       VARCHAR(120),
  carga_horaria   INTEGER DEFAULT 0,
  validade_meses  INTEGER DEFAULT 0,
  descricao       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tr_presencas (
  id              SERIAL PRIMARY KEY,
  treinamento_id  INTEGER REFERENCES treinamentos(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  instrutor       VARCHAR(200),
  local_treino    VARCHAR(200),
  lista           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tr_registros (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE CASCADE,
  treinamento_id  INTEGER REFERENCES treinamentos(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  validade        DATE,
  instrutor       VARCHAR(200),
  local_treino    VARCHAR(200),
  obs             TEXT,
  presenca_id     INTEGER REFERENCES tr_presencas(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tr_agenda (
  id              SERIAL PRIMARY KEY,
  treinamento_id  INTEGER REFERENCES treinamentos(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  hora            TIME,
  local_treino    VARCHAR(200),
  obs             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ── Diário de Bordo ── */
CREATE TABLE IF NOT EXISTS db_setores (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(160) UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS db_registros (
  id                  SERIAL PRIMARY KEY,
  tipo                VARCHAR(30) DEFAULT 'pendencia',
  data                DATE NOT NULL,
  hora                TIME,
  turno               VARCHAR(60),
  categoria           VARCHAR(120),
  prioridade          VARCHAR(40),
  status              VARCHAR(40),
  descricao           TEXT NOT NULL,
  acao                TEXT,
  envolvidos          TEXT,
  foto                TEXT,
  fotos               TEXT,
  previsao_conclusao  DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_db_reg_data ON db_registros(data DESC);

CREATE TABLE IF NOT EXISTS db_resumos (
  id          SERIAL PRIMARY KEY,
  data        DATE NOT NULL,
  turno       VARCHAR(60),
  texto       TEXT NOT NULL,
  obs         TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

/* ── Checklist de Atividades ── */
CREATE TABLE IF NOT EXISTS cl_atividades (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(200) NOT NULL,
  freq        VARCHAR(60) NOT NULL,
  inicio      DATE NOT NULL,
  status      VARCHAR(40) DEFAULT 'Ativa',
  descricao   TEXT,
  horario     TIME,
  horario2    TIME,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cl_execucoes (
  id            SERIAL PRIMARY KEY,
  atividade_id  INTEGER REFERENCES cl_atividades(id) ON DELETE CASCADE,
  data          DATE NOT NULL,
  hora          TIME,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ── Produção / Planejamento ── */
CREATE TABLE IF NOT EXISTS prod_produtos (
  id                  SERIAL PRIMARY KEY,
  cod_decio           VARCHAR(50) UNIQUE NOT NULL,
  cod_intelbras       VARCHAR(50),
  descricao           VARCHAR(300),
  categoria           VARCHAR(120),
  valor               NUMERIC(12,2) DEFAULT 0,
  minutos_reportados  NUMERIC(10,2) DEFAULT 0,
  hora_reportado      NUMERIC(10,4) DEFAULT 0,
  ativo               BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prod_planos (
  id             SERIAL PRIMARY KEY,
  mes            VARCHAR(7),
  data_limite    DATE,
  cod_decio      VARCHAR(50),
  cod_intelbras  VARCHAR(50),
  descricao      VARCHAR(300),
  produto        VARCHAR(300),
  meta           NUMERIC(12,2) DEFAULT 0,
  realizado      NUMERIC(12,2) DEFAULT 0,
  observacoes    TEXT,
  num_op         VARCHAR(8),
  status         VARCHAR(50) DEFAULT 'em_andamento',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prod_planos_num_op ON prod_planos(num_op);

/* Observações sobre o status de um plano (por que está atrasado, o que foi
   combinado...). Quem registra é admin/operação; o PCP só lê. Guarda o status
   que o plano tinha na hora, para o histórico fazer sentido depois. */
CREATE TABLE IF NOT EXISTS prod_plano_obs (
  id             SERIAL PRIMARY KEY,
  plano_id       INTEGER NOT NULL REFERENCES prod_planos(id) ON DELETE CASCADE,
  texto          TEXT NOT NULL,
  status_na_hora VARCHAR(50),
  autor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  autor_nome     VARCHAR(200),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prod_plano_obs ON prod_plano_obs(plano_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prod_apontamentos (
  id           SERIAL PRIMARY KEY,
  plano_id     INTEGER REFERENCES prod_planos(id) ON DELETE CASCADE,
  data         DATE,
  quantidade   NUMERIC(12,2) DEFAULT 0,
  observacoes  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prod_apontamentos_detalhados (
  id                    SERIAL PRIMARY KEY,
  data_execucao         DATE NOT NULL,
  turno                 VARCHAR(10) NOT NULL,
  celula                VARCHAR(50) NOT NULL,
  num_op                VARCHAR(8) NOT NULL,
  serie_inicial         VARCHAR(13) NOT NULL,
  serie_final           VARCHAR(13) NOT NULL,
  cod_decio             VARCHAR(50) NOT NULL,
  cod_intelbras         VARCHAR(50),
  descricao             VARCHAR(300),
  categoria             VARCHAR(120),
  meta                  NUMERIC(12,2) DEFAULT 0,
  realizado             NUMERIC(12,2) DEFAULT 0,
  hora_reportada_total  NUMERIC(12,4) DEFAULT 0,
  observacoes           TEXT,
  plano_id              INTEGER REFERENCES prod_planos(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_apont_det_data  ON prod_apontamentos_detalhados(data_execucao);
CREATE INDEX IF NOT EXISTS idx_apont_det_decio ON prod_apontamentos_detalhados(cod_decio);
CREATE INDEX IF NOT EXISTS idx_apont_det_op    ON prod_apontamentos_detalhados(num_op);
CREATE INDEX IF NOT EXISTS idx_apont_det_plano ON prod_apontamentos_detalhados(plano_id);

/* ══════════════ ADVERTÊNCIAS (módulo Treinamentos) ══════════════ */
/* Guarda uma cópia do nome do colaborador: a advertência continua legível
   mesmo se o cadastro for excluído. */
CREATE TABLE IF NOT EXISTS tr_advertencias (
  id               SERIAL PRIMARY KEY,
  colaborador_id   INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  colaborador_nome VARCHAR(200),
  data             DATE NOT NULL,
  tipo             VARCHAR(20) NOT NULL DEFAULT 'Verbal',   -- Verbal | Escrita | Suspensão
  dias_suspensao   INTEGER,
  motivo           VARCHAR(200) NOT NULL,
  descricao        TEXT,
  aplicada_por     VARCHAR(200),
  testemunhas      VARCHAR(300),
  assinou          BOOLEAN,                                  -- NULL = não informado, FALSE = recusou
  obs              TEXT,
  registrado_por   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tr_adv_colab ON tr_advertencias(colaborador_id, data DESC);

/* ══════════════ CONTADOR (câmera + IA no pallet) ══════════════ */
/* Um evento por produto que saiu da linha. A foto é a evidência da contagem
   (miniatura do momento), para auditar falsos positivos. */
CREATE TABLE IF NOT EXISTS cont_eventos (
  id            SERIAL PRIMARY KEY,
  celula        VARCHAR(80) NOT NULL,
  sessao_id     INTEGER REFERENCES cad_sessoes(id) ON DELETE SET NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  origem        VARCHAR(20) NOT NULL DEFAULT 'ia',   -- ia | manual_mais | manual_menos | troca_pallet
  valor         SMALLINT NOT NULL DEFAULT 1,          -- +1, -1 ou 0 (troca de pallet)
  mudanca_pct   NUMERIC(5,2),                        -- % da área do pallet que mudou (IA)
  foto          BYTEA,
  dispositivo   VARCHAR(120),
  usuario_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cont_ev_celula_ts ON cont_eventos(celula, ts DESC);

/* Uma "linha" do contador = célula + produto do cadenciador. É criada no PC;
   o celular só abre o link e conecta a câmera. A configuração (área do pallet,
   tamanho da caixa, câmera, zoom, sensibilidade) fica aqui e é feita pelo PC
   sobre a imagem ao vivo — o celular aplica o que o servidor mandar. */
CREATE TABLE IF NOT EXISTS cont_linhas (
  id            SERIAL PRIMARY KEY,
  celula        VARCHAR(80) NOT NULL,
  produto_id    INTEGER REFERENCES cad_produtos(id) ON DELETE SET NULL,
  nome          VARCHAR(120),
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativa         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cont_linhas_celula ON cont_linhas(celula);

/* Ajustes da câmera que dependem do produto (tamanho da caixa, sensibilidade,
   várias por vez). A área do pallet, câmera e zoom ficam na linha, porque o
   pallet e a posição do aparelho são os mesmos para todos os produtos. */
/* IA de detecção: amostras marcadas no painel (quadro + retângulos das caixas/peças)
   e o modelo treinado a partir delas (ONNX, roda no próprio aparelho). */
CREATE TABLE IF NOT EXISTS cont_amostras (
  id            SERIAL PRIMARY KEY,
  linha_id      INTEGER NOT NULL REFERENCES cont_linhas(id) ON DELETE CASCADE,
  produto_id    INTEGER REFERENCES cad_produtos(id) ON DELETE SET NULL,
  jpeg          BYTEA NOT NULL,
  largura       INTEGER NOT NULL DEFAULT 480,
  altura        INTEGER NOT NULL DEFAULT 360,
  caixas        JSONB NOT NULL DEFAULT '[]'::jsonb,
  rotulo        VARCHAR(20),                           -- modo pallet: vazio | com_pecas
  usuario_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cont_amostras_linha ON cont_amostras(linha_id, produto_id);
CREATE TABLE IF NOT EXISTS cont_modelos (
  id            SERIAL PRIMARY KEY,
  linha_id      INTEGER NOT NULL REFERENCES cont_linhas(id) ON DELETE CASCADE,
  produto_id    INTEGER REFERENCES cad_produtos(id) ON DELETE CASCADE,
  onnx          BYTEA NOT NULL,
  imgsz         INTEGER NOT NULL DEFAULT 416,
  tipo          VARCHAR(10) NOT NULL DEFAULT 'det',     -- det: conta peças | cls: pallet vazio x com peças
  classes       JSONB,
  metricas      JSONB NOT NULL DEFAULT '{}'::jsonb,
  amostras      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cont_modelos_linha ON cont_modelos(linha_id, produto_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cont_linha_produto (
  id            SERIAL PRIMARY KEY,
  linha_id      INTEGER NOT NULL REFERENCES cont_linhas(id) ON DELETE CASCADE,
  produto_id    INTEGER NOT NULL REFERENCES cad_produtos(id) ON DELETE CASCADE,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (linha_id, produto_id)
);
CREATE INDEX IF NOT EXISTS idx_cont_ev_sessao ON cont_eventos(sessao_id);

/* ══════════════ LIMPEZA (itens com frequência + agenda por colaborador) ══════════════ */

/* O que precisa ser limpo e de quanto em quanto tempo. A próxima limpeza é
   calculada a partir da última feita (ou de "inicio", se nunca foi feita). */
CREATE TABLE IF NOT EXISTS lp_itens (
  id              SERIAL PRIMARY KEY,
  nome            VARCHAR(200) NOT NULL,
  local           VARCHAR(200),
  descricao       TEXT,
  freq_qtd        INTEGER NOT NULL DEFAULT 1,
  freq_tipo       VARCHAR(10) NOT NULL DEFAULT 'dias',   -- dias | semanas | meses
  aviso_dias      INTEGER NOT NULL DEFAULT 2,            -- alerta "a vencer" com N dias de antecedência
  responsavel_id  INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  inicio          DATE NOT NULL DEFAULT CURRENT_DATE,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* Agenda e histórico na mesma tabela: 'agendado' é o que está por fazer,
   'feito' é o que já foi (com quem fez e quando). Registrar uma limpeza
   sem agendamento prévio cria uma linha já como 'feito'. */
CREATE TABLE IF NOT EXISTS lp_agenda (
  id              SERIAL PRIMARY KEY,
  item_id         INTEGER NOT NULL REFERENCES lp_itens(id) ON DELETE CASCADE,
  colaborador_id  INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  data            DATE NOT NULL,
  turno           VARCHAR(60),
  status          VARCHAR(20) NOT NULL DEFAULT 'agendado',  -- agendado | feito | cancelado
  feito_em        DATE,
  feito_hora      TIME,
  feito_por_id    INTEGER REFERENCES colaboradores(id) ON DELETE SET NULL,
  obs             TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lp_agenda_item ON lp_agenda(item_id, status, data);
CREATE INDEX IF NOT EXISTS idx_lp_agenda_data ON lp_agenda(data, status);

/* ══════════════ FOTOS (cadastros do ProGestão + Diário de Bordo) ══════════════ */

/* Uma linha por foto. (entidade, registro_id) aponta para o cadastro dono —
   a lista de entidades válidas fica em lib/fotos.js. A imagem vem comprimida
   do navegador; a miniatura é o que as tabelas exibem. */
CREATE TABLE IF NOT EXISTS fotos (
  id           SERIAL PRIMARY KEY,
  entidade     VARCHAR(40) NOT NULL,
  registro_id  INTEGER NOT NULL,
  mime         VARCHAR(40) NOT NULL,
  dados        BYTEA NOT NULL,
  miniatura    BYTEA,
  largura      INTEGER,
  altura       INTEGER,
  tamanho      INTEGER,
  ordem        INTEGER DEFAULT 0,
  enviado_por  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fotos_registro ON fotos(entidade, registro_id, ordem, id);
`;

/**
 * Excluir um cadastro apaga as fotos dele. Feito por gatilho para funcionar
 * em qualquer caminho de exclusão, sem depender de cada rota lembrar disso.
 * Fica fora de SQL_MIGRACOES porque o corpo da função tem ';'.
 */
const SQL_FOTOS_GATILHOS = `
CREATE OR REPLACE FUNCTION fotos_apagar_do_registro() RETURNS trigger AS $$
BEGIN
  DELETE FROM fotos WHERE entidade = TG_ARGV[0] AND registro_id = OLD.id;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
` + Object.entries(ENTIDADES).map(([entidade, tabela]) => `
DROP TRIGGER IF EXISTS trg_fotos_${tabela} ON ${tabela};
CREATE TRIGGER trg_fotos_${tabela} AFTER DELETE ON ${tabela}
  FOR EACH ROW EXECUTE FUNCTION fotos_apagar_do_registro('${entidade}');`).join('\n');

/**
 * Migrações defensivas: cobrem bancos criados pela versão antiga do ProGestão,
 * onde os nomes de coluna divergiam das rotas.
 */
const SQL_MIGRACOES = `
ALTER TABLE users             ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE cont_eventos      ADD COLUMN IF NOT EXISTS linha_id INTEGER REFERENCES cont_linhas(id) ON DELETE SET NULL;
ALTER TABLE cont_amostras     ADD COLUMN IF NOT EXISTS rotulo VARCHAR(20);
ALTER TABLE cont_eventos      ADD COLUMN IF NOT EXISTS detalhe VARCHAR(60);   -- caixa | peca | pallet saiu | pallet novo
ALTER TABLE cont_modelos      ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'det';
ALTER TABLE cont_modelos      ADD COLUMN IF NOT EXISTS classes JSONB;

ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS mat VARCHAR(50);
ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS cargo VARCHAR(120);
ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS turno VARCHAR(60);
ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS status VARCHAR(40) DEFAULT 'Ativo';
ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS dt_admissao DATE;
ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS dt_nascimento DATE;
ALTER TABLE colaboradores     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS cod VARCHAR(100);
ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS cat VARCHAR(120);
ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS loc VARCHAR(200);
ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS cal DATE;
ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS prev DATE;
ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE ferramentas       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE emprestimos       ADD COLUMN IF NOT EXISTS dt DATE;
ALTER TABLE emprestimos       ADD COLUMN IF NOT EXISTS dev_dt DATE;
ALTER TABLE emprestimos       ADD COLUMN IF NOT EXISTS devolvido BOOLEAN DEFAULT FALSE;
ALTER TABLE emprestimos       ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE emprestimos       ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE manutencoes       ADD COLUMN IF NOT EXISTS responsavel_id INTEGER;
ALTER TABLE manutencoes       ADD COLUMN IF NOT EXISTS env DATE;
ALTER TABLE manutencoes       ADD COLUMN IF NOT EXISTS ret DATE;
ALTER TABLE manutencoes       ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE manutencoes       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

/* EPI descartável (protetor auricular etc.): quando vence vira "Descartado", sem alerta.
   Sem DEFAULT de propósito: a linha seguinte marca só os já cadastrados (NULL) uma única vez
   pelo nome, e depois disso o que o usuário escolher na tela é respeitado. */
ALTER TABLE epis ADD COLUMN IF NOT EXISTS descartavel BOOLEAN;
UPDATE epis SET descartavel = (nome ILIKE '%descart%') WHERE descartavel IS NULL;

/* Apontamentos antigos sem vínculo: liga ao plano pela OP. O realizado do plano
   é recalculado pela soma dos apontamentos a cada listagem (routes/producao.js). */
UPDATE prod_apontamentos_detalhados a SET plano_id = p.id
  FROM prod_planos p WHERE a.plano_id IS NULL AND p.num_op = a.num_op;
UPDATE prod_planos p SET realizado = COALESCE((SELECT SUM(a.realizado) FROM prod_apontamentos_detalhados a WHERE a.plano_id = p.id), 0);

/* Banco de horas: o tipo "Compensação" virou "Desconto" */
UPDATE bh_lancamentos SET tipo = 'Desconto' WHERE tipo = 'Compensação';

/* Células: categoria e nº de operadores (horas disponíveis = operadores × 7 h/dia) */
ALTER TABLE celulas ADD COLUMN IF NOT EXISTS categoria VARCHAR(80);
ALTER TABLE celulas ADD COLUMN IF NOT EXISTS operadores INTEGER NOT NULL DEFAULT 0;
ALTER TABLE celulas ADD COLUMN IF NOT EXISTS horas_operador NUMERIC(5,2) NOT NULL DEFAULT 7;
ALTER TABLE celulas ADD COLUMN IF NOT EXISTS turno VARCHAR(20);   -- '1', '2', '3' ou NULL = todos os turnos

/* Desligamento de colaborador: status 'Desligado' + data. Fica no cadastro, some das listas de seleção. */
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS dt_desligamento DATE;

ALTER TABLE checklist_ferramentas ADD COLUMN IF NOT EXISTS checked BOOLEAN DEFAULT FALSE;
ALTER TABLE checklist_ferramentas ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE checklist_ferramentas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE epis              ADD COLUMN IF NOT EXISTS dur_qtd INTEGER;
ALTER TABLE epis              ADD COLUMN IF NOT EXISTS dur_tipo VARCHAR(40);
ALTER TABLE epis              ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE epis              ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE epi_entregas      ADD COLUMN IF NOT EXISTS qtd INTEGER DEFAULT 1;
ALTER TABLE epi_entregas      ADD COLUMN IF NOT EXISTS dt DATE;
ALTER TABLE epi_entregas      ADD COLUMN IF NOT EXISTS validade DATE;
ALTER TABLE epi_entregas      ADD COLUMN IF NOT EXISTS obs TEXT;

ALTER TABLE epi_checklists    ADD COLUMN IF NOT EXISTS total INTEGER DEFAULT 0;
ALTER TABLE epi_checklists    ADD COLUMN IF NOT EXISTS conformes INTEGER DEFAULT 0;
ALTER TABLE epi_checklists    ADD COLUMN IF NOT EXISTS irregulares INTEGER DEFAULT 0;
ALTER TABLE epi_checklists    ADD COLUMN IF NOT EXISTS pct NUMERIC(6,2) DEFAULT 0;
ALTER TABLE epi_checklists    ADD COLUMN IF NOT EXISTS registros TEXT;

ALTER TABLE bh_lancamentos    ADD COLUMN IF NOT EXISTS minutos INTEGER;
ALTER TABLE bh_lancamentos    ADD COLUMN IF NOT EXISTS motivo VARCHAR(200);
ALTER TABLE bh_lancamentos    ADD COLUMN IF NOT EXISTS justificativa TEXT;

ALTER TABLE bh_convites       ADD COLUMN IF NOT EXISTS data_banco DATE;
ALTER TABLE bh_convites       ADD COLUMN IF NOT EXISTS resposta VARCHAR(40) DEFAULT 'Pendente';
ALTER TABLE bh_convites       ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE bh_convites       ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE bh_atrasos        ADD COLUMN IF NOT EXISTS ponto TIME;
ALTER TABLE bh_atrasos        ADD COLUMN IF NOT EXISTS linha TIME;
ALTER TABLE bh_atrasos        ADD COLUMN IF NOT EXISTS diff INTEGER DEFAULT 0;
ALTER TABLE bh_atrasos        ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE bh_atrasos        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE bh_eventos        ADD COLUMN IF NOT EXISTS tipo VARCHAR(60);
ALTER TABLE bh_eventos        ADD COLUMN IF NOT EXISTS abrangencia VARCHAR(60);
ALTER TABLE bh_eventos        ADD COLUMN IF NOT EXISTS colaborador_id INTEGER;
ALTER TABLE bh_eventos        ADD COLUMN IF NOT EXISTS hora TIME;
ALTER TABLE bh_eventos        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE treinamentos      ADD COLUMN IF NOT EXISTS categoria VARCHAR(120);
ALTER TABLE treinamentos      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE tr_registros      ADD COLUMN IF NOT EXISTS colaborador_id INTEGER;
ALTER TABLE tr_registros      ADD COLUMN IF NOT EXISTS validade DATE;
ALTER TABLE tr_registros      ADD COLUMN IF NOT EXISTS local_treino VARCHAR(200);
ALTER TABLE tr_registros      ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE tr_registros      ADD COLUMN IF NOT EXISTS presenca_id INTEGER;

ALTER TABLE tr_presencas      ADD COLUMN IF NOT EXISTS treinamento_id INTEGER;
ALTER TABLE tr_presencas      ADD COLUMN IF NOT EXISTS data DATE;
ALTER TABLE tr_presencas      ADD COLUMN IF NOT EXISTS instrutor VARCHAR(200);
ALTER TABLE tr_presencas      ADD COLUMN IF NOT EXISTS local_treino VARCHAR(200);
ALTER TABLE tr_presencas      ADD COLUMN IF NOT EXISTS lista TEXT;

ALTER TABLE tr_agenda         ADD COLUMN IF NOT EXISTS hora TIME;
ALTER TABLE tr_agenda         ADD COLUMN IF NOT EXISTS local_treino VARCHAR(200);
ALTER TABLE tr_agenda         ADD COLUMN IF NOT EXISTS obs TEXT;

ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS tipo VARCHAR(30) DEFAULT 'pendencia';
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS hora TIME;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS categoria VARCHAR(120);
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS prioridade VARCHAR(40);
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS status VARCHAR(40);
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS acao TEXT;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS envolvidos TEXT;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS foto TEXT;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS fotos TEXT;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS previsao_conclusao DATE;
ALTER TABLE db_registros      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE db_resumos        ADD COLUMN IF NOT EXISTS data DATE;
ALTER TABLE db_resumos        ADD COLUMN IF NOT EXISTS turno VARCHAR(60);
ALTER TABLE db_resumos        ADD COLUMN IF NOT EXISTS texto TEXT;
ALTER TABLE db_resumos        ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE db_resumos        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE cl_atividades     ADD COLUMN IF NOT EXISTS freq VARCHAR(60);
ALTER TABLE cl_atividades     ADD COLUMN IF NOT EXISTS inicio DATE;
ALTER TABLE cl_atividades     ADD COLUMN IF NOT EXISTS status VARCHAR(40) DEFAULT 'Ativa';
ALTER TABLE cl_atividades     ADD COLUMN IF NOT EXISTS horario TIME;
ALTER TABLE cl_atividades     ADD COLUMN IF NOT EXISTS horario2 TIME;
ALTER TABLE cl_atividades     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE cl_execucoes      ADD COLUMN IF NOT EXISTS hora TIME;

ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS data_limite DATE;
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS cod_decio VARCHAR(50);
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS cod_intelbras VARCHAR(50);
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS descricao VARCHAR(300);
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS produto VARCHAR(300);
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS realizado NUMERIC(12,2) DEFAULT 0;
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS num_op VARCHAR(8);
ALTER TABLE prod_planos       ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'em_andamento';

ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS cod_intelbras VARCHAR(50);
ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS categoria VARCHAR(120);
ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS valor NUMERIC(12,2) DEFAULT 0;
ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS minutos_reportados NUMERIC(10,2) DEFAULT 0;
ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS hora_reportado NUMERIC(10,4) DEFAULT 0;
ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE prod_produtos     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
`;

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(SQL_BASE);
    console.log('  ✓ Tabelas criadas/verificadas');

    // Migrações rodam uma a uma: se o banco for novo, todas viram no-op.
    for (const stmt of SQL_MIGRACOES.split(';').map(s => s.trim()).filter(Boolean)) {
      try {
        await client.query(stmt);
      } catch (e) {
        console.warn('  ! Migração ignorada:', e.message.split('\n')[0]);
      }
    }
    console.log('  ✓ Migrações aplicadas');

    await client.query(SQL_FOTOS_GATILHOS);
  } finally {
    client.release();
  }

  await migrarFotosAntigas();
  console.log('  ✓ Fotos prontas');
}

module.exports = { initDB };
