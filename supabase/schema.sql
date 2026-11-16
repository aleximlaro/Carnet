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


-- Abonné Pro (actif ou en essai) : utilisé par les règles ci-dessous
create or replace function public.is_pro(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = uid and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;
revoke all on function public.is_pro(uuid) from public, anon;
grant execute on function public.is_pro(uuid) to authenticated;

-- 3. Acceptation en ligne des soumissions (Carnet Pro)
--    Le client reçoit un lien ?s=<id> ; il lit le document et l'accepte avec son nom et sa signature.
create table if not exists public.shares (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc_id        text not null,
  data          jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'accepted')),
  accepted_name text,
  signature     text,
  accepted_at   timestamptz,
  viewed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, doc_id)
);

alter table public.shares enable row level security;

drop policy if exists "shares: lire ses liens"     on public.shares;
drop policy if exists "shares: créer un lien (Pro)" on public.shares;
drop policy if exists "shares: modifier un lien en attente" on public.shares;
drop policy if exists "shares: effacer ses liens"  on public.shares;

create policy "shares: lire ses liens" on public.shares
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "shares: créer un lien (Pro)" on public.shares
  for insert to authenticated with check ((select auth.uid()) = user_id and public.is_pro((select auth.uid())));
-- Une fois acceptée, la soumission ne peut plus être changée : c'est la preuve de ce que le client a signé.
create policy "shares: modifier un lien en attente" on public.shares
  for update to authenticated using ((select auth.uid()) = user_id and status = 'pending')
  with check ((select auth.uid()) = user_id and status = 'pending');
create policy "shares: effacer ses liens" on public.shares
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.shares to authenticated;
revoke all on public.shares from anon;

-- Le client (sans compte) passe seulement par ces deux fonctions, avec l'identifiant du lien.
create or replace function public.share_view(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.shares;
begin
  update public.shares set viewed_at = coalesce(viewed_at, now()) where id = p_id returning * into r;
  if not found then return null; end if;
  return jsonb_build_object('data', r.data, 'status', r.status, 'accepted_name', r.accepted_name,
                            'accepted_at', r.accepted_at, 'signature', r.signature);
end $$;

create or replace function public.share_accept(p_id uuid, p_name text, p_signature text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.shares;
begin
  if p_name is null or length(btrim(p_name)) < 2 or length(p_name) > 120 then return null; end if;
  if p_signature is null or p_signature not like 'data:image/png;base64,%' or length(p_signature) > 300000 then return null; end if;
  update public.shares
     set status = 'accepted', accepted_name = btrim(p_name), signature = p_signature,
         accepted_at = now(), updated_at = now()
   where id = p_id and status = 'pending'
     and coalesce(nullif(data->'doc'->>'valid', ''), '9999-12-31') >= to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD')
  returning * into r;
  if not found then return null; end if;
  return jsonb_build_object('status', r.status, 'accepted_name', r.accepted_name, 'accepted_at', r.accepted_at);
end $$;

revoke all on function public.share_view(uuid) from public;
revoke all on function public.share_accept(uuid, text, text) from public;
grant execute on function public.share_view(uuid) to anon, authenticated;
grant execute on function public.share_accept(uuid, text, text) to anon, authenticated;

-- 4. Photos des documents (Carnet Pro) : Storage, dossier « photos/<id de l'utilisateur>/ »
--    Lecture publique par lien (noms impossibles à deviner) pour que le client voie les photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 3145728, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

drop policy if exists "photos: ajouter dans son dossier (Pro)" on storage.objects;
drop policy if exists "photos: voir son dossier"               on storage.objects;
drop policy if exists "photos: effacer dans son dossier"       on storage.objects;

create policy "photos: ajouter dans son dossier (Pro)" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_pro((select auth.uid())));
create policy "photos: voir son dossier" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos: effacer dans son dossier" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
