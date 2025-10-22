// api/check-access.js
import Stripe from 'stripe';

// --- Optional KV (δεν σπάει αν δεν υπάρχει) ---
let kv = null;
try { ({ kv } = await import('@vercel/kv')); } catch { /* KV not available */ }

// --- Stripe init (προαιρετικό: αν δεν υπάρχει key, απλώς δεν θα κάνουμε fallback call) ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || null;
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' }) : null;

// --- Utils ---
function parseCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  // ασφαλής regex για συγκεκριμένο cookie name
  const m = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function readFromKV(customerId) {
  if (!kv) return null;
  try {
    const v = await kv.get(`sub:customer:${customerId}`);
    // KV μπορεί να επιστρέψει string ή object ανάλογα με τον client
    if (!v) return null;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { /* not json */ return null; }
    }
    if (typeof v === 'object') return v;
    return null;
  } catch {
    return null;
  }
}

async function readFromStripe(customerId) {
  if (!stripe) return null; // αν δεν έχουμε key, μην προσπαθήσεις
  try {
    // πάρε μερικές συνδρομές και διάλεξε την πιο πρόσφατη ενεργή/δοκιμαστική
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    if (!subs?.data?.length) return null;

    // προτίμησε active/trialing, αλλιώς την πιο πρόσφατη
    const preferred = subs.data.find(s => s.status === 'active' || s.status === 'trialing')
                   || subs.data[0];

    const info = {
      status: preferred.status,
      currentPeriodEnd: preferred.current_period_end ? new Date(preferred.current_period_end * 1000).toISOString() : null,
      trialEnd: preferred.trial_end ? new Date(preferred.trial_end * 1000).toISOString() : null
    };

    // cache στο KV για ταχύτερα επόμενα checks (idempotent)
    try { if (kv) await kv.set(`sub:customer:${customerId}`, info); } catch {}

    return info;
  } catch {
    return null;
  }
}

// --- Handler ---
export default async function handler(req, res) {
  try {
    // πάντα JSON & no-store
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    const customerId = parseCookie(req, 'stripe_cid');
    if (!customerId) return res.status(200).json({ hasAccess: false });

    // 1) δοκίμασε KV
    let info = await readFromKV(customerId);

    // 2) fallback: Stripe (μόνο αν δεν βρέθηκε τίποτα)
    if (!info) info = await readFromStripe(customerId);
    if (!info) return res.status(200).json({ hasAccess: false });

    const now = Date.now();
    const statusOk = ['active', 'trialing'].includes(info.status);
    const withinPeriod = info.currentPeriodEnd ? new Date(info.currentPeriodEnd).getTime() > now : false;
    const withinTrial  = info.trialEnd ? new Date(info.trialEnd).getTime() > now : false;

    const hasAccess = statusOk && (withinPeriod || withinTrial);

    return res.status(200).json({
      hasAccess,
      status: info.status || null,
      currentPeriodEnd: info.currentPeriodEnd || null,
      trialEnd: info.trialEnd || null
    });
  } catch (e) {
    // ποτέ μην ρίχνεις 500 εδώ — καλύτερα “κλείδωσε” την πρόσβαση σιωπηλά
    return res.status(200).json({ hasAccess: false });
  }
}

