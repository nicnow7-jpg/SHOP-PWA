const express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), multer = require('multer'), XLSX = require('xlsx'),
  cookie = require('cookie-parser'), path = require('path'), fs = require('fs');

const PORT = process.env.PORT || 3000, SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA + '/uploads', { recursive: true });
const db = new Database(DATA + '/shop.db'); db.pragma('journal_mode = WAL');
db.exec(`
create table if not exists users(id integer primary key, name text, phone text unique, hash text, role text default 'buyer');
create table if not exists items(id integer primary key, sku text unique, name text, category text, description text,
  price real, stock integer, image text default '', active integer default 1);
create table if not exists orders(id integer primary key, code text unique, user_id integer, total real,
  status text default 'awaiting_payment', momo_ref text, created text default current_timestamp);
create table if not exists order_items(order_id integer, item_id integer, name text, price real, qty integer);
create table if not exists settings(k text primary key, v text);`);

const E = process.env;
for (const [k, v] of Object.entries({ shop_name: E.SHOP_NAME || 'My Shop', momo_number: E.MOMO_NUMBER || '',
  momo_name: E.MOMO_NAME || '', pickup_address: E.PICKUP_ADDRESS || '' }))
  db.prepare('insert or ignore into settings values(?,?)').run(k, v);
if (E.SELLER_PHONE && E.SELLER_PASSWORD && !db.prepare("select 1 from users where role='seller'").get())
  db.prepare("insert into users(name,phone,hash,role) values('Seller',?,?, 'seller')")
    .run(E.SELLER_PHONE, bcrypt.hashSync(E.SELLER_PASSWORD, 10));

const app = express(); app.use(express.json()); app.use(cookie());
app.use('/uploads', express.static(DATA + '/uploads'));
app.use(express.static(path.join(__dirname, 'public')));

const fail = (s, m) => { const e = new Error(m); e.status = s; throw e; };
const wrap = f => (req, res) => { try { f(req, res); } catch (e) {
  if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); } };
const auth = role => (req, res, next) => {
  try { const u = jwt.verify(req.cookies.token, SECRET); if (role && u.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = u; next(); } catch { res.status(401).json({ error: 'Please log in' }); } };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const settings = () => Object.fromEntries(db.prepare('select k,v from settings').all().map(r => [r.k, r.v]));
const phone = p => { p = String(p || '').replace(/\D/g, ''); if (p.startsWith('233')) p = '0' + p.slice(3);
  if (!/^0\d{9}$/.test(p)) fail(400, 'Enter a valid 10-digit phone number'); return p; };
const withImg = i => ({ ...i, img: i.image || `/placeholder.svg?c=${encodeURIComponent(i.category || '')}&n=${encodeURIComponent(i.name)}` });
const sign = (res, u) => res.cookie('token', jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '30d' }),
  { httpOnly: true, sameSite: 'lax', secure: E.NODE_ENV === 'production', maxAge: 30 * 864e5 });

// ---------- auth ----------
app.post('/api/register', wrap((req, res) => {
  const { name, password } = req.body, p = phone(req.body.phone);
  if (!name || !password || password.length < 6) fail(400, 'Enter your name and a password of 6+ characters');
  if (db.prepare('select 1 from users where phone=?').get(p)) fail(400, 'This phone number is already registered');
  const r = db.prepare('insert into users(name,phone,hash) values(?,?,?)').run(name.trim(), p, bcrypt.hashSync(password, 10));
  sign(res, { id: r.lastInsertRowid, role: 'buyer' }); res.json({ user: { name: name.trim(), phone: p, role: 'buyer' } });
}));
app.post('/api/login', wrap((req, res) => {
  const u = db.prepare('select * from users where phone=?').get(phone(req.body.phone));
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) fail(401, 'Wrong phone number or password');
  sign(res, u); res.json({ user: { name: u.name, phone: u.phone, role: u.role } });
}));
app.post('/api/logout', (req, res) => res.clearCookie('token').json({ ok: 1 }));
app.get('/api/me', (req, res) => { try { const t = jwt.verify(req.cookies.token, SECRET);
  const u = db.prepare('select name,phone,role from users where id=?').get(t.id); res.json({ user: u || null }); }
  catch { res.json({ user: null }); } });

