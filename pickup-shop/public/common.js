const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cur = n => 'GH₵ ' + Number(n).toFixed(2);
const LABEL = { awaiting_payment: 'Awaiting payment', payment_sent: 'Payment sent, being checked', paid: 'Payment confirmed',
  ready: 'Ready for pickup', picked_up: 'Picked up', cancelled: 'Cancelled' };
async function api(url, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch('/api' + url, { ...opts, headers: isForm ? {} : { 'Content-Type': 'application/json' },
    body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body })
    .catch(() => { throw new Error('You are offline or the shop cannot be reached. Try again when you have a connection.'); });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}
function toast(msg, bad) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  document.body.append(t); setTimeout(() => t.remove(), 3500);
}
const guard = f => async (...a) => { try { await f(...a); } catch (e) { toast(e.message, true); } };

// ---- PWA: offline support + install button ----
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
let installEvt = null;
const inst = $('#inst'), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (inst) inst.hidden = false; });
addEventListener('appinstalled', () => { installEvt = null; if (inst) inst.hidden = true; });
if (inst && !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) inst.hidden = false;   // iOS has no install event
if (inst) inst.onclick = async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; inst.hidden = true; }
  else toast('Tap the Share button, then Add to Home Screen');
};
addEventListener('offline', () => toast('You are offline. Saved items can still be browsed.', true));
addEventListener('online', () => toast('Back online'));
