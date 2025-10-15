import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Fixed plan config
const AMOUNTS = { starter: 1399, pro: 2899, premium: 8799 }; // cents
const LOOKUP = {
  starter: 'novamark_starter_monthly_usd_1399',
  pro: 'novamark_pro_monthly_usd_2899',
  premium: 'novamark_premium_monthly_usd_8799'
};
const NICK = { starter: 'Starter Monthly', pro: 'Pro Monthly', premium: 'Premium Monthly' };
const CURRENCY = 'usd';
const PRODUCT_SLUG = 'novamark_ai';
const PRODUCT_NAME = 'NovaMark AI';

async function ensureProduct() {
  // try find by metadata.slug to be idempotent
  let product = null;
  const list = await stripe.products.list({ limit: 100, active: true });
  product = list.data.find(p => p.metadata?.slug === PRODUCT_SLUG) || list.data.find(p => p.name === PRODUCT_NAME);
  if (product) return product;
  return await stripe.products.create({ name: PRODUCT_NAME, metadata: { slug: PRODUCT_SLUG } });
}

async function ensurePrice(productId, plan) {
  const priceList = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  let price = priceList.data.find(p => p.lookup_key === LOOKUP[plan] && p.recurring?.interval === 'month' && p.currency === CURRENCY);
  if (price) return price;
  // create once
  price = await stripe.prices.create({
    product: productId,
    currency: CURRENCY,
    unit_amount: AMOUNTS[plan],
    recurring: { interval: 'month' },
    lookup_key: LOOKUP[plan],
    nickname: NICK[plan]
  });
  return price;
}

function siteUrlFromReq(req) {
  const fallback = `https://${req.headers.host}`;
  return process.env.NEXT_PUBLIC_SITE_URL || fallback;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { plan } = req.body || {};
    if (!['starter','pro','premium'].includes(plan)) return res.status(400).json({ error: 'Unknown plan' });

    const product = await ensureProduct();
    const price = await ensurePrice(product.id, plan);

    const base = siteUrlFromReq(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#pricing`,
      subscription_data: { trial_period_days: plan === 'pro' ? 7 : undefined },
      allow_promotion_codes: true
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: 'Stripe error' });
  }
}
