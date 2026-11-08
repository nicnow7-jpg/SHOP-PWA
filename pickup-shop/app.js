// Express app shared by Vercel (api/index.js) and local development (server.js).
const express = require('express'), { Pool } = require('pg'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'),
  multer = require('multer'), XLSX = require('xlsx'), cookie = require('cookie-parser'), path = require('path');

const E = process.env, DB_URL = E.DATABASE_URL || E.POSTGRES_URL || E.POSTGRES_URL_NON_POOLING, SECRET = E.JWT_SECRET;
const pool = DB_URL ? new Pool({ connectionString: DB_URL, max: 1, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false } }) : null;
if (pool) pool.on('error', e => console.error('pg pool error:', e.message));
const q = (text, params) => pool.query(text, params).then(r => r.rows);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn((t, p) => c.query(t, p).then(r => r.rows)); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

let ready;
const init = () => ready || (ready = (async () => {
  await q(`
  create table if not exists users(id serial primary key, name text, phone text unique, hash text, role text default 'buyer');
  create table if not exists items(id serial primary key, sku text unique, name text, category text, description text default '',
    price double precision, stock integer default 0, image text default '', active integer default 1);
  create table if not exists orders(id serial primary key, code text unique, user_id integer references users(id), total double precision,
    status text default 'awaiting_payment', momo_ref text, created timestamptz default now());
  create table if not exists order_items(order_id integer references orders(id) on delete cascade, item_id integer, name text, price double precision, qty integer);
  create table if not exists settings(k text primary key, v text);
  create table if not exists images(id serial primary key, mime text, data bytea);`);
  for (const [k, v] of Object.entries({ shop_name: E.SHOP_NAME || 'My Shop', momo_number: E.MOMO_NUMBER || '', momo_name: E.MOMO_NAME || '', pickup_address: E.PICKUP_ADDRESS || '' }))
    await q('insert into settings values($1,$2) on conflict(k) do nothing', [k, v]);
  if (E.SELLER_PHONE && E.SELLER_PASSWORD && !(await q("select 1 from users where role='seller'")).length)
    await q("insert into users(name,phone,hash,role) values('Seller',$1,$2,'seller') on conflict(phone) do update set role='seller'", [E.SELLER_PHONE.replace(/\D/g, ''), bcrypt.hashSync(E.SELLER_PASSWORD, 10)]);
})().catch(e => { ready = null; throw e; }));

const app = express(); app.use(express.json()); app.use(cookie());
const fail = (s, m) => { const e = new Error(m); e.status = s; throw e; };
const wrap = f => async (req, res) => { try { await f(req, res); } catch (e) {
  if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); } };
const auth = role => (req, res, next) => {
  try { const u = jwt.verify(req.cookies.token, SECRET); if (role && u.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = u; next(); } catch { res.status(401).json({ error: 'Please log in' }); } };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const settings = async () => Object.fromEntries((await q('select k,v from settings')).map(r => [r.k, r.v]));
const phone = p => { p = String(p || '').replace(/\D/g, ''); if (p.startsWith('233')) p = '0' + p.slice(3);
  if (!/^0\d{9}$/.test(p)) fail(400, 'Enter a valid 10-digit phone number'); return p; };
const withImg = i => ({ ...i, img: i.image || `/api/placeholder.svg?c=${encodeURIComponent(i.category || '')}&n=${encodeURIComponent(i.name)}` });
const sign = (res, u) => res.cookie('token', jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '30d' }),
  { httpOnly: true, sameSite: 'lax', secure: E.NODE_ENV === 'production' || !!E.VERCEL, maxAge: 30 * 864e5 });

// PWA manifest: the installed app is named after the shop.
app.get('/api/manifest', async (req, res) => {
  let name = 'Pickup Shop';
  try { if (pool && SECRET) { await init(); name = (await settings()).shop_name || name; } } catch (e) { console.error('manifest:', e.message); }
  res.set('Cache-Control', 'public, max-age=300').type('application/manifest+json').send(JSON.stringify({
    id: '/', name, short_name: name.slice(0, 12), description: 'Order online, pay by Mobile Money, pick up in person.',
    start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#f4f6f2', theme_color: '#0f5c3a',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
    shortcuts: [{ name: 'Seller dashboard', url: '/seller.html' }] }));
});

