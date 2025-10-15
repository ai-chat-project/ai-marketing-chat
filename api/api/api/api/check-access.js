import Stripe from 'stripe';
let kv = null;
try { ({ kv } = await import('@vercel/kv')); } catch {}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function parseCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const m = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function readFromKV(customerId) {
  if (!kv) return null;
  try { return await kv.get(`sub:customer:${customerId}`); } catch { return null; }
}

async function readFromStripe(customerId) {
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
  try {
    const customerId = parseCookie(req, 'stripe_cid');
    if (!customerId) return res.status(200).json({ hasAccess: false });

    let info = await readFromKV(customerId);
    if (!info) info = await readFromStripe(customerId);
    if (!info) return res.status(200).json({ hasAccess: false });

    const now = Date.now();
    const statusOk = ['active', 'trialing'].includes(info.status);
    const withinPeriod = info.currentPeriodEnd ? new Date(info.currentPeriodEnd).getTime() > now : false;
    const withinTrial  = info.trialEnd ? new Date(info.trialEnd).getTime() > now : false;

    const hasAccess = (statusOk && (withinPeriod || withinTrial));
    res.status(200).json({ hasAccess, ...info });
  } catch (e) {
    res.status(200).json({ hasAccess: false });
  }
}
