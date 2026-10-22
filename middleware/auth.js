function ehApi(req) {
  return req.xhr
    || req.path.startsWith('/api/')
    || (req.headers.accept && req.headers.accept.includes('json'));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (ehApi(req)) return res.status(401).json({ error: 'Não autenticado' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (ehApi(req)) return res.status(401).json({ error: 'Não autenticado' });
    return res.redirect('/login');
  }
  if (req.session.role === 'admin') return next();
  if (ehApi(req)) return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  return res.redirect('/');
}

/*
 * Perfil "pcp": só enxerga ProGestão › Produção, e só leitura.
 * Vale no servidor, para toda rota: o que não está na lista abaixo recebe
 * 403 (API) ou vai para /progestao/producao (página). Assim, mesmo digitando
 * uma URL ou chamando a API direto, o usuário não vê nem altera o resto.
 */
const PCP_PAGINAS = ['/login', '/progestao/producao', '/cadenciador/painel', '/contador/painel'];
const PCP_API_LEITURA = /^\/api\/(me|prod-planos|prod-apontamentos|prod-apontamentos-detalhados|prod-produtos|prod-celulas|contador|export\/contador|cadenciador\/sessoes|fotos\/produto|fotos\/arquivo)(\/|$|\?)/;   // fotos: só as dos produtos
const PCP_API_LIVRE = /^\/api\/(logout|login)$/;

function restringirPcp(req, res, next) {
  if (!req.session || req.session.role !== 'pcp') return next();
  const p = req.path;
  if (/^\/(css|js|assets|img|fonts)\//.test(p) || p === '/favicon.ico') return next();
  if (p.startsWith('/api/')) {
    if (PCP_API_LIVRE.test(p)) return next();
    if (req.method === 'GET' && PCP_API_LEITURA.test(p)) return next();
    return res.status(403).json({ error: 'Perfil PCP: somente visualização de Produção' });
  }
  if (PCP_PAGINAS.includes(p)) return next();
  if (p === '/contador' || p === '/cadenciador/camera' || p === '/cadenciador') return res.redirect('/cadenciador/painel');   // PCP só assiste; não liga câmera
  return res.redirect('/progestao/producao');
}

const PAPEIS = ['admin', 'user', 'pcp'];

module.exports = { requireAuth, requireAdmin, restringirPcp, PAPEIS };