// ---------- shop ----------
app.get('/api/shop', (req, res) => res.json(settings()));
app.get('/api/items', (req, res) => res.json(db.prepare('select * from items where active=1 order by category,name').all().map(withImg)));
app.get('/placeholder.svg', (req, res) => {
  const c = String(req.query.c || ''); let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const ini = String(req.query.n || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  res.type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="hsl(${h},35%,88%)"/><text x="100" y="118" font-family="sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="hsl(${h},40%,30%)">${ini}</text></svg>`);
});

// ---------- orders ----------
app.post('/api/orders', auth('buyer'), wrap((req, res) => {
  const lines = (req.body.items || []).filter(l => l.qty > 0); if (!lines.length) fail(400, 'Your cart is empty');
  res.json(db.transaction(() => {
    let total = 0; const rows = [];
    for (const l of lines) {
      const it = db.prepare('select * from items where id=? and active=1').get(l.id), q = parseInt(l.qty);
      if (!it || !(q > 0)) fail(400, 'An item in your cart is no longer available');
      if (it.stock < q) fail(400, `Only ${it.stock} left of ${it.name}`);
      db.prepare('update items set stock=stock-? where id=?').run(q, it.id); rows.push([it, q]); total += it.price * q;
    }
    total = Math.round(total * 100) / 100;
    const code = 'ORD-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const o = db.prepare('insert into orders(code,user_id,total) values(?,?,?)').run(code, req.user.id, total);
    for (const [it, q] of rows) db.prepare('insert into order_items values(?,?,?,?,?)').run(o.lastInsertRowid, it.id, it.name, it.price, q);
    return { code, total };
  })());
}));
app.get('/api/orders', auth(), wrap((req, res) => {
  const seller = req.user.role === 'seller';
  const os = db.prepare(`select o.*, u.name buyer, u.phone from orders o join users u on u.id=o.user_id ${seller ? '' : 'where o.user_id=?'} order by o.id desc`)
    .all(...(seller ? [] : [req.user.id]));
  for (const o of os) o.items = db.prepare('select name,price,qty from order_items where order_id=?').all(o.id);
  res.json(os);
}));
app.post('/api/orders/:id/paid', auth('buyer'), wrap((req, res) => {
  const ref = String(req.body.momo_ref || '').trim().slice(0, 40); if (!ref) fail(400, 'Enter the MoMo transaction ID');
  const r = db.prepare("update orders set status='payment_sent', momo_ref=? where id=? and user_id=? and status='awaiting_payment'")
    .run(ref, req.params.id, req.user.id);
  if (!r.changes) fail(400, 'This order can no longer be updated'); res.json({ ok: 1 });
}));
app.post('/api/orders/:id/status', auth(), wrap((req, res) => {
  const o = db.prepare('select * from orders where id=?').get(req.params.id), s = req.body.status;
  if (!o) fail(404, 'Order not found');
  const own = o.user_id === req.user.id && s === 'cancelled' && o.status === 'awaiting_payment';
  if (req.user.role !== 'seller' && !own) fail(403, 'Not allowed');
  if (!['paid', 'ready', 'picked_up', 'cancelled'].includes(s) || ['cancelled', 'picked_up'].includes(o.status)) fail(400, 'Invalid status change');
  db.transaction(() => {
    if (s === 'cancelled') for (const l of db.prepare('select * from order_items where order_id=?').all(o.id))
      db.prepare('update items set stock=stock+? where id=?').run(l.qty, l.item_id);
    db.prepare('update orders set status=? where id=?').run(s, o.id);
  })();
  res.json({ ok: 1 });
}));

// ---------- seller ----------
const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5e6 } });
const disk = multer({ storage: multer.diskStorage({ destination: DATA + '/uploads',
  filename: (r, f, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 5e6 }, fileFilter: (r, f, cb) => cb(null, /\.(jpe?g|png|webp|gif)$/i.test(f.originalname)) });

app.get('/api/seller/items', auth('seller'), wrap((req, res) => res.json(db.prepare('select * from items order by category,name').all().map(withImg))));
app.patch('/api/seller/items/:id', auth('seller'), wrap((req, res) => {
  const { price, stock, active } = req.body;
  db.prepare('update items set price=coalesce(?,price), stock=coalesce(?,stock), active=coalesce(?,active) where id=?')
    .run(price ?? null, stock ?? null, active ?? null, req.params.id); res.json({ ok: 1 });
}));
app.get('/api/seller/template', auth('seller'), (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([['sku', 'name', 'category', 'description', 'price', 'stock', 'image_url'],
    ['RICE-5KG', 'Jasmine Rice 5kg', 'Groceries', 'Long grain, imported', 85, 20, ''],
    ['TSHIRT-M', 'Plain T-shirt (M)', 'Clothing', 'Cotton, black', 45, 12, '']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Items');
  res.attachment('items-template.xlsx').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
app.post('/api/seller/upload', auth('seller'), mem.single('file'), wrap((req, res) => {
  if (!req.file) fail(400, 'Choose an .xlsx or .csv file');
  const wb = XLSX.read(req.file.buffer), rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const up = db.prepare(`insert into items(sku,name,category,description,price,stock,image) values(@sku,@name,@category,@description,@price,@stock,@image)
    on conflict(sku) do update set name=@name,category=@category,description=@description,price=@price,stock=@stock,
    image=coalesce(nullif(@image,''),image),active=1`);
  let added = 0, updated = 0; const skipped = [];
  db.transaction(() => rows.forEach((raw, n) => {
    const r = {}; for (const k in raw) r[k.trim().toLowerCase().replace(/\s+/g, '_')] = raw[k];
    const price = parseFloat(r.price), name = String(r.name || '').trim();
    if (!name || isNaN(price)) return skipped.push(`Row ${n + 2}: needs a name and a price`);
    const sku = String(r.sku || '').trim() || slug(name), existed = db.prepare('select 1 from items where sku=?').get(sku);
    up.run({ sku, name, category: String(r.category || 'General').trim(), description: String(r.description || ''), price,
      stock: parseInt(r.stock) || 0, image: String(r.image_url || r.image || '').trim() });
    existed ? updated++ : added++;
  }))();
  res.json({ added, updated, skipped });
}));
app.post('/api/seller/images', auth('seller'), disk.array('images', 100), wrap((req, res) => {
  const all = db.prepare('select id,sku,name from items').all(), set = db.prepare('update items set image=? where id=?');
  let matched = 0; const unmatched = [];
  for (const f of req.files || []) {
    const base = slug(path.parse(f.originalname).name);
    const it = req.query.item ? { id: +req.query.item } : all.find(i => slug(i.sku) === base || slug(i.name) === base);
    if (it) { set.run('/uploads/' + f.filename, it.id); matched++; if (req.query.item) break; } else unmatched.push(f.originalname);
  }
  res.json({ matched, unmatched });
}));
app.put('/api/seller/settings', auth('seller'), wrap((req, res) => {
  for (const k of ['shop_name', 'momo_number', 'momo_name', 'pickup_address'])
    if (k in req.body) db.prepare('insert or replace into settings values(?,?)').run(k, String(req.body[k]).slice(0, 200));
  res.json(settings());
}));

app.listen(PORT, () => console.log('Shop running on http://localhost:' + PORT));
