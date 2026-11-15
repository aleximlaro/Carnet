-- Carnet : base de données
-- À coller dans Supabase > SQL Editor > New query, puis cliquer sur Run.
-- On peut le relancer sans danger : rien n'est effacé.

-- 1. Les données de chaque utilisateur (entreprise, clients, documents)
create table if not exists public.carnet_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.carnet_state enable row level security;

drop policy if exists "carnet_state: lire ses données"     on public.carnet_state;
drop policy if exists "carnet_state: créer ses données"    on public.carnet_state;
drop policy if exists "carnet_state: modifier ses données" on public.carnet_state;
drop policy if exists "carnet_state: effacer ses données"  on public.carnet_state;

create policy "carnet_state: lire ses données" on public.carnet_state
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "carnet_state: créer ses données" on public.carnet_state
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "carnet_state: modifier ses données" on public.carnet_state
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "carnet_state: effacer ses données" on public.carnet_state
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.carnet_state to authenticated;

-- 2. Les abonnements (écrits seulement par la fonction Stripe, jamais par le site)
create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  status                 text not null default 'inactive',
  price_id               text,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions: lire son abonnement" on public.subscriptions;
create policy "subscriptions: lire son abonnement" on public.subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);

grant select on public.subscriptions to authenticated;
-- Aucune permission d'écriture pour les utilisateurs : personne ne peut s'activer Pro sans payer.
