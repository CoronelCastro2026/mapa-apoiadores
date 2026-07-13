// Mapa de Apoiadores — servidor v2
// SQLite permanente + cadastro externo por link + hierarquia + integração n8n (WhatsApp)
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SENHA = process.env.SENHA;
const SECRET = process.env.SECRET;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ''; // seu fluxo de WhatsApp recebe cada novo cadastro aqui
const N8N_KEY = process.env.N8N_KEY || '';                 // chave para o n8n gravar dados de volta
if (!SENHA || !SECRET) { console.error('Defina SENHA e SECRET.'); process.exit(1); }

const DATA_DIR = path.join(__dirname, 'data');
const BKP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BKP_DIR, { recursive: true });

const MUNS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'municipios.json'), 'utf8'));
const MUN_NOME = Object.fromEntries(MUNS.map(m => [m.id, m.n]));

const db = new Database(path.join(DATA_DIR, 'mapa.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS dobradas(
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, ini TEXT NOT NULL, cor TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pessoas(
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    grau TEXT NOT NULL,            -- Coordenador | Cabo Eleitoral | Apoiador
    num INTEGER,                   -- número do coordenador
    votos INTEGER DEFAULT 0,
    zap TEXT, endereco TEXT, email TEXT,
    dob_id TEXT, obs TEXT,
    mun_id TEXT NOT NULL,          -- código IBGE
    pai_id TEXT,                   -- quem cadastrou (hierarquia)
    codigo TEXT UNIQUE             -- código do link de cadastro (coordenador/cabo)
  );
  CREATE TABLE IF NOT EXISTS pessoa_muns(
    pessoa_id TEXT NOT NULL, mun_id TEXT NOT NULL, PRIMARY KEY(pessoa_id, mun_id)
  );
`);

// ---------- util ----------
const rid = p => p + crypto.randomBytes(6).toString('hex');
const novoCodigo = () => crypto.randomBytes(5).toString('hex');
function proxNum() {
  return (db.prepare('SELECT COALESCE(MAX(num),0) m FROM pessoas').get().m) + 1;
}
function pessoaOut(p) {
  return {
    id: p.id, nome: p.nome, grau: p.grau, num: p.num || undefined,
    votos: p.votos || 0, zap: p.zap || '', endereco: p.endereco || '', email: p.email || '',
    dobId: p.dob_id || null, obs: p.obs || '', munId: p.mun_id,
    paiId: p.pai_id || null, codigo: p.codigo || null,
    muns: db.prepare('SELECT mun_id FROM pessoa_muns WHERE pessoa_id=?').all(p.id).map(r => r.mun_id)
  };
}
function inserirPessoa(x) {
  const id = x.id || rid('p');
  const precisaCodigo = (x.grau === 'Coordenador' || x.grau === 'Cabo Eleitoral');
  const num = x.grau === 'Coordenador' ? (x.num || proxNum()) : null;
  db.prepare(`INSERT INTO pessoas(id,nome,grau,num,votos,zap,endereco,email,dob_id,obs,mun_id,pai_id,codigo)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, x.nome, x.grau, num, +x.votos || 0, x.zap || '', x.endereco || '', x.email || '',
         x.dobId || null, x.obs || '', String(x.munId), x.paiId || null,
         x.codigo || (precisaCodigo ? novoCodigo() : null));
  const setM = db.prepare('INSERT OR IGNORE INTO pessoa_muns(pessoa_id,mun_id) VALUES (?,?)');
  for (const m of x.muns || []) setM.run(id, String(m));
  return pessoaOut(db.prepare('SELECT * FROM pessoas WHERE id=?').get(id));
}
let ultimoBkp = 0;
function backup() {
  if (Date.now() - ultimoBkp < 10 * 60 * 1000) return; // no máximo 1 a cada 10 min
  ultimoBkp = Date.now();
  try {
    const dados = montarTudo();
    const nome = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16) + '.json';
    fs.writeFileSync(path.join(BKP_DIR, nome), JSON.stringify(dados));
    const arqs = fs.readdirSync(BKP_DIR).sort();
    while (arqs.length > 60) fs.unlinkSync(path.join(BKP_DIR, arqs.shift()));
  } catch (e) { console.error('backup falhou:', e.message); }
}
function montarTudo() {
  return {
    v: 2,
    dobradas: db.prepare('SELECT id,nome,ini,cor FROM dobradas').all(),
    pessoas: db.prepare('SELECT * FROM pessoas').all().map(pessoaOut)
  };
}
async function avisarN8n(pessoa, pai) {
  if (!N8N_WEBHOOK_URL) return;
  try {
    await fetch(N8N_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evento: 'novo_cadastro',
        pessoa: { id: pessoa.id, nome: pessoa.nome, zap: pessoa.zap, grau: pessoa.grau,
                  munId: pessoa.munId, municipio: MUN_NOME[pessoa.munId] || '' },
        cadastradoPor: pai ? { id: pai.id, nome: pai.nome, grau: pai.grau } : null
      })
    });
  } catch (e) { console.error('webhook n8n falhou:', e.message); }
}

