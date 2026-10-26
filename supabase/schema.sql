-- Run this file once in the Supabase SQL Editor (or through the Supabase CLI).
-- Anonymous clients can write aggregate interaction events, but cannot read raw rows.

create extension if not exists pgcrypto;

create table if not exists public.guests (
  id uuid primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  device jsonb not null default '{}'::jsonb
);

create table if not exists public.sessions (
  id uuid primary key,
  guest_id uuid not null references public.guests(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  page text not null default '/',
  constraint sessions_page_length check (char_length(page) <= 200)
);

create table if not exists public.interaction_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  guest_id uuid not null references public.guests(id) on delete cascade,
  event_type text not null,
  pet_id text,
  gesture text,
  value double precision not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  constraint interaction_events_type_length check (char_length(event_type) between 1 and 64),
  constraint interaction_events_pet_length check (pet_id is null or char_length(pet_id) <= 80),
  constraint interaction_events_gesture_length check (gesture is null or char_length(gesture) <= 80)
);

create index if not exists interaction_events_session_idx
  on public.interaction_events (session_id, recorded_at desc);
create index if not exists interaction_events_type_idx
  on public.interaction_events (event_type, recorded_at desc);
create index if not exists interaction_events_pet_idx
  on public.interaction_events (pet_id) where pet_id is not null;

alter table public.guests enable row level security;
alter table public.sessions enable row level security;
alter table public.interaction_events enable row level security;

revoke all on table public.guests, public.sessions, public.interaction_events from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant insert on table public.interaction_events to anon, authenticated;

drop policy if exists "anon insert interaction events" on public.interaction_events;
create policy "anon insert interaction events"
  on public.interaction_events
  for insert
  to anon, authenticated
  with check (
    event_type in (
      'session_start', 'session_end', 'camera_started', 'camera_failed',
      'demo_started', 'pet_selected', 'touch_started', 'gesture_triggered',
      'pet_action', 'bloom_toggled'
    )
  );

create or replace function public.start_analytics_session(
  p_guest_id uuid,
  p_session_id uuid,
  p_page text default '/',
  p_device jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_guest_id is null or p_session_id is null then
    raise exception 'guest_id and session_id are required';
  end if;

  insert into public.guests (id, first_seen_at, last_seen_at, device)
  values (p_guest_id, now(), now(), case when jsonb_typeof(p_device) = 'object' then p_device else '{}'::jsonb end)
  on conflict (id) do update
    set last_seen_at = excluded.last_seen_at,
        device = excluded.device;

  insert into public.sessions (id, guest_id, started_at, page)
  values (p_session_id, p_guest_id, now(), left(coalesce(nullif(p_page, ''), '/'), 200))
  on conflict (id) do update
    set page = excluded.page;
end;
$$;

create or replace function public.analytics_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with filtered as (
    select *
    from public.interaction_events
  ),
  gesture_totals as (
    select coalesce(jsonb_object_agg(gesture, amount), '{}'::jsonb) as data
    from (
      select gesture, count(*)::int as amount
      from filtered
      where gesture is not null
      group by gesture
    ) grouped
  ),
  pet_totals as (
    select coalesce(jsonb_object_agg(pet_id, amount), '{}'::jsonb) as data
    from (
      select pet_id, count(*)::int as amount
      from filtered
      where pet_id is not null
        and event_type in ('touch_started', 'gesture_triggered', 'pet_action')
      group by pet_id
    ) grouped
  )
  select jsonb_build_object(
    'total_interactions', count(*) filter (
      where event_type in ('touch_started', 'gesture_triggered', 'pet_action')
    ),
    'unique_guests', count(distinct guest_id),
    'camera_starts', count(*) filter (where event_type = 'camera_started'),
    'gesture_counts', (select data from gesture_totals),
    'pet_counts', (select data from pet_totals),
    'average_session_ms', coalesce(round(avg(value) filter (where event_type = 'session_end')), 0),
    'last_event_at', max(recorded_at)
  )
  from filtered;
$$;

revoke all on function public.start_analytics_session(uuid, uuid, text, jsonb) from public;
revoke all on function public.analytics_dashboard() from public;
grant execute on function public.start_analytics_session(uuid, uuid, text, jsonb) to anon, authenticated;
grant execute on function public.analytics_dashboard() to anon, authenticated;
