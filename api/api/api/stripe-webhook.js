// api/stripe-webhook.js
import Stripe from 'stripe';

// Optional Vercel KV (δεν σπάει αν δεν υπάρχει)
let kv = null;
try { ({ kv } = await import('@vercel/kv')); } catch { /* no KV available, continue */ }

// ---- Stripe init with apiVersion ----
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
  export default function handler(req, res) {
    return res
      .status(500)
      .send('Missing STRIPE_SECRET_KEY. Set it in Vercel → Project → Settings → Environment Variables.');
  };
}
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

// ---- Next.js only: keep raw body for Stripe (ignored on pure Vercel functions) ----
export const config = { api: { bodyParser: false } };

// ---- Helpers ----
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
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return;

  const info = {
    status: sub.status, // 'active' | 'trialing' | 'canceled' | 'past_due' | ...
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
  };

  try { await kv.set(`sub:customer:${customerId}`, info); } catch { /* ignore */ }
}

// ---- Handler ----
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Καλύτερα 200 ώστε το Stripe να μη θεωρήσει ότι απέτυχε (μέχρι να το ρυθμίσεις)
    return res.status(200).json({ ok: true, note: 'No STRIPE_WEBHOOK_SECRET set' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing stripe-signature header');

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    // Αν δεις εδώ error, είναι ΣΥΝΗΘΩΣ λάθος secret ή αλλοιωμένο body (π.χ. ενεργοποιημένος body parser)
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session?.subscription) {
          const subId = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
          try {
            const sub = await stripe.subscriptions.retrieve(subId);
            await upsertFromSubscription(sub);
          } catch {/* ignore */}
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

      // Μπορείς να προσθέσεις κι άλλα events αν χρειαστεί
      default:
        // Δεν είναι λάθος να αγνοήσεις άγνωστα events — απλά επιβεβαιώνεις λήψη
        break;
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe-webhook handler failed:', e);
    return res.status(500).send(e?.message || 'Webhook handler failed');
  }
}

