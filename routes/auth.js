const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireAdmin, PAPEIS } = require('../middleware/auth');

/* POST /api/login */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Informe usuário e senha' });
    }

    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username.trim()]);
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    const user = r.rows[0];
    if (user.ativo === false) {
      return res.status(403).json({ error: 'Usuário desativado. Fale com o administrador.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.nome = user.nome;

    res.json({ success: true, nome: user.nome, role: user.role });
  } catch (e) {
    console.error('Erro no login:', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/* POST /api/logout */
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Erro ao encerrar sessão' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

/* GET /api/me */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    userId: req.session.userId,
    username: req.session.username,
    nome: req.session.nome,
    role: req.session.role
  });
});

/* GET /api/users */
router.get('/users', requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, nome, role, ativo, created_at FROM users ORDER BY nome'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /api/users */
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, nome, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres' });
    }

    const existe = await pool.query('SELECT id FROM users WHERE username=$1', [username.trim()]);
    if (existe.rows.length) return res.status(409).json({ error: 'Esse usuário já existe' });

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (username,password,nome,role) VALUES ($1,$2,$3,$4)
       RETURNING id, username, nome, role, ativo, created_at`,
      [username.trim(), hash, nome || username.trim(), PAPEIS.includes(role) ? role : 'user']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PUT /api/users/:id */
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { nome, role, ativo } = req.body;
    const id = parseInt(req.params.id, 10);

    if (id === req.session.userId && (role !== 'admin' || ativo === false)) {
      return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de administrador' });
    }

    const r = await pool.query(
      `UPDATE users SET nome=COALESCE($1,nome), role=COALESCE($2,role), ativo=COALESCE($3,ativo)
       WHERE id=$4 RETURNING id, username, nome, role, ativo, created_at`,
      [nome || null, PAPEIS.includes(role) ? role : null, typeof ativo === 'boolean' ? ativo : null, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PUT /api/users/:id/password — o próprio usuário ou um admin */
router.put('/users/:id/password', requireAuth, async (req, res) => {
  try {
    const alvo = parseInt(req.params.id, 10);
    if (req.session.userId !== alvo && req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres' });
    }

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query('UPDATE users SET password=$1 WHERE id=$2 RETURNING id', [hash, alvo]);
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* DELETE /api/users/:id */
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.session.userId === id) {
      return res.status(400).json({ error: 'Você não pode excluir o próprio usuário' });
    }
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
