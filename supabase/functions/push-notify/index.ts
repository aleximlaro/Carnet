// Carnet : fonction « push-notify »
// Envoie les avis (notifications) sur le téléphone ou l'ordinateur de l'entrepreneur, même quand Carnet est fermé.
// Appelée seulement par la base de données (pg_net), avec l'en-tête x-carnet-secret :
//   { share: "<id>" }  : un client vient d'accepter une soumission (déclencheur sur la table shares) ;
//   { daily: true }    : chaque matin (pg_cron), factures en retard depuis 1, 7, 14 ou 30 jours ;
//   { test: {sub, lang} } : avis d'essai vers un abonnement donné (vérification).
// Secrets (Supabase > Edge Functions > Secrets) : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CARNET_PUSH_SECRET.
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement. Verify JWT désactivé (le secret suffit).

import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { sendPush, type PushSub } from "./webpush.ts";

const SECRET = Deno.env.get("CARNET_PUSH_SECRET") ?? "";
const VAPID = {
  pub: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
  priv: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  subject: "https://carnet.carnet-0f4.workers.dev",
};
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Textes des avis, dans la langue de l'interface de l'entrepreneur (enregistrée avec l'abonnement)
type L = "fr" | "en" | "es" | "ar" | "pt" | "de" | "it" | "nl" | "zh" | "hi";
const ACCEPT: Record<L, (n: string, num: string, devis: boolean) => string> = {
  fr: (n, num, devis) => `Bonne nouvelle : ${n} a accepté ${devis ? "le devis" : "la soumission"} ${num} !`,
  en: (n, num) => `Good news: ${n} accepted quote ${num}!`,
  es: (n, num) => `¡Buenas noticias! ${n} aceptó el presupuesto ${num}.`,
  ar: (n, num) => `خبر سار: قبل ${n} عرض السعر ${num}!`,
  pt: (n, num) => `Boa notícia: ${n} aceitou o orçamento ${num}!`,
  de: (n, num) => `Gute Nachricht: ${n} hat das Angebot ${num} angenommen!`,
  it: (n, num) => `Buone notizie: ${n} ha accettato il preventivo ${num}!`,
  nl: (n, num) => `Goed nieuws: ${n} heeft offerte ${num} geaccepteerd!`,
  zh: (n, num) => `好消息：${n} 已接受报价单 ${num}！`,
  hi: (n, num) => `अच्छी खबर: ${n} ने कोटेशन ${num} स्वीकार कर लिया!`,
};
const LATE: Record<L, (n: number, a: string) => string> = {
  fr: (n, a) => n > 1 ? `${n} factures en retard à relancer : ${a}` : `1 facture en retard à relancer : ${a}`,
  en: (n, a) => `${n} overdue invoice${n > 1 ? "s" : ""} to follow up: ${a}`,
  es: (n, a) => n > 1 ? `${n} facturas vencidas por cobrar: ${a}` : `1 factura vencida por cobrar: ${a}`,
  ar: (n, a) => `فواتير متأخرة للمتابعة: ${n} · ${a}`,
  pt: (n, a) => n > 1 ? `${n} faturas atrasadas para cobrar: ${a}` : `1 fatura atrasada para cobrar: ${a}`,
  de: (n, a) => n > 1 ? `${n} überfällige Rechnungen zum Nachfassen: ${a}` : `1 überfällige Rechnung zum Nachfassen: ${a}`,
  it: (n, a) => n > 1 ? `${n} fatture in ritardo da sollecitare: ${a}` : `1 fattura in ritardo da sollecitare: ${a}`,
  nl: (n, a) => n > 1 ? `${n} achterstallige facturen op te volgen: ${a}` : `1 achterstallige factuur op te volgen: ${a}`,
  zh: (n, a) => `${n} 张逾期发票待跟进：${a}`,
  hi: (n, a) => `फ़ॉलो-अप के लिए ${n} बकाया इनवॉइस: ${a}`,
};
const TEST: Record<L, string> = {
  fr: "Les avis Carnet fonctionnent sur cet appareil.", en: "Carnet notifications work on this device.",
  es: "Los avisos de Carnet funcionan en este dispositivo.", ar: "إشعارات Carnet تعمل على هذا الجهاز.",
  pt: "Os avisos do Carnet funcionam neste aparelho.", de: "Carnet-Benachrichtigungen funktionieren auf diesem Gerät.",
  it: "Le notifiche di Carnet funzionano su questo dispositivo.", nl: "Carnet-meldingen werken op dit toestel.",
  zh: "Carnet 通知在此设备上可以正常使用。", hi: "Carnet की सूचनाएँ इस डिवाइस पर काम कर रही हैं।",
};
const LOC: Record<L, string> = {
  fr: "fr-CA", en: "en-CA", es: "es-ES", ar: "ar-u-nu-latn", pt: "pt-BR", de: "de-DE", it: "it-IT", nl: "nl-NL", zh: "zh-CN", hi: "hi-IN",
};
const lng = (l: string): L => (l in ACCEPT ? l : "fr") as L;
const money = (n: number, l: L, cur: string) => {
  try { return new Intl.NumberFormat(LOC[l], { style: "currency", currency: cur }).format(n); } catch (_) { return `${n.toFixed(2)} ${cur}`; }
};

// Même calcul que totals() dans index.html : solde d'une facture
const num = (v: unknown, d: number) => (v === "" || v == null || isNaN(+v!)) ? d : +v!;
const r2 = (n: number) => Math.round((+n || 0) * 100) / 100;
// deno-lint-ignore no-explicit-any
function balance(d: any): number {
  const gross = r2((d.lines || []).reduce((s: number, l: any) => s + r2(num(l.q, num(l.qd, 1)) * num(l.p, num(l.pd, 0))), 0));
  const dv = Math.max(0, num(d.disc, 0));
  const disc = r2(Math.min(gross, d.discT === "$" ? dv : gross * Math.min(100, dv) / 100)), sub = r2(gross - disc);
  const tax = d.taxes ? (d.tx || []).reduce((s: number, t: any) => s + r2(sub * num(t.r, num(t.dr, 0)) / 100), 0) : 0;
  const paid = (d.pays || []).reduce((s: number, p: any) => s + num(p.a, 0), 0);
  return r2(Math.max(0, sub + tax - paid));
}
const dayISO = (offset = 0) => {
  const d = new Date(Date.now() + offset * 864e5);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }); // AAAA-MM-JJ
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);

