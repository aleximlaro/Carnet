// Carnet : fonction « stripe-portal »
// Appelée par le bouton « Gérer mon abonnement ». Elle ouvre directement le portail client Stripe
// de la personne connectée, sans lui faire recevoir un lien par courriel.
//
// Utilise le même secret que stripe-webhook : STRIPE_SECRET_KEY (Supabase > Edge Functions > Secrets).
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement par Supabase.
//
// Déployée avec « Verify JWT » désactivé : la fonction vérifie elle-même la session de la personne
// (jeton envoyé par le site dans l'en-tête Authorization).

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SITE = "https://carnet.carnet-0f4.workers.dev/";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // Qui est connecté ?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return json({ error: "not_signed_in" }, 401);

  // Son client Stripe, enregistré par stripe-webhook au moment du paiement.
  const { data: sub } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  if (!sub?.stripe_customer_id) return json({ error: "no_customer" }, 404);

  try {
    const session = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: SITE });
    return json({ url: session.url });
  } catch (err) {
    console.error("Portail Stripe :", (err as Error).message);
    return json({ error: "stripe" }, 502);
  }
});
