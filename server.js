import http from 'node:http';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3000;
const TZ = 'America/Argentina/Mendoza';
const PAY_MINUTES = 30; // reserva web sin verificar → se libera
const MAX_PADDLES = 4;
const PUBLIC = join(import.meta.dirname, 'public');
let DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // Sin Supabase: base local de prueba en .local-db (los datos no se comparten con nadie).
  const { startLocalDb } = await import('./local-db.js');
  DATABASE_URL = await startLocalDb(join(import.meta.dirname, '.local-db'));
  console.log('⚠ Sin DATABASE_URL: usando base LOCAL de prueba (.local-db). Configurá .env para usar Supabase.');
}
const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(DATABASE_URL);
// La clave por defecto es pública (está en el repo): solo vale para la base local de prueba.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isLocal ? 'lujanpadel' : '');
if (!ADMIN_PASSWORD || (!isLocal && ADMIN_PASSWORD === 'cambiame')) throw new Error('Configurá ADMIN_PASSWORD con una clave propia');
// Esquema propio: no choca con otra app en el mismo proyecto y Supabase no lo expone por su API pública.
const SCHEMA = process.env.DB_SCHEMA || 'lujan_padel';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error('DB_SCHEMA inválido');
const sql = postgres(DATABASE_URL, { ssl: isLocal ? false : 'require', prepare: false, onnotice: () => {} });
const t = Object.fromEntries(['courts', 'settings', 'fixed', 'bookings'].map(n => [n, sql(`${SCHEMA}.${n}`)]));

await sql.unsafe(`
  CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
  CREATE TABLE IF NOT EXISTS ${SCHEMA}.courts (
    id serial PRIMARY KEY, name text NOT NULL, kind text NOT NULL,
    price integer NOT NULL, active boolean NOT NULL DEFAULT true);
  CREATE TABLE IF NOT EXISTS ${SCHEMA}.settings (key text PRIMARY KEY, value text NOT NULL);
  CREATE TABLE IF NOT EXISTS ${SCHEMA}.fixed (
    id serial PRIMARY KEY, court_id integer NOT NULL REFERENCES ${SCHEMA}.courts(id),
    weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6), start text NOT NULL,
    name text NOT NULL, phone text NOT NULL, since text NOT NULL, active boolean NOT NULL DEFAULT true);
  CREATE UNIQUE INDEX IF NOT EXISTS one_fixed_per_slot ON ${SCHEMA}.fixed(court_id, weekday, start) WHERE active;
  CREATE TABLE IF NOT EXISTS ${SCHEMA}.bookings (
    id serial PRIMARY KEY, court_id integer NOT NULL REFERENCES ${SCHEMA}.courts(id),
    date text NOT NULL CHECK (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'), start text NOT NULL,
    name text NOT NULL, phone text NOT NULL, price integer NOT NULL,
    paddles integer NOT NULL DEFAULT 0, fixed_id integer REFERENCES ${SCHEMA}.fixed(id),
    status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','pagado','cancelado','vencido')),
    expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot
    ON ${SCHEMA}.bookings(court_id, date, start) WHERE status IN ('pendiente','pagado');
  CREATE INDEX IF NOT EXISTS bookings_by_date ON ${SCHEMA}.bookings(date);
  -- RLS sin políticas: nadie fuera del dueño de las tablas (este servidor) puede leerlas aunque se exponga el esquema.
  ALTER TABLE ${SCHEMA}.courts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${SCHEMA}.settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${SCHEMA}.fixed ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${SCHEMA}.bookings ENABLE ROW LEVEL SECURITY;
  INSERT INTO ${SCHEMA}.settings VALUES ('open','08:30'), ('close','01:00'), ('slot','90'), ('paddle_price','3000')
    ON CONFLICT DO NOTHING;
`);
if (!(await sql`SELECT 1 FROM ${t.courts} LIMIT 1`).length) {
  await sql`INSERT INTO ${t.courts} ${sql([1, 2, 3, 4, 5].map(i => ({ name: `Cancha ${i}`, kind: 'Blindex', price: 24000 })))}`;
}

const settings = async () => Object.fromEntries((await sql`SELECT key, value FROM ${t.settings}`).map(r => [r.key, r.value]));
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowAR = () => { const s = new Date().toLocaleString('sv-SE', { timeZone: TZ }); return { date: s.slice(0, 10), min: toMin(s.slice(11, 16)) }; };
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const weekday = d => new Date(d + 'T12:00:00Z').getUTCDay();