// ---------- auth admin ----------
const sign = exp => exp + '.' + crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
function tokenValido(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const ok = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok)); } catch { return false; }
}
const auth = (req, res, next) => {
  if (!tokenValido((req.headers.authorization || '').replace('Bearer ', '')))
    return res.status(401).json({ erro: 'não autorizado' });
  next();
};

const tent = {};
setInterval(() => Object.keys(tent).forEach(k => delete tent[k]), 15 * 60 * 1000);
const ipDe = req => req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const ip = ipDe(req);
  tent[ip] = (tent[ip] || 0) + 1;
  if (tent[ip] > 15) return res.status(429).json({ erro: 'muitas tentativas' });
  const s = String((req.body || {}).senha || '');
  const ok = s.length === SENHA.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(SENHA));
  if (!ok) return res.status(401).json({ erro: 'senha incorreta' });
  delete tent[ip];
  res.json({ token: sign(Date.now() + 30 * 24 * 3600 * 1000) });
});

app.get('/api/data', auth, (req, res) => res.json(montarTudo()));

// ---------- pessoas (admin) ----------
app.post('/api/pessoas', auth, (req, res) => {
  const x = req.body || {};
  if (!x.nome || !x.grau || !x.munId) return res.status(400).json({ erro: 'dados incompletos' });
  const p = inserirPessoa(x);
  backup();
  res.json(p);
});
app.put('/api/pessoas/:id', auth, (req, res) => {
  const atual = db.prepare('SELECT * FROM pessoas WHERE id=?').get(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'não encontrado' });
  const x = req.body || {};
  const grau = x.grau || atual.grau;
  let num = atual.num;
  if (grau === 'Coordenador' && !num) num = proxNum();
  if (grau !== 'Coordenador') num = null;
  let codigo = atual.codigo;
  if ((grau === 'Coordenador' || grau === 'Cabo Eleitoral') && !codigo) codigo = novoCodigo();
  db.prepare(`UPDATE pessoas SET nome=?, grau=?, num=?, votos=?, zap=?, endereco=?, email=?,
              dob_id=?, obs=?, codigo=? WHERE id=?`)
    .run(x.nome ?? atual.nome, grau, num, +x.votos || 0, x.zap ?? atual.zap,
         x.endereco ?? atual.endereco, x.email ?? atual.email,
         x.dobId !== undefined ? x.dobId : atual.dob_id, x.obs ?? atual.obs, codigo, atual.id);
  db.prepare('DELETE FROM pessoa_muns WHERE pessoa_id=?').run(atual.id);
  const setM = db.prepare('INSERT OR IGNORE INTO pessoa_muns(pessoa_id,mun_id) VALUES (?,?)');
  for (const m of (grau === 'Coordenador' ? (x.muns || []) : [])) setM.run(atual.id, String(m));
  backup();
  res.json(pessoaOut(db.prepare('SELECT * FROM pessoas WHERE id=?').get(atual.id)));
});
app.delete('/api/pessoas/:id', auth, (req, res) => {
  db.prepare('UPDATE pessoas SET pai_id=NULL WHERE pai_id=?').run(req.params.id); // filhos não somem
  db.prepare('DELETE FROM pessoa_muns WHERE pessoa_id=?').run(req.params.id);
  db.prepare('DELETE FROM pessoas WHERE id=?').run(req.params.id);
  backup();
  res.json({ ok: true });
});

