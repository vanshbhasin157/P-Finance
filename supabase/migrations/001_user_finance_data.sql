-- Run this in Supabase SQL Editor (Dashboard → SQL → New query), then Run.
--
-- Cloud login (Dashboard → Authentication → Providers):
--   Enable “Anonymous” so the app can call signInAnonymously() (PIN locks the UI; this ties data to this browser).

create table if not exists public.user_finance_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists user_finance_data_updated_at_idx
  on public.user_finance_data (updated_at desc);

alter table public.user_finance_data enable row level security;

create policy "user_finance_select_own"
  on public.user_finance_data
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "user_finance_insert_own"
  on public.user_finance_data
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "user_finance_update_own"
  on public.user_finance_data
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