// Turnos del día; los que pasan de medianoche quedan con min >= 1440 y siguen perteneciendo a esa fecha.
async function slots(date) {
  const { open, close, slot } = await settings();
  const o = toMin(open), s = Number(slot);
  let c = toMin(close); if (c <= o) c += 1440;
  const now = nowAR(), out = [];
  for (let t = o; t + s <= c; t += s) out.push({ start: fmt(t), past: date < now.date || (date === now.date && t <= now.min) });
  return out;
}

// Antes de leer o reservar un día: vence las reservas web impagas y crea las del día a partir de los turnos fijos.
// Un fijo cancelado para una fecha no se recrea (NOT EXISTS mira cualquier estado).
async function prepare(date) {
  await sql`UPDATE ${t.bookings} SET status = 'vencido' WHERE status = 'pendiente' AND expires_at < now()`;
  if (date < nowAR().date) return;
  await sql`
    INSERT INTO ${t.bookings} (court_id, date, start, name, phone, price, fixed_id)
    SELECT f.court_id, ${date}, f.start, f.name, f.phone, c.price, f.id
    FROM ${t.fixed} f JOIN ${t.courts} c ON c.id = f.court_id
    WHERE f.active AND f.weekday = ${weekday(date)} AND f.since <= ${date}
      AND NOT EXISTS (SELECT 1 FROM ${t.bookings} b WHERE b.fixed_id = f.id AND b.date = ${date})
    ON CONFLICT DO NOTHING`;
}