// Make setup problems obvious instead of a bare 500.
app.use('/api', async (req, res, next) => {
  if (!pool) return res.status(500).json({ error: 'Server setup incomplete: DATABASE_URL is not set.' });
  if (!SECRET) return res.status(500).json({ error: 'Server setup incomplete: JWT_SECRET is not set.' });
  try { await init(); next(); } catch (e) { console.error('DB init failed:', e); res.status(500).json({ error: 'Cannot reach the database. Check DATABASE_URL.' }); }
});
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- auth ----------
app.post('/api/register', wrap(async (req, res) => {
  const { name, password } = req.body, p = phone(req.body.phone);
  if (!name || !password || password.length < 6) fail(400, 'Enter your name and a password of 6+ characters');
  if ((await q('select 1 from users where phone=$1', [p])).length) fail(400, 'This phone number is already registered');
  const [u] = await q("insert into users(name,phone,hash) values($1,$2,$3) returning id", [name.trim(), p, bcrypt.hashSync(password, 10)]);
  sign(res, { id: u.id, role: 'buyer' }); res.json({ user: { name: name.trim(), phone: p, role: 'buyer' } });
}));
app.post('/api/login', wrap(async (req, res) => {
  const [u] = await q('select * from users where phone=$1', [phone(req.body.phone)]);
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) fail(401, 'Wrong phone number or password');
  sign(res, u); res.json({ user: { name: u.name, phone: u.phone, role: u.role } });
}));
app.post('/api/logout', (req, res) => res.clearCookie('token').json({ ok: 1 }));
app.get('/api/me', wrap(async (req, res) => {
  try { const t = jwt.verify(req.cookies.token, SECRET); res.json({ user: (await q('select name,phone,role from users where id=$1', [t.id]))[0] || null }); }
  catch { res.json({ user: null }); }
}));