// ---------- dobradas (admin) ----------
app.post('/api/dobradas', auth, (req, res) => {
  const x = req.body || {};
  if (!x.nome || !x.ini || !x.cor) return res.status(400).json({ erro: 'dados incompletos' });
  const id = rid('d');
  db.prepare('INSERT INTO dobradas(id,nome,ini,cor) VALUES (?,?,?,?)').run(id, x.nome, x.ini, x.cor);
  backup();
  res.json({ id, nome: x.nome, ini: x.ini, cor: x.cor });
});
app.put('/api/dobradas/:id', auth, (req, res) => {
  const d = db.prepare('SELECT * FROM dobradas WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ erro: 'não encontrado' });
  const x = req.body || {};
  db.prepare('UPDATE dobradas SET nome=?, ini=? WHERE id=?').run(x.nome ?? d.nome, x.ini ?? d.ini, d.id);
  backup();
  res.json({ ok: true });
});
app.delete('/api/dobradas/:id', auth, (req, res) => {
  db.prepare('UPDATE pessoas SET dob_id=NULL WHERE dob_id=?').run(req.params.id);
  db.prepare('DELETE FROM dobradas WHERE id=?').run(req.params.id);
  backup();
  res.json({ ok: true });
});

// ---------- importar CSV (substitui tudo) ----------
app.post('/api/import', auth, (req, res) => {
  const dados = req.body;
  if (!dados || !Array.isArray(dados.pessoas)) return res.status(400).json({ erro: 'formato inválido' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM pessoa_muns').run();
    db.prepare('DELETE FROM pessoas').run();
    db.prepare('DELETE FROM dobradas').run();
    const iD = db.prepare('INSERT INTO dobradas(id,nome,ini,cor) VALUES (?,?,?,?)');
    for (const d of dados.dobradas || []) iD.run(String(d.id), d.nome, d.ini, d.cor);
    for (const p of dados.pessoas) inserirPessoa(p);
  });
  tx();
  ultimoBkp = 0; backup();
  res.json({ ok: true, pessoas: db.prepare('SELECT COUNT(*) c FROM pessoas').get().c });
});

// ---------- cadastro externo por link ----------
app.get('/c/:codigo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cadastro.html')));

app.get('/api/convite/:codigo', (req, res) => {
  const p = db.prepare("SELECT nome, grau FROM pessoas WHERE codigo=? AND grau IN ('Coordenador','Cabo Eleitoral')")
    .get(req.params.codigo);
  if (!p) return res.status(404).json({ erro: 'link inválido' });
  res.json({ nome: p.nome, grau: p.grau });
});

const tentCad = {};
setInterval(() => Object.keys(tentCad).forEach(k => delete tentCad[k]), 60 * 60 * 1000);
app.post('/api/cadastro', async (req, res) => {
  const ip = ipDe(req);
  tentCad[ip] = (tentCad[ip] || 0) + 1;
  if (tentCad[ip] > 40) return res.status(429).json({ erro: 'muitas tentativas' });
  const { codigo, nome, zap, munId, grau } = req.body || {};
  const pai = db.prepare("SELECT * FROM pessoas WHERE codigo=? AND grau IN ('Coordenador','Cabo Eleitoral')").get(codigo || '');
  if (!pai) return res.status(404).json({ erro: 'link inválido' });
  if (!nome || !String(nome).trim() || !zap || !MUN_NOME[String(munId)])
    return res.status(400).json({ erro: 'preencha nome, WhatsApp e município' });
  // coordenador pode cadastrar cabo ou apoiador; cabo só cadastra apoiador
  let g = grau === 'Cabo Eleitoral' ? 'Cabo Eleitoral' : 'Apoiador';
  if (pai.grau === 'Cabo Eleitoral') g = 'Apoiador';
  const p = inserirPessoa({
    nome: String(nome).trim().slice(0, 120), grau: g, zap: String(zap).trim().slice(0, 30),
    munId: String(munId), paiId: pai.id, dobId: pai.dob_id || null
  });
  backup();
  avisarN8n(p, pai); // dispara o fluxo de WhatsApp no n8n (agradecimento + coleta de dados)
  res.json({ ok: true });
});