// --- auth ---
// Cookie firmada (vencimiento.firma) en vez de sesiones en memoria: en Vercel cada pedido puede caer en otra instancia.
// Cambiar ADMIN_PASSWORD invalida todas las sesiones.
const sha = s => createHash('sha256').update(String(s)).digest();
const SECRET = sha('lujan-admin:' + ADMIN_PASSWORD);
const sign = exp => createHmac('sha256', SECRET).update(String(exp)).digest();
const SESSION_HOURS = 12;
const newSession = () => { const exp = Date.now() + SESSION_HOURS * 3600e3; return `${exp}.${sign(exp).toString('hex')}`; };
const isAdmin = req => {
  const m = /(?:^|;\s*)admin=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!m && Number(m[1]) > Date.now() && timingSafeEqual(Buffer.from(m[2], 'hex'), sign(m[1]));
};
const cookie = (req, value, maxAge) =>
  `admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

// --- http helpers ---
const send = (res, code, data, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
};
// Vercel ya parsea el JSON en req.body; en local se lee el stream.
const body = req => 'body' in req ? Promise.resolve(req.body ?? {}) : new Promise((ok, fail) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) { fail(new Error('too big')); req.destroy(); } });
  req.on('end', () => { try { ok(raw ? JSON.parse(raw) : {}); } catch { fail(new Error('bad json')); } });
});
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
// Rutas literales con new URL(...) para que Vercel empaquete los HTML dentro de la función
// (con el preset Node, / y /admin pueden llegar acá en vez de al estático).
const INDEX = new URL('./public/index.html', import.meta.url), ADMIN = new URL('./public/admin.html', import.meta.url);
const PAGES = { '/': INDEX, '/index.html': INDEX, '/admin': ADMIN, '/admin.html': ADMIN };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function person(b) {
  const name = String(b.name || '').trim(), phone = String(b.phone || '').replace(/[^\d+]/g, '');
  if (name.length < 2 || name.length > 60) return { error: 'Ingresá el nombre' };
  if (phone.length < 8 || phone.length > 20) return { error: 'Ingresá un teléfono válido' };
  return { name, phone };
}

async function createBooking(b, admin = false) {
  const who = person(b);
  if (who.error) return [400, who];
  if (!DATE_RE.test(b.date || '')) return [400, { error: 'Fecha inválida' }];
  if (!admin && b.date > addDays(nowAR().date, 30)) return [400, { error: 'Se puede reservar hasta 30 días antes' }];
  const paddles = Number(b.paddles || 0);
  if (!Number.isInteger(paddles) || paddles < 0 || paddles > MAX_PADDLES) return [400, { error: 'Cantidad de paletas inválida' }];
  const [court] = await sql`SELECT * FROM ${t.courts} WHERE id = ${Number(b.court_id) || 0} AND active`;
  if (!court) return [400, { error: 'Cancha inválida' }];
  const slot = (await slots(b.date)).find(s => s.start === b.start);
  if (!slot || slot.past) return [400, { error: 'Ese horario no está disponible' }];
  await prepare(b.date);
  const price = court.price + paddles * Number((await settings()).paddle_price);
  const status = admin && b.status === 'pagado' ? 'pagado' : 'pendiente';
  // Las reservas del admin no vencen (pagan en el club); las de la web sí.
  const expires = admin ? null : new Date(Date.now() + PAY_MINUTES * 60e3);
  try {
    const [r] = await sql`INSERT INTO ${t.bookings} (court_id, date, start, name, phone, price, paddles, status, expires_at)
      VALUES (${court.id}, ${b.date}, ${b.start}, ${who.name}, ${who.phone}, ${price}, ${paddles}, ${status}, ${expires}) RETURNING id`;
    return [201, { id: r.id, price, paddles, court: court.name, date: b.date, start: b.start, minutes: PAY_MINUTES }];
  } catch (e) {
    if (e.code === '23505') return [409, { error: 'Ese turno ya fue reservado, elegí otro' }];
    throw e;
  }
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  if (p === '/api/info' && m === 'GET') {
    const s = await settings();
    return send(res, 200, {
      courts: await sql`SELECT id, name, kind, price FROM ${t.courts} WHERE active ORDER BY id`,
      slot: Number(s.slot), paddle_price: Number(s.paddle_price), max_paddles: MAX_PADDLES, pay_minutes: PAY_MINUTES, today: nowAR().date,
    });
  }
  if (p === '/api/availability' && m === 'GET') {
    const date = url.searchParams.get('date');
    if (!DATE_RE.test(date || '')) return send(res, 400, { error: 'Fecha inválida' });
    await prepare(date);
    const taken = await sql`SELECT court_id, start FROM ${t.bookings} WHERE date = ${date} AND status IN ('pendiente', 'pagado')`;
    return send(res, 200, { slots: await slots(date), taken });
  }
  if (p === '/api/bookings' && m === 'POST') return send(res, ...(await createBooking(await body(req))));

  if (p === '/api/admin/login' && m === 'POST') {
    const { password } = await body(req);
    if (!timingSafeEqual(sha(password), sha(ADMIN_PASSWORD))) return send(res, 401, { error: 'Contraseña incorrecta' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, newSession(), SESSION_HOURS * 3600) });
  }
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'No encontrado' });
  if (!isAdmin(req)) return send(res, 401, { error: 'No autorizado' });

  if (p === '/api/admin/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }
  if (p === '/api/admin/data' && m === 'GET') {
    const date = url.searchParams.get('date');
    if (!DATE_RE.test(date || '')) return send(res, 400, { error: 'Fecha inválida' });
    await prepare(date);
    return send(res, 200, {
      settings: await settings(),
      courts: await sql`SELECT * FROM ${t.courts} ORDER BY id`,
      slots: (await slots(date)).map(s => s.start),
      bookings: await sql`SELECT * FROM ${t.bookings} WHERE date = ${date} ORDER BY start, court_id`,
      fixed: await sql`SELECT f.*, c.name AS court FROM ${t.fixed} f JOIN ${t.courts} c ON c.id = f.court_id WHERE f.active ORDER BY weekday, start, court_id`,
    });
  }
  if (p === '/api/admin/bookings' && m === 'POST') return send(res, ...(await createBooking(await body(req), true)));

  let id;
  if ((id = /^\/api\/admin\/bookings\/(\d+)$/.exec(p)?.[1]) && m === 'PATCH') {
    const { status } = await body(req);
    if (!['pendiente', 'pagado', 'cancelado'].includes(status)) return send(res, 400, { error: 'Estado inválido' });
    // Lo que toca el dueño ya está verificado: deja de vencer.
    try { await sql`UPDATE ${t.bookings} SET status = ${status}, expires_at = NULL WHERE id = ${id}`; }
    catch (e) { if (e.code !== '23505') throw e; return send(res, 409, { error: 'Ese turno ya tiene otra reserva activa' }); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/fixed' && m === 'POST') {
    const b = await body(req), who = person(b), wd = Number(b.weekday), today = nowAR().date;
    if (who.error) return send(res, 400, who);
    if (!(Number.isInteger(wd) && wd >= 0 && wd <= 6)) return send(res, 400, { error: 'Día inválido' });
    if (!(await slots(today)).some(s => s.start === b.start)) return send(res, 400, { error: 'Horario inválido' });
    const [court] = await sql`SELECT id FROM ${t.courts} WHERE id = ${Number(b.court_id) || 0} AND active`;
    if (!court) return send(res, 400, { error: 'Cancha inválida' });
    try {
      await sql`INSERT INTO ${t.fixed} (court_id, weekday, start, name, phone, since)
        VALUES (${court.id}, ${wd}, ${b.start}, ${who.name}, ${who.phone}, ${today})`;
    } catch (e) { if (e.code !== '23505') throw e; return send(res, 409, { error: 'Ya hay un turno fijo en esa cancha, día y horario' }); }
    // Fechas ya reservadas por otros: ahí el fijo no se aplica, el dueño decide.
    const conflicts = (await sql`SELECT date, name FROM ${t.bookings}
      WHERE court_id = ${court.id} AND start = ${b.start} AND date >= ${today} AND fixed_id IS NULL
        AND status IN ('pendiente', 'pagado') ORDER BY date`).filter(r => weekday(r.date) === wd);
    return send(res, 201, { conflicts });
  }
  if ((id = /^\/api\/admin\/fixed\/(\d+)$/.exec(p)?.[1]) && m === 'DELETE') {
    await sql.begin(async tx => {
      await tx`UPDATE ${t.fixed} SET active = false WHERE id = ${id}`;
      await tx`UPDATE ${t.bookings} SET status = 'cancelado'
        WHERE fixed_id = ${id} AND date >= ${nowAR().date} AND status = 'pendiente'`;
    });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/settings' && m === 'PUT') {
    const { open, close, slot, paddle_price } = await body(req);
    const T = /^([01]\d|2[0-3]):[0-5]\d$/, pp = Number(paddle_price);
    if (!T.test(open) || !T.test(close) || ![60, 90, 120].includes(Number(slot)) || !(Number.isInteger(pp) && pp >= 0))
      return send(res, 400, { error: 'Datos inválidos' });
    const values = { open, close, slot: String(slot), paddle_price: String(pp) };
    await sql.begin(tx => Object.entries(values).map(([k, v]) => tx`UPDATE ${t.settings} SET value = ${v} WHERE key = ${k}`));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/courts' && m === 'POST') {
    const { name, kind, price } = await body(req);
    if (!String(name || '').trim() || !(Number(price) >= 0)) return send(res, 400, { error: 'Datos inválidos' });
    await sql`INSERT INTO ${t.courts} (name, kind, price) VALUES (${String(name).trim()}, ${String(kind || 'Blindex').trim()}, ${Math.round(price)})`;
    return send(res, 201, { ok: true });
  }
  if ((id = /^\/api\/admin\/courts\/(\d+)$/.exec(p)?.[1]) && m === 'PUT') {
    const { name, kind, price, active } = await body(req);
    if (!String(name || '').trim() || !(Number(price) >= 0)) return send(res, 400, { error: 'Datos inválidos' });
    await sql`UPDATE ${t.courts} SET name = ${String(name).trim()}, kind = ${String(kind || '').trim()},
      price = ${Math.round(price)}, active = ${!!active} WHERE id = ${id}`;
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'No encontrado' });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const page = PAGES[url.pathname];
    const full = page ? fileURLToPath(page) : normalize(join(PUBLIC, url.pathname));
    if (!full.startsWith(PUBLIC)) throw Object.assign(new Error(), { code: 'ENOENT' });
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') { res.writeHead(404); return res.end('No encontrado'); }
    if (/too big|bad json/.test(e.message)) return send(res, 400, { error: 'Pedido inválido' });
    console.error(e);
    send(res, 500, { error: 'Error del servidor' });
  }
}

// En local (node server.js) escucha en un puerto; en Vercel (preset Node) se usa el handler exportado.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  http.createServer(handler).listen(PORT, () => console.log(`Luján Pádel en http://localhost:${PORT}  (admin: /admin)`));
}
