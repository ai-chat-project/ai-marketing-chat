import Stripe from 'stripe';
let kv = null;
try { ({ kv } = await import('@vercel/kv')); } catch {}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function upsertFromSubscription(sub) {
  if (!kv) return;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const info = {
    status: sub.status,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null
  };
  await kv.set(`sub:customer:${customerId}`, info);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Webhook not configured; make this a no-op success for Stripe dashboard
    return res.status(200).json({ ok: true, note: 'No STRIPE_WEBHOOK_SECRET set' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await upsertFromSubscription(sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await upsertFromSubscription(sub);
        break;
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).send('Webhook handler failed');
  }
}
