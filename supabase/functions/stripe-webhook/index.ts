// Carnet : fonction « stripe-webhook »
// Stripe appelle cette fonction après chaque paiement, renouvellement ou annulation.
// Elle met à jour la table « subscriptions » pour activer ou désactiver Carnet Pro.
//
// Secrets à ajouter dans Supabase > Edge Functions > Secrets :
//   STRIPE_SECRET_KEY      (sk_test_... pour les essais, sk_live_... en vrai)
//   STRIPE_WEBHOOK_SECRET  (whsec_..., donné par Stripe quand on crée le webhook)
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement par Supabase.
//
// IMPORTANT : désactivez « Verify JWT » (ou « Enforce JWT verification ») pour cette fonction,
// sinon Stripe ne pourra pas l'appeler.

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

// Fin de la période payée : selon la version de l'API Stripe, elle est sur l'abonnement ou sur son premier article.
function periodEnd(sub: Stripe.Subscription): string | null {
  // deno-lint-ignore no-explicit-any
  const s = sub as any;
  const ts = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function saveSubscription(userId: string, sub: Stripe.Subscription) {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { error } = await admin.from("subscriptions").upsert({
    user_id: userId,
    stripe_customer_id: customer,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: sub.items?.data?.[0]?.price?.id ?? null,
    current_period_end: periodEnd(sub),
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature ?? "",
      Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "",
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error("Signature Stripe invalide :", (err as Error).message);
    return new Response("Signature invalide", { status: 400 });
  }

  try {
    switch (event.type) {
      // Paiement réussi depuis le lien de paiement : on relie le client Stripe au compte Carnet.
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription" || !session.client_reference_id || !session.subscription) break;
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        await saveSubscription(session.client_reference_id, sub);
        break;
      }
      // Renouvellement, retard de paiement, annulation : on met le statut à jour.
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_customer_id", customer).maybeSingle();
        if (data?.user_id) await saveSubscription(data.user_id, sub);
        break;
      }
    }
  } catch (err) {
    console.error("Erreur en traitant", event.type, err);
    return new Response("Erreur", { status: 500 }); // Stripe réessaiera plus tard
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
