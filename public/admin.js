const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const money = n => '$' + Number(n).toLocaleString('es-AR');
const toast = msg => { const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg }); document.body.append(t); setTimeout(() => t.remove(), 2200); };
let data;

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (r.status === 401 && !url.endsWith('login')) { showLogin(); throw new Error(d.error); }
  if (r.status === 503) { showLogin(); $('loginErr').textContent = d.error; throw new Error(d.error); }
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}
const showLogin = () => { $('login').hidden = false; $('app').hidden = true; $('logout').hidden = true; };

async function load() {
  const date = $('date').value;
  data = await api('/api/admin/data?date=' + date);
  $('login').hidden = true; $('app').hidden = false; $('logout').hidden = false;
  $('dateTitle').textContent = new Date(date + 'T12:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  const active = data.bookings.filter(b => ['pendiente', 'pagado'].includes(b.status));
  const sum = st => active.filter(b => b.status === st).reduce((a, b) => a + b.price, 0);
  const courts = data.courts.filter(c => c.active);
  $('kpis').innerHTML = `
    <div><b>${active.length} / ${courts.length * data.slots.length}</b><span>turnos ocupados</span></div>
    <div><b>${money(sum('pagado'))}</b><span>cobrado</span></div>
    <div><b>${money(sum('pendiente'))}</b><span>pendiente de pago (${active.filter(b => b.status === 'pendiente').length})</span></div>`;

  const at = new Map(active.map(b => [b.court_id + '|' + b.start, b]));
  const cell = (b, title = '') => `<div class="cell ${b.status}">
        ${title ? `<div class="cell-court">${esc(title)}</div>` : ''}
        <b>${esc(b.name)}</b><br><a href="https://wa.me/${esc(b.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(b.phone)}</a><br>
        #${b.id} · ${money(b.price)} · ${b.status}${b.fixed_id ? ' · <b>FIJO</b>' : ''}${b.paddles ? ` · 🏓 ${b.paddles} paleta${b.paddles > 1 ? 's' : ''}` : ''}
        ${b.expires_at && b.status === 'pendiente' ? `<br><small>Se libera a las ${new Date(b.expires_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} si no pagan</small>` : ''}
        <div class="acts">
          ${b.status === 'pendiente' ? `<button class="btn btn-navy btn-sm" data-id="${b.id}" data-st="pagado">Marcar pagado</button>` : `<button class="btn btn-ghost btn-sm" data-id="${b.id}" data-st="pendiente">Pendiente</button>`}
          <button class="btn btn-ghost btn-sm" data-id="${b.id}" data-st="cancelado">Cancelar</button>
          ${b.expires_at && b.status === 'pendiente' ? `<button class="btn btn-ghost btn-sm" data-cancel-phone="${esc(b.phone)}" title="Si alguien llenó la grilla de reservas falsas">Cancelar todas de este número</button>` : ''}
        </div></div>`;
  $('grid').innerHTML = `<tr><th>Hora</th>${courts.map(c => `<th>${esc(c.name)}</th>`).join('')}</tr>` +
    data.slots.map(s => `<tr><th>${s}</th>${courts.map(c => {
      const b = at.get(c.id + '|' + s);
      return `<td>${b ? cell(b) : '<div class="cell free">Libre</div>'}</td>`;
    }).join('')}</tr>`).join('');
  // Celular: un bloque por horario con las reservas y qué canchas quedan libres.
  $('list').innerHTML = data.slots.map(s => {
    const busy = courts.filter(c => at.has(c.id + '|' + s)), free = courts.filter(c => !at.has(c.id + '|' + s));
    return `<div class="slotrow"><div class="slothead"><b>${s}</b><span>${!busy.length ? 'Todas libres' : free.length ? 'Libres: ' + free.map(c => esc(c.name)).join(', ') : 'Completo'}</span></div>
      ${busy.map(c => cell(at.get(c.id + '|' + s), c.name)).join('')}</div>`;
  }).join('');

  const vencidas = data.bookings.filter(b => b.status === 'vencido');
  $('expired').innerHTML = vencidas.length ? `<h4 style="margin:16px 0 6px">Vencidas (no se verificó el pago en 30 min)</h4>` + vencidas.map(b =>
    `<div class="cell" style="background:#f1f3f7;margin-bottom:6px">${b.start} · ${esc(courts.find(c => c.id === b.court_id)?.name || '')} · <b>${esc(b.name)}</b> · ${esc(b.phone)} · ${money(b.price)}
      <button class="btn btn-ghost btn-sm" data-id="${b.id}" data-st="pagado">Pagó igual: recuperar</button></div>`).join('') : '';

  for (const sel of ['manualCourt', 'fixedCourt']) $(sel).innerHTML = courts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  for (const sel of ['manualStart', 'fixedStart']) $(sel).innerHTML = data.slots.map(s => `<option>${s}</option>`).join('');
  $('fixedTbl').innerHTML = data.fixed.length ? '<tr><th>Cuándo</th><th>Quién</th><th></th></tr>' + data.fixed.map(f =>
    `<tr><td><b>${DAYS[f.weekday]} ${f.start}</b><br>${esc(f.court)}</td><td>${esc(f.name)}<br>${esc(f.phone)}</td>
      <td><button class="btn btn-ghost btn-sm" data-del-fixed="${f.id}">Quitar</button></td></tr>`).join('') : '<tr><td>No hay turnos fijos.</td></tr>';

  const f = $('settings');
  f.open.value = data.settings.open; f.close.value = data.settings.close; f.slot.value = data.settings.slot; f.paddle_price.value = data.settings.paddle_price;

  $('courtsTbl').innerHTML = '<tr><th>Nombre</th><th>Tipo</th><th>Precio por turno</th><th>Activa</th><th></th></tr>' +
    data.courts.map(c => `<tr data-court="${c.id}">
      <td data-label="Nombre"><input name="name" value="${esc(c.name)}"></td>
      <td data-label="Tipo"><input name="kind" value="${esc(c.kind)}"></td>
      <td data-label="Precio por turno"><input name="price" type="number" min="0" step="100" value="${c.price}"></td>
      <td data-label="Activa"><input name="active" type="checkbox" ${c.active ? 'checked' : ''} style="width:auto"></td>
      <td><button class="btn btn-navy btn-sm" data-save>Guardar</button></td></tr>`).join('');
}

// fn devuelve false cuando el click no era una acción
const run = fn => async e => { if (e.type === 'submit') e.preventDefault(); try { if (await fn(e) !== false) await load(); } catch (err) { toast(err.message); } };

$('login').onsubmit = async e => {
  e.preventDefault();
  try { await api('/api/admin/login', 'POST', { password: e.target.password.value }); e.target.reset(); await load(); }
  catch (err) { $('loginErr').textContent = err.message; }
};
$('logout').onclick = async () => { await api('/api/admin/logout', 'POST'); showLogin(); };
$('date').onchange = () => load().catch(() => {});
document.querySelectorAll('[data-shift]').forEach(b => b.onclick = () => {
  const d = new Date($('date').value + 'T12:00'); d.setDate(d.getDate() + Number(b.dataset.shift));
  $('date').value = d.toISOString().slice(0, 10); load().catch(() => {});
});
$('expired').onclick = $('list').onclick = e => $('grid').onclick(e);
$('fixedForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await api('/api/admin/fixed', 'POST', Object.fromEntries(new FormData(e.target)));
    $('fixedErr').textContent = r.conflicts.length ? 'Fijo creado, pero estas fechas ya estaban reservadas por otros y ahí no se aplica: ' +
      r.conflicts.map(c => `${c.date.split('-').reverse().join('/')} (${c.name})`).join(', ') : '';
    e.target.reset(); toast('Turno fijo agregado'); await load();
  } catch (err) { $('fixedErr').textContent = err.message; }
};
$('fixedTbl').onclick = run(async e => {
  const b = e.target.closest('[data-del-fixed]'); if (!b) return false;
  if (!confirm('¿Quitar este turno fijo? Se liberan sus próximas fechas sin pagar.')) return false;
  await api('/api/admin/fixed/' + b.dataset.delFixed, 'DELETE');
});
$('grid').onclick = run(async e => {
  const cp = e.target.closest('[data-cancel-phone]');
  if (cp) {
    if (!confirm(`¿Cancelar TODAS las reservas sin pagar del ${cp.dataset.cancelPhone}, de hoy en adelante?`)) return false;
    const r = await api('/api/admin/cancel-phone', 'POST', { phone: cp.dataset.cancelPhone });
    return toast(`${r.cancelled} reserva${r.cancelled === 1 ? '' : 's'} cancelada${r.cancelled === 1 ? '' : 's'}`);
  }
  const b = e.target.closest('[data-st]'); if (!b) return false;
  if (b.dataset.st === 'cancelado' && !confirm('¿Cancelar esta reserva? El turno queda libre.')) return false;
  await api('/api/admin/bookings/' + b.dataset.id, 'PATCH', { status: b.dataset.st });
});
$('manual').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try { await api('/api/admin/bookings', 'POST', { ...f, date: $('date').value }); e.target.reset(); $('manualErr').textContent = ''; toast('Reserva agregada'); await load(); }
  catch (err) { $('manualErr').textContent = err.message; }
};
$('settings').onsubmit = run(async e => { await api('/api/admin/settings', 'PUT', Object.fromEntries(new FormData(e.target))); toast('Horarios guardados'); });
$('courtsTbl').onclick = run(async e => {
  if (!e.target.closest('[data-save]')) return false;
  const tr = e.target.closest('tr'), q = n => tr.querySelector(`[name=${n}]`);
  await api('/api/admin/courts/' + tr.dataset.court, 'PUT', { name: q('name').value, kind: q('kind').value, price: Number(q('price').value), active: q('active').checked });
  toast('Cancha guardada');
});
$('newCourt').onsubmit = run(async e => {
  const f = Object.fromEntries(new FormData(e.target));
  await api('/api/admin/courts', 'POST', { ...f, price: Number(f.price) }); e.target.reset(); toast('Cancha agregada');
});

$('date').value = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Mendoza' }).slice(0, 10);
load().catch(() => {});
