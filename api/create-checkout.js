// api/create-checkout.js
import Stripe from 'stripe';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
  // Early return με ξεκάθαρο μήνυμα για να μην παιδεύεσαι
  export default function handler(req, res) {
    return res.status(500).send('Missing STRIPE_SECRET_KEY. Add it in Vercel → Project → Settings → Environment Variables.');
  };
}

const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

// Fixed plan config (amounts in cents)
const AMOUNTS = { starter: 1399, pro: 2899, premium: 8799 };
const LOOKUP = {
  starter: 'novamark_starter_monthly_usd_1399',
  pro:     'novamark_pro_monthly_usd_2899',
  premium: 'novamark_premium_monthly_usd_8799'
};
const NICK = {
  starter: 'Starter Monthly',
  pro:     'Pro Monthly',
  premium: 'Premium Monthly'
};
const CURRENCY = 'usd';
const PRODUCT_SLUG = 'novamark_ai';
const PRODUCT_NAME = 'NovaMark AI';

function resolveSiteUrl(req) {
  // Προτεραιότητα σε env, αλλιώς από headers του Vercel
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers.host;
  if (host) return `${proto}://${host}`;
  return null; // θα πιάσουμε error παρακάτω
}

async function ensureProduct() {
  // idempotent εύρεση προϊόντος
  const list = await stripe.products.list({ limit: 100, active: true });
  const found =
    list.data.find(p => p.metadata?.slug === PRODUCT_SLUG) ||
    list.data.find(p => p.name === PRODUCT_NAME);
  if (found) return found;
  return stripe.products.create({ name: PRODUCT_NAME, metadata: { slug: PRODUCT_SLUG } });
}

async function ensurePrice(productId, plan) {
  const priceList = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const existing = priceList.data.find(
    p => p.lookup_key === LOOKUP[plan] && p.recurring?.interval === 'month' && p.currency === CURRENCY
  );
  if (existing) return existing;

  // Δημιουργία price μία φορά (idempotency μέσω lookup_key)
  return stripe.prices.create({
    product: productId,
    currency: CURRENCY,
    unit_amount: AMOUNTS[plan],
    recurring: { interval: 'month' },
    lookup_key: LOOKUP[plan],
    nickname: NICK[plan]
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    const { plan } = req.body || {};
    if (!['starter', 'pro', 'premium'].includes(plan)) {
      return res.status(400).send('Unknown plan');
    }

    const siteUrl = resolveSiteUrl(req);
    if (!siteUrl) return res.status(500).send('Unable to resolve site URL');

    const product = await ensureProduct();
    const price   = await ensurePrice(product.id, plan);

    // Βάση payload
    const payload = {
      mode: 'subscription',
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/#pricing`,
      allow_promotion_codes: true
    };

    // Trial μόνο για Pro
    if (plan === 'pro') {
      payload.subscription_data = { trial_period_days: 7 };
    }

    const session = await stripe.checkout.sessions.create(payload);
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e);
    // Δώσε καθαρό error μήνυμα στο frontend για εύκολο debug
    return res.status(500).send(e?.message || 'Stripe error');
  }
}
