import Stripe from 'stripe';

// Optional KV (δεν σπάει αν δεν έχεις το @vercel/kv)
let kv = null;
try {
  ({ kv } = await import('@vercel/kv'));
} catch { /* no kv available, continue */ }

// ---- Stripe init ----
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
  export default function handler(req, res) {
    return res
      .status(500)
      .send('Missing STRIPE_SECRET_KEY. Set it in Vercel → Project → Settings → Environment Variables.');
  };
}
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

// ---- Helpers ----
async function upsertSubscriptionInfo(sub) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;

  const info = {
    status: sub.status, // 'active' | 'trialing' | 'canceled' | 'past_due' | ...
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
  };

  if (kv) {
    try { await kv.set(`sub:customer:${customerId}`, info); } catch {}
  }
  return info;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).send('Missing session_id');

    // Πάρε το checkout session
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || !session.customer) return res.status(400).send('Invalid session');

    // (Προαιρετικά) βεβαιώσου ότι ολοκληρώθηκε:
    // if (session.status !== 'complete') return res.status(409).send('Session not complete yet');

    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer.id;

    // Cookie για access checks
    const cookie = [
      `stripe_cid=${encodeURIComponent(customerId)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Secure',
      `Max-Age=${60 * 60 * 24 * 365}`, // 1 year
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);

    // Πάρε το ΑΚΡΙΒΕΣ subscription που δημιουργήθηκε από το checkout (όχι list)
    let subInfo = null;
    if (session.subscription) {
      const subId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;

      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        subInfo = await upsertSubscriptionInfo(sub);
      } catch {
        // fallback: δεν βρέθηκε/δεν διαβάστηκε—δεν είναι κρίσιμο για το redirect
        subInfo = null;
      }
    } else {
      // Fallback: (σπάνιο) αν δεν επέστρεψε subscription, μη μπλοκάρεις το flow
      subInfo = null;
    }

    return res.status(200).json({ ok: true, customerId, sub: subInfo });
  } catch (e) {
    console.error('link-session error:', e);
    return res.status(500).send(e?.message || 'Link failed');
  }
}

