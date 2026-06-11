const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { networkInterfaces } = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'crm-macrocaptacao-secret-local';
const USERS_FILE = path.join(__dirname, 'users.json');
const DATA_FILE = path.join(__dirname, 'leads.json');
const CIDADES = ['Santa Fé do Sul', 'Aparecida do Taboado', 'Paranaíba'];

// Detecta modo de armazenamento
const USE_GITHUB = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'bruno2307-cmd/crm-macrocaptacao-data';
const DB_FILE_PATH = 'db.json';

// ── Banco GitHub (Vercel) ──────────────────────────────────────────────────

async function githubReadDB() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) return { leads: [], historico: [], _seq: { leads: 1, historico: 1 }, _sha: null };
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  content._sha = data.sha;
  return content;
}

async function githubWriteDB(data) {
  const sha = data._sha;
  const payload = { ...data };
  delete payload._sha;
  const encoded = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DB_FILE_PATH}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'update crm db', content: encoded, sha }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub write failed: ${err.message}`);
  }
  const result = await res.json();
  return result.content.sha;
}

// ── Banco JSON local ───────────────────────────────────────────────────────

function localReadDB() {
  if (!fs.existsSync(DATA_FILE)) return { leads: [], historico: [], _seq: { leads: 1, historico: 1 } };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function localWriteDB(data) {
  const tmp = DATA_FILE + '.tmp';
  const payload = { ...data };
  delete payload._sha;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ── Wrappers unificados ────────────────────────────────────────────────────

async function readDB() {
  return USE_GITHUB ? githubReadDB() : localReadDB();
}

async function writeDB(data) {
  if (USE_GITHUB) {
    await githubWriteDB(data);
  } else {
    localWriteDB(data);
  }
}

function nextId(db, table) {
  if (!db._seq) db._seq = { leads: 1, historico: 1 };
  const id = db._seq[table] || 1;
  db._seq[table] = id + 1;
  return id;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users;
}

function leadsVisiveis(leads, user) {
  return user.cidade ? leads.filter(l => l.unidade === user.cidade) : leads;
}

// ── Auth JWT ───────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, nome: user.nome, cidade: user.cidade, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada ou inválida' });
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Login ──────────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = readUsers().find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, nome: user.nome, cidade: user.cidade, role: user.role } });
});

app.post('/api/logout', auth, (_req, res) => res.json({ success: true }));
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ── Leads ──────────────────────────────────────────────────────────────────

app.get('/api/leads', auth, async (req, res) => {
  try {
    const { status, search, unidade } = req.query;
    const db = await readDB();
    let base = leadsVisiveis(db.leads, req.user);
    if (!req.user.cidade && unidade) base = base.filter(l => l.unidade === unidade);
    if (status && status !== 'todos') base = base.filter(l => l.status === status);
    if (search) {
      const q = search.toLowerCase();
      base = base.filter(l => [l.nome, l.telefone, l.curso_interesse].some(v => v?.toLowerCase().includes(q)));
    }
    res.json(base.sort((a, b) => b.id - a.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id', auth, async (req, res) => {
  try {
    const db = await readDB();
    const lead = db.leads.find(l => l.id === Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (req.user.cidade && lead.unidade !== req.user.cidade) return res.status(403).json({ error: 'Acesso negado' });
    const historico = (db.historico || []).filter(h => h.lead_id === lead.id).sort((a, b) => b.id - a.id);
    res.json({ ...lead, historico });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', auth, async (req, res) => {
  try {
    const { nome, telefone, curso_interesse, data_captacao, hora_captacao, obs, vendedora } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const unidade = req.user.cidade || req.body.unidade;
    if (!unidade) return res.status(400).json({ error: 'Cidade é obrigatória' });
    const db = await readDB();
    const lead = {
      id: nextId(db, 'leads'),
      nome: nome.trim(),
      telefone: telefone || null,
      curso_interesse: curso_interesse || null,
      data_captacao: data_captacao || new Date().toISOString().split('T')[0],
      hora_captacao: hora_captacao || new Date().toTimeString().slice(0, 5),
      unidade,
      status: 'novo',
      agendado_data: null,
      agendado_hora: null,
      vendedora: vendedora || null,
      obs: obs || null,
      criado_em: nowStr(),
      atualizado_em: nowStr(),
    };
    db.leads.push(lead);
    if (!db.historico) db.historico = [];
    db.historico.push({ id: nextId(db, 'historico'), lead_id: lead.id, acao: 'criado', descricao: 'Lead cadastrado', vendedora: vendedora || req.user.nome || null, criado_em: nowStr() });
    await writeDB(db);
    res.json(lead);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/leads/:id', auth, async (req, res) => {
  try {
    const db = await readDB();
    const idx = db.leads.findIndex(l => l.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Lead não encontrado' });
    const lead = db.leads[idx];
    if (req.user.cidade && lead.unidade !== req.user.cidade) return res.status(403).json({ error: 'Acesso negado' });
    const statusAnterior = lead.status;
    const campos = ['nome', 'telefone', 'curso_interesse', 'data_captacao', 'hora_captacao', 'status', 'agendado_data', 'agendado_hora', 'vendedora', 'obs'];
    if (req.user.role === 'admin') campos.push('unidade');
    for (const c of campos) { if (c in req.body) lead[c] = req.body[c]; }
    lead.atualizado_em = nowStr();
    db.leads[idx] = lead;
    if (req.body.status && req.body.status !== statusAnterior) {
      if (!db.historico) db.historico = [];
      const L = { novo: 'Novo', em_contato: 'Em Contato', agendado: 'Agendado', nao_atendeu: 'Não Atendeu', nao_compareceu: 'Não Compareceu', matriculado: 'Matriculado', desistiu: 'Desistiu' };
      db.historico.push({ id: nextId(db, 'historico'), lead_id: lead.id, acao: 'status', descricao: `${L[statusAnterior] || statusAnterior} → ${L[req.body.status] || req.body.status}`, vendedora: req.body.vendedora || req.user.nome || null, criado_em: nowStr() });
    }
    await writeDB(db);
    res.json(lead);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/leads/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas o admin pode excluir' });
    const db = await readDB();
    const id = Number(req.params.id);
    db.leads = db.leads.filter(l => l.id !== id);
    db.historico = (db.historico || []).filter(h => h.lead_id !== id);
    await writeDB(db);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', auth, async (req, res) => {
  try {
    const db = await readDB();
    let base = leadsVisiveis(db.leads, req.user);
    if (!req.user.cidade && req.query.unidade) base = base.filter(l => l.unidade === req.query.unidade);
    const total = base.length;
    const s = {};
    base.forEach(l => { s[l.status] = (s[l.status] || 0) + 1; });
    const hoje = new Date().toISOString().split('T')[0];
    res.json({
      total,
      hoje: base.filter(l => l.criado_em?.startsWith(hoje)).length,
      novo: s.novo || 0, em_contato: s.em_contato || 0, agendado: s.agendado || 0,
      nao_atendeu: s.nao_atendeu || 0, nao_compareceu: s.nao_compareceu || 0,
      matriculado: s.matriculado || 0, desistiu: s.desistiu || 0,
      taxa_conversao: total > 0 ? Math.round((s.matriculado || 0) / total * 100) : 0,
      taxa_agendamento: total > 0 ? Math.round(((s.agendado || 0) + (s.matriculado || 0)) / total * 100) : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cursos', auth, async (req, res) => {
  try {
    const db = await readDB();
    const base = leadsVisiveis(db.leads, req.user);
    res.json([...new Set(base.map(l => l.curso_interesse).filter(Boolean))].sort());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cidades', auth, (req, res) => {
  if (req.user.cidade) return res.json([req.user.cidade]);
  res.json(CIDADES);
});

// ── Export para Vercel / Listen local ─────────────────────────────────────

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅  CRM Macrocaptação (${USE_GITHUB ? 'GitHub DB' : 'JSON local'})\n`);
    console.log(`    http://localhost:${PORT}\n`);
    const nets = networkInterfaces();
    for (const n of Object.keys(nets)) {
      for (const net of nets[n]) {
        if (net.family === 'IPv4' && !net.internal)
          console.log(`    Rede: http://${net.address}:${PORT}`);
      }
    }
    console.log('\n    Logins: admin/admin123 | santafe/santafe123 | taboado/taboado123 | paranaiba/paranaiba123\n');
  });
}