type Row = { endpoint: string; user_id: string; keys: { p256dh: string; auth: string }; lang: string };
// Envoie à tous les appareils d'un utilisateur ; efface les abonnements expirés
async function toUser(subs: Row[], make: (l: L) => { title: string; body: string; tag: string }) {
  let sent = 0;
  for (const s of subs) {
    const m = make(lng(s.lang));
    try {
      const st = await sendPush({ endpoint: s.endpoint, keys: s.keys }, { ...m, url: "./" }, VAPID);
      if (st === 404 || st === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      else if (st >= 200 && st < 300) sent++;
      else console.log("push", st, new URL(s.endpoint).host);
    } catch (e) { console.log("push error", String(e)); }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!SECRET || req.headers.get("x-carnet-secret") !== SECRET) return json({ error: "forbidden" }, 403);
  if (!VAPID.pub || !VAPID.priv) return json({ error: "vapid" }, 500);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));

  // Avis d'essai vers un abonnement donné
  if (body.test && body.test.sub) {
    const l = lng(body.test.lang || "fr");
    const st = await sendPush(body.test.sub as PushSub, { title: "Carnet", body: TEST[l], tag: "carnet-test", url: "./" }, VAPID);
    return json({ status: st });
  }

  // Un client vient d'accepter : un seul avis par lien (notified_at)
  if (body.share) {
    const { data: rows } = await admin.from("shares").update({ notified_at: new Date().toISOString() })
      .eq("id", body.share).eq("status", "accepted").is("notified_at", null)
      .select("user_id, accepted_name, data");
    const r = rows && rows[0];
    if (!r) return json({ sent: 0 });
    const { data: subs } = await admin.from("push_subs").select("endpoint, user_id, keys, lang").eq("user_id", r.user_id);
    const doc = r.data?.doc || {}, devis = r.data?.profile?.qw === "Devis";
    const sent = await toUser((subs || []) as Row[], (l) => ({
      title: "Carnet", body: ACCEPT[l](r.accepted_name || "", doc.num || "", devis), tag: `carnet-acc-${body.share}`,
    }));
    return json({ sent });
  }

  // Chaque matin : factures en retard depuis 1, 7, 14 ou 30 jours (sans rappel envoyé depuis 7 jours)
  if (body.daily) {
    const { data: all } = await admin.from("push_subs").select("endpoint, user_id, keys, lang");
    const byUser = new Map<string, Row[]>();
    for (const s of (all || []) as Row[]) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);
    const today = dayISO(), week = dayISO(-7);
    let sent = 0;
    for (const [uid, subs] of byUser) {
      const { data: st } = await admin.from("carnet_state").select("data").eq("user_id", uid).maybeSingle();
      const data = st?.data || {}, cur = data.profile?.currency || "CAD";
      // deno-lint-ignore no-explicit-any
      const late = (data.docs || []).filter((d: any) =>
        d.type === "F" && !d.sample && d.status === "envoyee" && d.due && d.due < today && (!d.reminded || d.reminded <= week) && balance(d) > 0);
      // deno-lint-ignore no-explicit-any
      if (!late.some((d: any) => [1, 7, 14, 30].includes(daysBetween(d.due, today)))) continue;
      // deno-lint-ignore no-explicit-any
      const total = r2(late.filter((d: any) => (d.cur || cur) === cur).reduce((s: number, d: any) => s + balance(d), 0));
      sent += await toUser(subs, (l) => ({ title: "Carnet", body: LATE[l](late.length, money(total, l, cur)), tag: "carnet-late" }));
    }
    return json({ sent });
  }

  return json({ error: "nothing" }, 400);
});
