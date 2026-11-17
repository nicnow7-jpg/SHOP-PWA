const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cur = n => 'GH₵ ' + Number(n).toFixed(2);
const LABEL = { awaiting_payment: 'Awaiting payment', payment_sent: 'Payment sent, being checked', paid: 'Payment confirmed',
  ready: 'Ready for pickup', picked_up: 'Picked up', cancelled: 'Cancelled' };
async function api(url, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch('/api' + url, { ...opts, headers: isForm ? {} : { 'Content-Type': 'application/json' },
    body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}
function toast(msg, bad) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  document.body.append(t); setTimeout(() => t.remove(), 3500);
}
const guard = f => async (...a) => { try { await f(...a); } catch (e) { toast(e.message, true); } };
