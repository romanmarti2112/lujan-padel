const ALIAS = 'lujanpadelclub', WA = '542613463901';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = n => '$' + Number(n).toLocaleString('es-AR');
const longDate = d => new Date(d + 'T12:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
let info, date, pick = null;

const api = async (url, opts) => {
  const r = await fetch(url, opts && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Error');
  return data;
};

function renderDays() {
  const base = new Date(info.today + 'T12:00');
  $('days').innerHTML = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(base); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const wd = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : d.toLocaleDateString('es-AR', { weekday: 'short' });
    return `<button class="day" data-date="${iso}" aria-pressed="${iso === date}"><small>${wd}</small><b>${d.getDate()}</b><small>${d.toLocaleDateString('es-AR', { month: 'short' })}</small></button>`;
  }).join('');
}

const LOADER = '<div class="loader" role="status"><span class="loader-ball"></span><span class="loader-shadow"></span><span>Buscando turnos…</span></div>';
async function load() {
  pick = null; updateBar();
  $('courts').innerHTML = LOADER;
  const { slots, taken } = await api('/api/availability?date=' + date);
  const busy = new Set(taken.map(t => t.court_id + '|' + t.start));
  $('courts').innerHTML = info.courts.map((c, i) => `
    <article class="court" style="--i:${i}">
      <header><div><h3>${esc(c.name)}</h3><span class="kind">${esc(c.kind)}</span></div><span class="price">${money(c.price)} <small style="color:var(--muted);font-weight:600">/ ${info.slot} min</small></span></header>
      <div class="slots">${slots.map(s => {
        const off = s.past || busy.has(c.id + '|' + s.start);
        return `<button class="slot" data-court="${c.id}" data-start="${s.start}" ${off ? 'disabled aria-label="' + s.start + ' ocupado"' : ''} aria-pressed="false">${s.start}</button>`;
      }).join('')}</div>
    </article>`).join('') || '<p>No hay canchas disponibles.</p>';
}

function updateBar() {
  $('bar').classList.toggle('show', !!pick);
  if (pick) $('barText').innerHTML = `<b>${pick.court.name}</b> · ${longDate(date)} · ${pick.start} hs · ${money(pick.court.price)}`;
}

$('days').onclick = e => {
  const b = e.target.closest('.day'); if (!b) return;
  date = b.dataset.date; renderDays(); load();
};
$('courts').onclick = e => {
  const b = e.target.closest('.slot'); if (!b || b.disabled) return;
  document.querySelectorAll('.slot[aria-pressed="true"]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  b.setAttribute('aria-pressed', 'true');
  pick = { court: info.courts.find(c => c.id == b.dataset.court), start: b.dataset.start };
  updateBar();
};
$('barBtn').onclick = () => {
  $('formSummary').textContent = `${pick.court.name} · ${longDate(date)} · ${pick.start} hs`;
  $('formErr').textContent = '';
  const pp = info.paddle_price;
  $('paddles').innerHTML = '<option value="0">No, llevo las mías</option>' +
    Array.from({ length: info.max_paddles }, (_, i) => `<option value="${i + 1}">${i + 1} paleta${i ? 's' : ''} (+${money((i + 1) * pp)})</option>`).join('');
  formTotal();
  $('formDlg').showModal();
};
const formTotal = () => $('formTotal').textContent = money(pick.court.price + $('paddles').value * info.paddle_price);
$('paddles').onchange = formTotal;
$('form').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('submitBtn').disabled = true;
  try {
    const b = await api('/api/bookings', { court_id: pick.court.id, date, start: pick.start, name: f.get('name'), phone: f.get('phone'), paddles: Number(f.get('paddles')) });
    $('formDlg').close();
    const resumen = `${b.court} · ${longDate(b.date)} · ${b.start} hs` + (b.paddles ? ` · ${b.paddles} paleta${b.paddles > 1 ? 's' : ''}` : '');
    const hasta = new Date(Date.now() + b.minutes * 60e3).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    $('payDeadline').textContent = `⏱ Tenés ${b.minutes} minutos (hasta las ${hasta}) para pagar y mandar el comprobante. Si no, el turno se libera.`;
    $('paySummary').textContent = `Reserva #${b.id} · ${resumen}`;
    $('payTotal').textContent = money(b.price);
    $('waBtn').href = `https://wa.me/${WA}?text=` + encodeURIComponent(
      `¡Hola! Soy ${f.get('name')}. Te envío el comprobante de la reserva #${b.id}: ${resumen} (${money(b.price)}), pagada al alias ${ALIAS}.`);
    $('payDlg').showModal();
    const hit = $('hitAnim'); hit.classList.remove('play'); void hit.getBoundingClientRect(); hit.classList.add('play');
    load();
  } catch (err) {
    $('formErr').textContent = err.message;
    $('formErr').classList.remove('shake'); void $('formErr').offsetWidth; $('formErr').classList.add('shake');
    if (/reservado/.test(err.message)) load();
  } finally { $('submitBtn').disabled = false; }
};
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(ALIAS); $('copyBtn').textContent = '¡Copiado!'; $('copyBtn').classList.add('ok'); }
  catch { $('copyBtn').textContent = 'Copialo a mano'; }
  setTimeout(() => { $('copyBtn').textContent = 'Copiar'; $('copyBtn').classList.remove('ok'); }, 2000);
};

