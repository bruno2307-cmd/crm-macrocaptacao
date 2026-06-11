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

// Detecta se está rodando no Vercel/Neon (usa Postgres) ou local (usa JSON)
const USE_POSTGRES = !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);

// ── Banco Postgres (Neon) ──────────────────────────────────────────────────

let sqlFn;
let dbReady;

if (USE_POSTGRES) {
  const { neon } = require('@neondatabase/serverless');
  sqlFn = neon(process.env.POSTGRES_URL || process.env.DATABASE_URL);

  dbReady = (async () => {
    await sqlFn`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        telefone TEXT,
        curso_interesse TEXT,
        data_captacao TEXT,
        hora_captacao TEXT,
        unidade TEXT,
        status TEXT DEFAULT 'novo',
        agendado_data TEXT,
        agendado_hora TEXT,
        vendedora TEXT,
        obs TEXT,
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sqlFn`
      CREATE TABLE IF NOT EXISTS historico (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        acao TEXT,
        descricao TEXT,
        vendedora TEXT,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )`;
  })();
}

// ── Banco JSON (local) ─────────────────────────────────────────────────────

function readDB() {
  if (!fs.existsSync(DATA_FILE)) return { leads: [], historico: [], _seq: { leads: 1, historico: 1 } };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeDB(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function nextId(db, table) {
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

// ── Leads — Postgres (Neon) ────────────────────────────────────────────────

if (USE_POSTGRES) {

  app.get('/api/leads', auth, async (req, res) => {
    await dbReady;
    const { status, search, unidade } = req.query;
    const cidade = req.user.cidade || (req.user.role === 'admin' ? unidade : null) || null;

    let rows;
    if (cidade && search && status && status !== 'todos') {
      rows = await sqlFn`SELECT * FROM leads WHERE unidade=${cidade} AND status=${status} AND (nome ILIKE ${'%'+search+'%'} OR telefone ILIKE ${'%'+search+'%'} OR curso_interesse ILIKE ${'%'+search+'%'}) ORDER BY id DESC`;
    } else if (cidade && search) {
      rows = await sqlFn`SELECT * FROM leads WHERE unidade=${cidade} AND (nome ILIKE ${'%'+search+'%'} OR telefone ILIKE ${'%'+search+'%'} OR curso_interesse ILIKE ${'%'+search+'%'}) ORDER BY id DESC`;
    } else if (cidade && status && status !== 'todos') {
      rows = await sqlFn`SELECT * FROM leads WHERE unidade=${cidade} AND status=${status} ORDER BY id DESC`;
    } else if (cidade) {
      rows = await sqlFn`SELECT * FROM leads WHERE unidade=${cidade} ORDER BY id DESC`;
    } else if (search && status && status !== 'todos') {
      rows = await sqlFn`SELECT * FROM leads WHERE status=${status} AND (nome ILIKE ${'%'+search+'%'} OR telefone ILIKE ${'%'+search+'%'} OR curso_interesse ILIKE ${'%'+search+'%'}) ORDER BY id DESC`;
    } else if (search) {
      rows = await sqlFn`SELECT * FROM leads WHERE nome ILIKE ${'%'+search+'%'} OR telefone ILIKE ${'%'+search+'%'} OR curso_interesse ILIKE ${'%'+search+'%'} ORDER BY id DESC`;
    } else if (status && status !== 'todos') {
      rows = await sqlFn`SELECT * FROM leads WHERE status=${status} ORDER BY id DESC`;
    } else {
      rows = await sqlFn`SELECT * FROM leads ORDER BY id DESC`;
    }
    res.json(rows);
  });

  app.get('/api/leads/:id', auth, async (req, res) => {
    await dbReady;
    const found = await sqlFn`SELECT * FROM leads WHERE id=${req.params.id}`;
    if (!found[0]) return res.status(404).json({ error: 'Lead não encontrado' });
    const lead = found[0];
    if (req.user.cidade && lead.unidade !== req.user.cidade) return res.status(403).json({ error: 'Acesso negado' });
    const hist = await sqlFn`SELECT * FROM historico WHERE lead_id=${lead.id} ORDER BY id DESC`;
    res.json({ ...lead, historico: hist });
  });

  app.post('/api/leads', auth, async (req, res) => {
    await dbReady;
    const { nome, telefone, curso_interesse, data_captacao, hora_captacao, obs, vendedora } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const unidade = req.user.cidade || req.body.unidade;
    if (!unidade) return res.status(400).json({ error: 'Cidade é obrigatória' });
    const hoje = new Date().toISOString().split('T')[0];
    const agora = new Date().toTimeString().slice(0, 5);
    const inserted = await sqlFn`
      INSERT INTO leads (nome, telefone, curso_interesse, data_captacao, hora_captacao, unidade, vendedora, obs)
      VALUES (${nome.trim()}, ${telefone||null}, ${curso_interesse||null}, ${data_captacao||hoje}, ${hora_captacao||agora}, ${unidade}, ${vendedora||null}, ${obs||null})
      RETURNING *`;
    const lead = inserted[0];
    await sqlFn`INSERT INTO historico (lead_id, acao, descricao, vendedora) VALUES (${lead.id}, 'criado', 'Lead cadastrado', ${vendedora||req.user.nome||null})`;
    res.json(lead);
  });

  app.put('/api/leads/:id', auth, async (req, res) => {
    await dbReady;
    const existing = await sqlFn`SELECT * FROM leads WHERE id=${req.params.id}`;
    if (!existing[0]) return res.status(404).json({ error: 'Lead não encontrado' });
    const lead = existing[0];
    if (req.user.cidade && lead.unidade !== req.user.cidade) return res.status(403).json({ error: 'Acesso negado' });

    const b = req.body;
    const statusAnterior = lead.status;
    const isAdmin = req.user.role === 'admin';

    const updated = await sqlFn`
      UPDATE leads SET
        nome = COALESCE(${b.nome ?? null}, nome),
        telefone = COALESCE(${b.telefone ?? null}, telefone),
        curso_interesse = COALESCE(${b.curso_interesse ?? null}, curso_interesse),
        data_captacao = COALESCE(${b.data_captacao ?? null}, data_captacao),
        hora_captacao = COALESCE(${b.hora_captacao ?? null}, hora_captacao),
        unidade = CASE WHEN ${isAdmin && b.unidade != null} THEN ${b.unidade ?? lead.unidade} ELSE unidade END,
        status = COALESCE(${b.status ?? null}, status),
        agendado_data = COALESCE(${b.agendado_data ?? null}, agendado_data),
        agendado_hora = COALESCE(${b.agendado_hora ?? null}, agendado_hora),
        vendedora = COALESCE(${b.vendedora ?? null}, vendedora),
        obs = COALESCE(${b.obs ?? null}, obs),
        atualizado_em = NOW()
      WHERE id = ${req.params.id}
      RETURNING *`;

    if (b.status && b.status !== statusAnterior) {
      const labels = { novo: 'Novo', em_contato: 'Em Contato', agendado: 'Agendado', nao_atendeu: 'Não Atendeu', nao_compareceu: 'Não Compareceu', matriculado: 'Matriculado', desistiu: 'Desistiu' };
      await sqlFn`INSERT INTO historico (lead_id, acao, descricao, vendedora) VALUES (${req.params.id}, 'status', ${`${labels[statusAnterior]||statusAnterior} → ${labels[b.status]||b.status}`}, ${b.vendedora||req.user.nome||null})`;
    }
    res.json(updated[0]);
  });

  app.delete('/api/leads/:id', auth, async (req, res) => {
    await dbReady;
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas o admin pode excluir' });
    await sqlFn`DELETE FROM leads WHERE id=${req.params.id}`;
    res.json({ success: true });
  });

  app.get('/api/stats', auth, async (req, res) => {
    await dbReady;
    const cidade = req.user.cidade || (req.user.role === 'admin' ? req.query.unidade : null) || null;
    const statusRows = cidade
      ? await sqlFn`SELECT status, COUNT(*) as n FROM leads WHERE unidade=${cidade} GROUP BY status`
      : await sqlFn`SELECT status, COUNT(*) as n FROM leads GROUP BY status`;
    const s = {};
    statusRows.forEach(r => { s[r.status] = Number(r.n); });
    const total = Object.values(s).reduce((a, b) => a + b, 0);

    const hoje = new Date().toISOString().split('T')[0];
    const todayRows = cidade
      ? await sqlFn`SELECT COUNT(*) as n FROM leads WHERE unidade=${cidade} AND DATE(criado_em) = ${hoje}`
      : await sqlFn`SELECT COUNT(*) as n FROM leads WHERE DATE(criado_em) = ${hoje}`;

    res.json({
      total, hoje: Number(todayRows[0].n),
      novo: s.novo||0, em_contato: s.em_contato||0, agendado: s.agendado||0,
      nao_atendeu: s.nao_atendeu||0, nao_compareceu: s.nao_compareceu||0,
      matriculado: s.matriculado||0, desistiu: s.desistiu||0,
      taxa_conversao: total > 0 ? Math.round((s.matriculado||0)/total*100) : 0,
      taxa_agendamento: total > 0 ? Math.round(((s.agendado||0)+(s.matriculado||0))/total*100) : 0,
    });
  });

  app.get('/api/cursos', auth, async (req, res) => {
    await dbReady;
    const cidade = req.user.cidade;
    const rows = cidade
      ? await sqlFn`SELECT DISTINCT curso_interesse FROM leads WHERE unidade=${cidade} AND curso_interesse IS NOT NULL ORDER BY curso_interesse`
      : await sqlFn`SELECT DISTINCT curso_interesse FROM leads WHERE curso_interesse IS NOT NULL ORDER BY curso_interesse`;
    res.json(rows.map(r => r.curso_interesse));
  });

// ── Leads — JSON (local) ───────────────────────────────────────────────────

} else {

  app.get('/api/leads', auth, (req, res) => {
    const { status, search, unidade } = req.query;
    const db = readDB();
    let base = leadsVisiveis(db.leads, req.user);
    if (!req.user.cidade && unidade) base = base.filter(l => l.unidade === unidade);
    if (status && status !== 'todos') base = base.filter(l => l.status === status);
    if (search) { const q = search.toLowerCase(); base = base.filter(l => [l.nome, l.telefone, l.curso_interesse].some(v => v?.toLowerCase().includes(q))); }
    res.json(base.sort((a, b) => b.id - a.id));
  });

  app.get('/api/leads/:id', auth, (req, res) => {
    const db = readDB();
    const lead = db.leads.find(l => l.id === Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (req.user.cidade && lead.unidade !== req.user.cidade) return res.status(403).json({ error: 'Acesso negado' });
    const historico = db.historico.filter(h => h.lead_id === lead.id).sort((a, b) => b.id - a.id);
    res.json({ ...lead, historico });
  });

  app.post('/api/leads', auth, (req, res) => {
    const { nome, telefone, curso_interesse, data_captacao, hora_captacao, obs, vendedora } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const unidade = req.user.cidade || req.body.unidade;
    if (!unidade) return res.status(400).json({ error: 'Cidade é obrigatória' });
    const db = readDB();
    const lead = { id: nextId(db,'leads'), nome: nome.trim(), telefone: telefone||null, curso_interesse: curso_interesse||null, data_captacao: data_captacao||new Date().toISOString().split('T')[0], hora_captacao: hora_captacao||new Date().toTimeString().slice(0,5), unidade, status:'novo', agendado_data:null, agendado_hora:null, vendedora:vendedora||null, obs:obs||null, criado_em:nowStr(), atualizado_em:nowStr() };
    db.leads.push(lead);
    db.historico.push({ id:nextId(db,'historico'), lead_id:lead.id, acao:'criado', descricao:'Lead cadastrado', vendedora:vendedora||req.user.nome||null, criado_em:nowStr() });
    writeDB(db);
    res.json(lead);
  });

  app.put('/api/leads/:id', auth, (req, res) => {
    const db = readDB();
    const idx = db.leads.findIndex(l => l.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Lead não encontrado' });
    const lead = db.leads[idx];
    if (req.user.cidade && lead.unidade !== req.user.cidade) return res.status(403).json({ error: 'Acesso negado' });
    const statusAnterior = lead.status;
    const campos = ['nome','telefone','curso_interesse','data_captacao','hora_captacao','status','agendado_data','agendado_hora','vendedora','obs'];
    if (req.user.role === 'admin') campos.push('unidade');
    for (const c of campos) { if (c in req.body) lead[c] = req.body[c]; }
    lead.atualizado_em = nowStr();
    db.leads[idx] = lead;
    if (req.body.status && req.body.status !== statusAnterior) {
      const L = { novo:'Novo',em_contato:'Em Contato',agendado:'Agendado',nao_atendeu:'Não Atendeu',nao_compareceu:'Não Compareceu',matriculado:'Matriculado',desistiu:'Desistiu' };
      db.historico.push({ id:nextId(db,'historico'), lead_id:lead.id, acao:'status', descricao:`${L[statusAnterior]||statusAnterior} → ${L[req.body.status]||req.body.status}`, vendedora:req.body.vendedora||req.user.nome||null, criado_em:nowStr() });
    }
    writeDB(db);
    res.json(lead);
  });

  app.delete('/api/leads/:id', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas o admin pode excluir' });
    const db = readDB();
    const id = Number(req.params.id);
    db.leads = db.leads.filter(l => l.id !== id);
    db.historico = db.historico.filter(h => h.lead_id !== id);
    writeDB(db);
    res.json({ success: true });
  });

  app.get('/api/stats', auth, (req, res) => {
    const db = readDB();
    let base = leadsVisiveis(db.leads, req.user);
    if (!req.user.cidade && req.query.unidade) base = base.filter(l => l.unidade === req.query.unidade);
    const total = base.length;
    const s = {};
    base.forEach(l => { s[l.status] = (s[l.status]||0)+1; });
    const hoje = new Date().toISOString().split('T')[0];
    res.json({ total, hoje:base.filter(l=>l.criado_em?.startsWith(hoje)).length, novo:s.novo||0, em_contato:s.em_contato||0, agendado:s.agendado||0, nao_atendeu:s.nao_atendeu||0, nao_compareceu:s.nao_compareceu||0, matriculado:s.matriculado||0, desistiu:s.desistiu||0, taxa_conversao:total>0?Math.round((s.matriculado||0)/total*100):0, taxa_agendamento:total>0?Math.round(((s.agendado||0)+(s.matriculado||0))/total*100):0 });
  });

  app.get('/api/cursos', auth, (req, res) => {
    const db = readDB();
    const base = leadsVisiveis(db.leads, req.user);
    res.json([...new Set(base.map(l=>l.curso_interesse).filter(Boolean))].sort());
  });

}

// ── Meta (comum) ───────────────────────────────────────────────────────────

app.get('/api/cidades', auth, (req, res) => {
  if (req.user.cidade) return res.json([req.user.cidade]);
  res.json(CIDADES);
});

// ── Export para Vercel / Listen local ─────────────────────────────────────

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅  CRM Macrocaptação ${USE_POSTGRES ? '(Postgres)' : '(JSON local)'}\n`);
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