// ---------- cadastro via WhatsApp (n8n conversa, servidor grava) ----------
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
// normaliza telefones BR: ignora +55, pontuação e o 9º dígito
function variantesZap(z) {
  let d = String(z || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  const v = new Set([d]);
  if (d.length === 11) v.add(d.slice(0, 2) + d.slice(3));      // remove o 9
  if (d.length === 10) v.add(d.slice(0, 2) + '9' + d.slice(2)); // adiciona o 9
  return v;
}
function acharPorZap(z) {
  const alvo = variantesZap(z);
  if (![...alvo][0]) return null;
  return db.prepare("SELECT * FROM pessoas WHERE grau IN ('Coordenador','Cabo Eleitoral')").all()
    .find(p => { const v = variantesZap(p.zap); return [...alvo].some(x => v.has(x)); }) || null;
}
const n8nAuth = (req, res, next) => {
  if (!N8N_KEY || req.headers['x-api-key'] !== N8N_KEY)
    return res.status(401).json({ erro: 'não autorizado' });
  next();
};

// o agente pergunta "quem está falando?": identifica coordenador/cabo pelo número
app.get('/api/whats/indicador', n8nAuth, (req, res) => {
  const p = acharPorZap(req.query.zap);
  if (!p) return res.status(404).json({ erro: 'numero_nao_cadastrado' });
  res.json({ id: p.id, nome: p.nome, grau: p.grau, num: p.num || null,
             municipio: MUN_NOME[p.mun_id] || '', codigo: p.codigo });
});

// o agente coletou os dados (por áudio ou texto) e manda gravar
app.post('/api/whats/cadastro', n8nAuth, (req, res) => {
  const { zapIndicador, nome, zap, municipio, grau } = req.body || {};
  const pai = acharPorZap(zapIndicador);
  if (!pai) return res.status(404).json({ erro: 'indicador_nao_encontrado',
    msg: 'Este número de WhatsApp não pertence a um coordenador ou cabo eleitoral cadastrado.' });
  if (!nome || !String(nome).trim() || !zap)
    return res.status(400).json({ erro: 'dados_incompletos', msg: 'Informe nome e WhatsApp do apoiador.' });
  const alvoMun = norm(String(municipio || ''));
  const mun = MUNS.find(m => norm(m.n) === alvoMun) || MUNS.find(m => alvoMun && norm(m.n).includes(alvoMun));
  if (!mun) return res.status(400).json({ erro: 'municipio_nao_reconhecido',
    msg: 'Não reconheci o município "' + (municipio || '') + '". Peça para repetir o nome da cidade.' });
  const alvoZap = variantesZap(zap);
  const duplicado = db.prepare("SELECT zap FROM pessoas WHERE zap IS NOT NULL AND zap != ''").all()
    .some(r => { const v = variantesZap(r.zap); return [...alvoZap].some(x => x && v.has(x)); });
  if (duplicado) return res.status(409).json({ erro: 'ja_cadastrado', msg: 'Este WhatsApp já está cadastrado.' });
  let g = grau === 'Cabo Eleitoral' ? 'Cabo Eleitoral' : 'Apoiador';
  if (pai.grau === 'Cabo Eleitoral') g = 'Apoiador';
  const p = inserirPessoa({
    nome: String(nome).trim().slice(0, 120), grau: g, zap: String(zap).trim().slice(0, 30),
    munId: mun.id, paiId: pai.id, dobId: pai.dob_id || null
  });
  backup();
  avisarN8n(p, { id: pai.id, nome: pai.nome, grau: pai.grau });
  res.json({ ok: true, pessoa: { id: p.id, nome: p.nome, grau: p.grau, municipio: mun.n },
             cadastradoPor: pai.nome });
});
// ---------- atualização pelo n8n (WhatsApp devolve os dados) ----------
app.patch('/api/pessoas/:id', (req, res) => {
  const admin = tokenValido((req.headers.authorization || '').replace('Bearer ', ''));
  const n8n = N8N_KEY && req.headers['x-api-key'] === N8N_KEY;
  if (!admin && !n8n) return res.status(401).json({ erro: 'não autorizado' });
  const p = db.prepare('SELECT * FROM pessoas WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'não encontrado' });
  const x = req.body || {};
  db.prepare('UPDATE pessoas SET nome=?, zap=?, endereco=?, email=?, votos=?, obs=? WHERE id=?')
    .run(x.nome ?? p.nome, x.zap ?? p.zap, x.endereco ?? p.endereco, x.email ?? p.email,
         x.votos !== undefined ? +x.votos || 0 : p.votos, x.obs ?? p.obs, p.id);
  backup();
  res.json(pessoaOut(db.prepare('SELECT * FROM pessoas WHERE id=?').get(p.id)));
});

app.listen(PORT, () => console.log('Mapa de Apoiadores v2 na porta ' + PORT));