// ---------- shop ----------
app.get('/api/shop', wrap(async (req, res) => res.json(await settings())));
app.get('/api/items', wrap(async (req, res) => res.json((await q('select * from items where active=1 order by category,name')).map(withImg))));
app.get('/api/img/:id', wrap(async (req, res) => {
  const [r] = await q('select mime,data from images where id=$1', [parseInt(req.params.id) || 0]); if (!r) fail(404, 'Not found');
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(r.mime).send(r.data);
}));
app.get('/api/placeholder.svg', (req, res) => {
  const c = String(req.query.c || ''); let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const ini = String(req.query.n || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  res.set('Cache-Control', 'public, max-age=86400').type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="hsl(${h},35%,88%)"/><text x="100" y="118" font-family="sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="hsl(${h},40%,30%)">${ini}</text></svg>`);
});

// ---------- orders ----------
app.post('/api/orders', auth('buyer'), wrap(async (req, res) => {
  const lines = (req.body.items || []).filter(l => l.qty > 0); if (!lines.length) fail(400, 'Your cart is empty');
  res.json(await tx(async t => {
    let total = 0; const rows = [];
    for (const l of lines) {
      const [it] = await t('select * from items where id=$1 and active=1 for update', [parseInt(l.id) || 0]), n = parseInt(l.qty);
      if (!it || !(n > 0)) fail(400, 'An item in your cart is no longer available');
      if (it.stock < n) fail(400, `Only ${it.stock} left of ${it.name}`);
      await t('update items set stock=stock-$1 where id=$2', [n, it.id]); rows.push([it, n]); total += it.price * n;
    }
    total = Math.round(total * 100) / 100;
    const code = 'ORD-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const [o] = await t('insert into orders(code,user_id,total) values($1,$2,$3) returning id', [code, req.user.id, total]);
    for (const [it, n] of rows) await t('insert into order_items values($1,$2,$3,$4,$5)', [o.id, it.id, it.name, it.price, n]);
    return { code, total };
  }));
}));
app.get('/api/orders', auth(), wrap(async (req, res) => {
  const seller = req.user.role === 'seller';
  const os = await q(`select o.*, u.name buyer, u.phone from orders o join users u on u.id=o.user_id ${seller ? '' : 'where o.user_id=$1'} order by o.id desc`, seller ? [] : [req.user.id]);
  const ls = os.length ? await q('select order_id,item_id,name,price,qty from order_items where order_id = any($1)', [os.map(o => o.id)]) : [];
  for (const o of os) o.items = ls.filter(l => l.order_id === o.id);
  res.json(os);
}));
app.post('/api/orders/:id/paid', auth('buyer'), wrap(async (req, res) => {
  const ref = String(req.body.momo_ref || '').trim().slice(0, 40); if (!ref) fail(400, 'Enter the MoMo transaction ID');
  const r = await q("update orders set status='payment_sent', momo_ref=$1 where id=$2 and user_id=$3 and status='awaiting_payment' returning id", [ref, parseInt(req.params.id) || 0, req.user.id]);
  if (!r.length) fail(400, 'This order can no longer be updated'); res.json({ ok: 1 });
}));
app.post('/api/orders/:id/status', auth(), wrap(async (req, res) => {
  const [o] = await q('select * from orders where id=$1', [parseInt(req.params.id) || 0]), s = req.body.status;
  if (!o) fail(404, 'Order not found');
  const own = o.user_id === req.user.id && s === 'cancelled' && o.status === 'awaiting_payment';
  if (req.user.role !== 'seller' && !own) fail(403, 'Not allowed');
  if (!['paid', 'ready', 'picked_up', 'cancelled'].includes(s) || ['cancelled', 'picked_up'].includes(o.status)) fail(400, 'Invalid status change');
  await tx(async t => {
    if (s === 'cancelled') for (const l of await t('select * from order_items where order_id=$1', [o.id])) await t('update items set stock=stock+$1 where id=$2', [l.qty, l.item_id]);
    await t('update orders set status=$1 where id=$2', [s, o.id]);
  });
  res.json({ ok: 1 });
}));

// ---------- seller ----------
const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4e6 } });
app.get('/api/seller/items', auth('seller'), wrap(async (req, res) => res.json((await q('select * from items order by category,name')).map(withImg))));
app.patch('/api/seller/items/:id', auth('seller'), wrap(async (req, res) => {
  const { price, stock, active } = req.body;
  await q('update items set price=coalesce($1,price), stock=coalesce($2,stock), active=coalesce($3,active) where id=$4', [price ?? null, stock ?? null, active ?? null, parseInt(req.params.id) || 0]);
  res.json({ ok: 1 });
}));
app.get('/api/seller/template', auth('seller'), (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([['sku', 'name', 'category', 'description', 'price', 'stock', 'image_url'],
    ['RICE-5KG', 'Jasmine Rice 5kg', 'Groceries', 'Long grain, imported', 85, 20, ''],
    ['TSHIRT-M', 'Plain T-shirt (M)', 'Clothing', 'Cotton, black', 45, 12, '']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Items');
  res.attachment('items-template.xlsx').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
app.post('/api/seller/upload', auth('seller'), mem.single('file'), wrap(async (req, res) => {
  if (!req.file) fail(400, 'Choose an .xlsx or .csv file');
  const wb = XLSX.read(req.file.buffer), rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  let added = 0, updated = 0; const skipped = [];
  await tx(async t => { for (const [n, raw] of rows.entries()) {
    const r = {}; for (const k in raw) r[k.trim().toLowerCase().replace(/\s+/g, '_')] = raw[k];
    const price = parseFloat(r.price), name = String(r.name || '').trim();
    if (!name || isNaN(price)) { skipped.push(`Row ${n + 2}: needs a name and a price`); continue; }
    const [x] = await t(`insert into items(sku,name,category,description,price,stock,image) values($1,$2,$3,$4,$5,$6,$7)
      on conflict(sku) do update set name=$2,category=$3,description=$4,price=$5,stock=$6,image=coalesce(nullif($7,''),items.image),active=1 returning (xmax=0) as inserted`,
      [String(r.sku || '').trim() || slug(name), name, String(r.category || 'General').trim(), String(r.description || ''), price, parseInt(r.stock) || 0, String(r.image_url || r.image || '').trim()]);
    x.inserted ? added++ : updated++;
  } });
  res.json({ added, updated, skipped });
}));
app.post('/api/seller/images', auth('seller'), mem.array('images', 10), wrap(async (req, res) => {
  const all = await q('select id,sku,name,image from items'); let matched = 0; const unmatched = [];
  for (const f of req.files || []) {
    const base = slug(path.parse(f.originalname).name);
    const it = req.query.item ? all.find(i => i.id == req.query.item) : all.find(i => slug(i.sku) === base || slug(i.name) === base);
    if (!it || !/^image\//.test(f.mimetype)) { unmatched.push(f.originalname); continue; }
    const [{ id }] = await q('insert into images(mime,data) values($1,$2) returning id', [f.mimetype, f.buffer]);
    await q('update items set image=$1 where id=$2', ['/api/img/' + id, it.id]);
    const old = /^\/api\/img\/(\d+)$/.exec(it.image || ''); if (old) await q('delete from images where id=$1', [old[1]]);
    matched++; if (req.query.item) break;
  }
  res.json({ matched, unmatched });
}));
app.put('/api/seller/settings', auth('seller'), wrap(async (req, res) => {
  for (const k of ['shop_name', 'momo_number', 'momo_name', 'pickup_address'])
    if (k in req.body) {
      const v = String(req.body[k]).trim().slice(0, 200); if (k === 'shop_name' && !v) fail(400, 'Shop name cannot be empty');
      await q('insert into settings values($1,$2) on conflict(k) do update set v=$2', [k, v]);
    }
  res.json(await settings());
}));

module.exports = app;
