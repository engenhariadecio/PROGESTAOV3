require('dotenv').config();

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');

const { pool } = require('./db');
const { initDB } = require('./db/schema');
const { seed } = require('./db/seed');
const { requireAuth, requireAdmin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const EM_PRODUCAO = process.env.NODE_ENV === 'production';

// Railway roda atrás de proxy — necessário para cookie secure funcionar
if (EM_PRODUCAO) app.set('trust proxy', 1);

/* ════════════════ MIDDLEWARES ════════════════ */

app.use(express.json({ limit: '12mb' }));
// quadros da câmera do contador chegam a cada ~0,7 s por celular: sem log e sem sessão regravada

app.use(express.urlencoded({ extended: true, limit: '12mb' }));

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || 'decio-montagem-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 12 * 60 * 60 * 1000,   // 12h — cobre um turno inteiro
    httpOnly: true,
    sameSite: 'lax',
    secure: EM_PRODUCAO
  }
}));

/* Só assets são servidos estaticamente. Os HTML passam obrigatoriamente
   pelas rotas abaixo, que exigem sessão — servir a pasta inteira deixaria
   /admin.html acessível sem login. */
const estatico = (sub) => express.static(path.join(__dirname, 'public', sub), { maxAge: '1h' });
app.use('/css',    estatico('css'));
app.use('/js',     estatico('js'));
app.use('/assets', estatico('assets'));

app.get('/cadenciador.webmanifest', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'cadenciador.webmanifest')));

/* ════════════════ API ════════════════ */

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', erro: e.message });
  }
});

app.use(require('./middleware/auth').restringirPcp);
app.use('/api', require('./routes/auth'));
app.use('/api/config', require('./routes/config'));
app.use('/api/colaboradores', require('./routes/colaboradores'));
app.use('/api/ponto', require('./routes/ponto'));
app.use('/api/cadenciador', require('./routes/cadenciador'));
app.use('/api/ferramentas', require('./routes/ferramentas'));
app.use('/api/epis', require('./routes/epis'));
app.use('/api', require('./routes/banco-horas'));
app.use('/api', require('./routes/treinamentos'));
app.use('/api', require('./routes/diario'));
app.use('/api', require('./routes/checklist'));
app.use('/api', require('./routes/producao'));
app.use('/api', require('./routes/produtos'));
app.use('/api/limpeza', require('./routes/limpeza'));
app.use('/api/contador', require('./routes/contador'));
app.use('/api/fotos', require('./routes/fotos'));
app.use('/api/export', require('./routes/export'));

/* ════════════════ PÁGINAS ════════════════ */

const pagina = (...p) => path.join(__dirname, 'public', ...p);

app.get('/login', (_req, res) => res.sendFile(pagina('login.html')));

// Portal — ponto único de entrada
app.get('/', requireAuth, (_req, res) => res.sendFile(pagina('index.html')));

// Painel administrador central
app.get('/admin', requireAdmin, (_req, res) => res.sendFile(pagina('admin.html')));

// Sistema 1 e 2
app.get('/ponto', requireAuth, (_req, res) => res.sendFile(pagina('ponto.html')));
app.get('/cadenciador', requireAuth, (_req, res) => res.sendFile(pagina('cadenciador.html')));

// Contador por câmera (celular na linha) e painel ao vivo
// Câmera do pallet faz parte do Cadenciador: /cadenciador/camera (aparelho que filma) e /cadenciador/painel (ver/configurar de qualquer lugar)
app.get(['/cadenciador/camera', '/contador'], requireAuth, (_req, res) => res.sendFile(pagina('contador.html')));
app.get(['/cadenciador/painel', '/contador/painel'], requireAuth, (_req, res) => res.sendFile(pagina('contador-painel.html')));

// Sistema 3 — ProGestão
const MODULOS_PROGESTAO = [
  'ferramentas', 'epis', 'banco-horas',
  'treinamentos', 'diario-bordo', 'checklist', 'producao', 'limpeza'
];

app.get('/progestao', requireAuth, (_req, res) => res.sendFile(pagina('progestao', 'index.html')));

MODULOS_PROGESTAO.forEach(m => {
  app.get('/progestao/' + m, requireAuth, (_req, res) => res.sendFile(pagina('progestao', m + '.html')));
});

/* ════════════════ FALLBACK ════════════════ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Rota não encontrada' });
  }
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.redirect('/');
});

app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

/* ════════════════ BOOT ════════════════ */

async function iniciar() {
  try {
    console.log('┌────────────────────────────────────────────┐');
    console.log('│  DÉCIO — Sistema Integrado da Montagem      │');
    console.log('└────────────────────────────────────────────┘');

    console.log('› Preparando banco de dados...');
    await initDB();

    if (process.env.SEED_ON_BOOT !== 'false') {
      console.log('› Verificando dados iniciais...');
      await seed();
    }

    /* HTTPS=1: sobe com certificado autoassinado (rede local). A câmera do celular só
       abre em HTTPS — no primeiro acesso o navegador avisa "não seguro": Avançado → Continuar. */
    const aoSubir = (proto) => () => {
      console.log(`› Servidor no ar: ${proto}://localhost:${PORT}`);
      const nets = require('os').networkInterfaces();
      for (const k of Object.keys(nets)) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) console.log(`›   na rede local: ${proto}://${n.address}:${PORT}`);
      console.log(`› Ambiente: ${EM_PRODUCAO ? 'produção' : 'desenvolvimento'}`);
    };
    if (process.env.HTTPS === '1') {
      const fs = require('fs'), path = require('path');
      const dir = path.join(__dirname, '.cert'), kf = path.join(dir, 'key.pem'), cf = path.join(dir, 'cert.pem');
      if (!fs.existsSync(kf) || !fs.existsSync(cf)) {
        const pems = require('selfsigned').generate([{ name: 'commonName', value: 'decio-montagem.local' }], { days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] });
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(kf, pems.private); fs.writeFileSync(cf, pems.cert);
        console.log('› Certificado autoassinado gerado em .cert/');
      }
      require('https').createServer({ key: fs.readFileSync(kf), cert: fs.readFileSync(cf) }, app).listen(PORT, '0.0.0.0', aoSubir('https'));
    } else {
      app.listen(PORT, '0.0.0.0', aoSubir('http'));
    }
  } catch (err) {
    console.error('Falha ao iniciar:', err);
    process.exit(1);
  }
}

iniciar();
