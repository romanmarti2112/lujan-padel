// Prueba el flujo de reservas en un esquema temporal de Supabase (se borra al final): npm test
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import assert from 'node:assert/strict';

const SCHEMA = `test_${process.pid}`, PORT = 3999, U = `http://localhost:${PORT}`;
// Sin .env prueba contra un Postgres local en memoria; con .env, contra Supabase.
const DATABASE_URL = process.env.DATABASE_URL || await (await import('./local-db.js')).startLocalDb();
const sql = postgres(DATABASE_URL, { ssl: /@(127\.0\.0\.1|localhost)[:/]/.test(DATABASE_URL) ? false : 'require', prepare: false, onnotice: () => {} });
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATABASE_URL, PORT, DB_SCHEMA: SCHEMA, ADMIN_PASSWORD: 'x', MAX_PER_IP_HOUR: '9' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, fail) => { srv.stdout.once('data', ok); srv.once('exit', () => fail(new Error('El servidor no arrancó: revisá DATABASE_URL en .env'))); });

const call = async (path, method = 'GET', body, cookie) => {
  const r = await fetch(U + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
};
// Reserva web con un teléfono distinto cada vez (salvo que se pase uno), para no chocar con el límite por teléfono.
let phoneN = 0;
const book = b => call('/api/bookings', 'POST', { phone: `26100000${String(phoneN++).padStart(2, '0')}`, ...b });
const takenAt = async (date, court, start) => (await call('/api/availability?date=' + date)).data.taken.some(x => x.court_id === court && x.start === start);
const bookings = sql(SCHEMA + '.bookings');

try {
  const { data: info } = await call('/api/info');
  assert.equal(info.courts.length, 5);
  const date = new Date(Date.parse(info.today) + 864e5).toISOString().slice(0, 10); // mañana: ningún turno pasado
  const { data: av } = await call('/api/availability?date=' + date);
  assert.equal(av.slots[0].start, '08:30');
  assert.equal(av.slots.at(-1).start, '23:30');
  assert.equal(av.slots.length, 11); // 08:30 a 23:30 (termina 01:00), turnos de 90 min

  // reserva + paletas
  const req = { court_id: 1, date, start: '08:30', name: 'Ana' };
  const b = await book({ ...req, paddles: 2 });
  assert.equal(b.status, 201);
  assert.equal(b.data.price, 24000 + 2 * 3000);
  assert.equal((await book(req)).status, 409, 'doble reserva');
  assert.equal((await book({ ...req, start: '09:00' })).status, 400, 'horario fuera de grilla');
  assert.equal((await book({ ...req, court_id: 3, start: '23:30' })).status, 201, 'turno de 23:30 a 01:00');
  assert.equal((await book({ ...req, date: '2020-01-01' })).status, 400, 'fecha pasada');
  assert.equal((await book({ ...req, start: '10:00', paddles: 9 })).status, 400, 'paletas de más');

  // vence a los 30 min sin verificar
  await sql`UPDATE ${bookings} SET expires_at = now() - interval '1 minute' WHERE id = ${b.data.id}`;
  assert.equal(await takenAt(date, 1, '08:30'), false, 'reserva vencida libera el turno');
  const b2 = await book(req);
  assert.equal(b2.status, 201, 'se puede volver a reservar');

  // admin
  assert.equal((await call('/api/admin/data?date=' + date)).status, 401);
  assert.equal((await call('/api/admin/login', 'POST', { password: 'mal' })).status, 401);
  const { cookie } = await call('/api/admin/login', 'POST', { password: 'x' });
  assert.equal((await call(`/api/admin/bookings/${b.data.id}`, 'PATCH', { status: 'pagado' }, cookie)).status, 409, 'no recuperar vencida si ya está tomada');
  assert.equal((await call(`/api/admin/bookings/${b2.data.id}`, 'PATCH', { status: 'pagado' }, cookie)).status, 200);
  await sql`UPDATE ${bookings} SET expires_at = now() - interval '1 minute' WHERE id = ${b2.data.id}`;
  assert.equal(await takenAt(date, 1, '08:30'), true, 'pagada no vence');
  await call(`/api/admin/bookings/${b2.data.id}`, 'PATCH', { status: 'cancelado' }, cookie);
  assert.equal((await book(req)).status, 201, 'cancelar libera el turno');

  // reserva manual del admin no vence
  const man = await call('/api/admin/bookings', 'POST', { ...req, start: '10:00', status: 'pendiente', phone: '2616666666' }, cookie);
  assert.equal(man.status, 201);
  assert.equal((await sql`SELECT expires_at FROM ${bookings} WHERE id = ${man.data.id}`)[0].expires_at, null);

  // turno fijo: ocupa el horario todas las semanas
  const wd = new Date(date + 'T12:00Z').getUTCDay(), nextWeek = new Date(Date.parse(date) + 7 * 864e5).toISOString().slice(0, 10);
  const fx = await call('/api/admin/fixed', 'POST', { court_id: 2, weekday: wd, start: '11:30', name: 'Fijo Juan', phone: '2619999999' }, cookie);
  assert.equal(fx.status, 201);
  assert.equal((await call('/api/admin/fixed', 'POST', { court_id: 2, weekday: wd, start: '11:30', name: 'Otro', phone: '2618888888' }, cookie)).status, 409);
  assert.equal(await takenAt(date, 2, '11:30'), true);
  assert.equal(await takenAt(nextWeek, 2, '11:30'), true);
  assert.equal((await book({ ...req, court_id: 2, start: '11:30' })).status, 409, 'no se pisa un fijo');
  // cancelar una fecha del fijo libera solo esa fecha
  const occ = (await call('/api/admin/data?date=' + date, 'GET', null, cookie)).data.bookings.find(x => x.fixed_id);
  await call(`/api/admin/bookings/${occ.id}`, 'PATCH', { status: 'cancelado' }, cookie);
  assert.equal(await takenAt(date, 2, '11:30'), false, 'fecha cancelada no se recrea');
  assert.equal(await takenAt(nextWeek, 2, '11:30'), true);
  const fixedId = (await call('/api/admin/data?date=' + date, 'GET', null, cookie)).data.fixed[0].id;
  await call('/api/admin/fixed/' + fixedId, 'DELETE', null, cookie);
  assert.equal(await takenAt(nextWeek, 2, '11:30'), false, 'quitar el fijo libera las próximas fechas');

  // anti-abuso: máximo 2 reservas sin pagar por teléfono (comparando los últimos 10 dígitos)
  assert.equal((await book({ ...req, start: '14:30', phone: '2615550000' })).status, 201);
  assert.equal((await book({ ...req, start: '16:00', phone: '2615550000' })).status, 201);
  const third = await book({ ...req, start: '17:30', phone: '+54 9 261 555-0000' });
  assert.equal(third.status, 429, 'tercera reserva sin pagar del mismo número');
  // el admin las cancela todas de una
  assert.equal((await call('/api/admin/cancel-phone', 'POST', { phone: '2615550000' }, cookie)).data.cancelled, 2);
  assert.equal((await book({ ...req, start: '17:30', phone: '2615550000' })).status, 201, 'liberado tras cancelar');

  // precios
  assert.equal((await call('/api/admin/courts/1', 'PUT', { name: 'Cancha 1', kind: 'Blindex', price: 30000, active: true }, cookie)).status, 200);
  assert.equal((await call('/api/admin/settings', 'PUT', { open: '08:30', close: '01:00', slot: 90, paddle_price: 5000 }, cookie)).status, 200);
  assert.equal((await book({ ...req, start: '13:00', paddles: 1 })).data.price, 35000);

  // anti-abuso: tope de reservas por hora desde la misma conexión (MAX_PER_IP_HOUR = 9 en este test)
  let limited = false;
  for (const start of ['08:30', '10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00']) {
    const r = await book({ ...req, court_id: 4, date: nextWeek, start });
    if (r.status === 429) { limited = true; break; }
    assert.equal(r.status, 201);
  }
  assert.ok(limited, 'corta las reservas seguidas desde la misma conexión');
  assert.equal((await call('/api/admin/bookings', 'POST', { ...req, court_id: 5, date: nextWeek, start: '20:30', phone: '2617777777' }, cookie)).status, 201, 'el admin no tiene tope');
  console.log('OK: todas las pruebas pasaron');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  srv.kill();
  await new Promise(ok => srv.once('exit', ok));
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.end();
  process.exit(process.exitCode ?? 0); // cierra el Postgres local si se usó
}
