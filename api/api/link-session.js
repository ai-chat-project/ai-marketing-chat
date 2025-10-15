import Stripe from 'stripe';
let kv = null;
try { ({ kv } = await import('@vercel/kv')); } catch {}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function syncLatestSubscription(customerId) {
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
    const sub = subs.data[0];
    if (!sub) return null;
    const info = {
      status: sub.status,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null
    };
    if (kv) await kv.set(`sub:customer:${customerId}`, info);
    return info;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || !session.customer) return res.status(400).json({ error: 'Invalid session' });

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;

    // Set secure cookie for access checks
    const cookie = `stripe_cid=${customerId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*365}; Secure`;
    res.setHeader('Set-Cookie', cookie);

    // sync subscription so access works immediately
    const subInfo = await syncLatestSubscription(customerId);

    res.status(200).json({ ok: true, customerId, sub: subInfo });
  } catch (e) {
    res.status(500).json({ error: 'Link failed' });
  }
}