// Aparecer al hacer scroll (solo si se permiten animaciones; sin JS todo se ve normal).
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: .15 });
  document.querySelectorAll('.section .eyebrow, .section h2, .stats > div, .gallery img, .contact > *').forEach(el => {
    el.classList.add('reveal');
    if (el.matches('.stats > div, .gallery img')) el.style.transitionDelay = [...el.parentNode.children].indexOf(el) * 80 + 'ms';
    io.observe(el);
  });
}

// Peloteo de la portada: la pelota se mueve en metros (X lateral, z profundidad 0..1, H altura) y se proyecta a la cancha dibujada.
(() => {
  // En celular se muestra la cancha entera debajo del texto en vez de recortada de fondo.
  const svg = document.querySelector('.court-bg'), narrow = matchMedia('(max-width: 640px)');
  const fit = () => {
    svg.setAttribute('viewBox', narrow.matches ? '200 40 1200 860' : '0 0 1600 900');
    svg.setAttribute('preserveAspectRatio', narrow.matches ? 'xMidYMax meet' : 'xMidYMax slice');
  };
  fit(); narrow.onchange = fit;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ball = $('heroBall'), shadow = $('heroShadow'), ring = $('heroBounce'), net = $('heroNet');
  const proj = (X, z, H) => { const s = 1 / (1 + 1.25 * z), g = -110 + 990 * s; return { s, g, x: 800 + X * 108 * s, y: g - H * 108 * s }; };
  // [desde, hasta, altura extra en el medio, segundos, pica al final]
  const legs = [
    [[-2, .08, 1], [1.5, .78, 0], 2.2, 1.1, true],
    [[1.5, .78, 0], [2, .94, .9], .9, .45, false],
    [[2, .94, .9], [-1.5, .25, 0], 2, 1.1, true],
    [[-1.5, .25, 0], [-2, .08, 1], .8, .45, false],
  ];
  const total = legs.reduce((a, l) => a + l[3], 0);
  const set = (el, attrs) => { for (const k in attrs) el.setAttribute(k, attrs[k]); };
  let bounce = null, lastLeg = -1;
  const frame = now => {
    let t = (now / 1000) % total, i = 0;
    while (t > legs[i][3]) t -= legs[i++][3];
    const [a, b, peak, dur] = legs[i], k = t / dur, lerp = j => a[j] + (b[j] - a[j]) * k;
    // al pasar al tramo siguiente, si el anterior terminaba en pique, dibujar el anillo
    if (i !== lastLeg && lastLeg !== -1 && legs[lastLeg][4]) bounce = { at: now, ...proj(legs[lastLeg][1][0], legs[lastLeg][1][1], 0) };
    lastLeg = i;
    const p = proj(lerp(0), lerp(1), lerp(2) + 4 * peak * k * (1 - k));
    // del lado del fondo la pelota pasa por detrás de la red
    const behind = lerp(1) > .5;
    if (behind !== (ball.nextElementSibling !== null)) behind ? net.before(ball) : net.parentNode.append(ball);
    set(ball, { cx: p.x, cy: p.y, r: 11 * p.s });
    set(shadow, { cx: p.x, cy: p.g, rx: 12 * p.s, ry: 4 * p.s, 'fill-opacity': Math.max(.08, .4 - (p.g - p.y) / 400) });
    if (bounce) {
      const e = Math.min(1, (now - bounce.at) / 500);
      set(ring, { cx: bounce.x, cy: bounce.g, rx: (8 + 30 * e) * bounce.s, ry: (3 + 10 * e) * bounce.s, 'stroke-opacity': .6 * (1 - e) });
      if (e >= 1) bounce = null;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();

(async () => {
  try {
    info = await api('/api/info');
    date = info.today;
    renderDays(); load();
  } catch { $('courts').innerHTML = '<p>No pudimos cargar los turnos. Escribinos por WhatsApp.</p>'; }
})();
$('formBack').onclick = () => $('formDlg').close();
$('payDone').onclick = () => $('payDlg').close();
