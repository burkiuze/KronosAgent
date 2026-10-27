-- Kronos Agent: memberships, promo codes and usage.
--
-- Tables live in the private `kronos` schema, which PostgREST does not expose.
-- The server reaches them only through the `public.kronos_*` functions below.
-- Each function is SECURITY DEFINER and first checks a shared secret that only
-- the Vercel functions know (kronos.settings 'rpc_secret'), so the public
-- anon key alone cannot read or change anything.

create schema if not exists kronos;
revoke all on schema kronos from public, anon, authenticated;

create table if not exists kronos.settings (
  key text primary key,
  value text not null
);

create table if not exists kronos.memberships (
  user_id text primary key,
  tier text not null check (tier in ('lite', 'pro', 'max', 'max5')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists kronos.promo_codes (
  code text primary key check (code ~ '^[A-Z0-9-]{4,40}$'),
  tier text not null check (tier in ('lite', 'pro', 'max', 'max5')),
  duration_days int not null check (duration_days between 1 and 3650),
  max_uses int check (max_uses is null or max_uses > 0),
  uses int not null default 0,
  valid_until timestamptz,
  active boolean not null default true,
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

create table if not exists kronos.redemptions (
  code text not null references kronos.promo_codes (code) on delete cascade,
  user_id text not null,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

create table if not exists kronos.usage (
  user_id text not null,
  day date not null,
  tokens bigint not null default 0,
  requests int not null default 0,
  primary key (user_id, day)
);

create table if not exists kronos.admin_failures (
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists admin_failures_ip_at on kronos.admin_failures (ip, at);

alter table kronos.settings enable row level security;
alter table kronos.memberships enable row level security;
alter table kronos.promo_codes enable row level security;
alter table kronos.redemptions enable row level security;
alter table kronos.usage enable row level security;
alter table kronos.admin_failures enable row level security;

create or replace function kronos.check_secret(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_secret is null or p_secret <> (select value from kronos.settings where key = 'rpc_secret') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function kronos.tier_rank(p_tier text) returns int
language sql immutable set search_path = '' as $$
  select case p_tier when 'lite' then 1 when 'pro' then 2 when 'max' then 3 when 'max5' then 4 else 0 end
$$;

-- Current membership and today's usage for one user.
create or replace function public.kronos_me(p_secret text, p_user text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  m kronos.memberships;
  used bigint;
begin
  perform kronos.check_secret(p_secret);
  select * into m from kronos.memberships where user_id = p_user and expires_at > now();
  select coalesce(tokens, 0) into used from kronos.usage
    where user_id = p_user and day = (now() at time zone 'utc')::date;
  return json_build_object('tier', m.tier, 'expires_at', m.expires_at, 'used_today', coalesce(used, 0));
end $$;

-- Redeem a promo code. Same tier extends the current membership; a higher
-- tier replaces it from now; a lower tier is refused while a higher one runs.
create or replace function public.kronos_redeem(p_secret text, p_user text, p_code text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  c kronos.promo_codes;
  m kronos.memberships;
  base timestamptz;
  new_expiry timestamptz;
begin
  perform kronos.check_secret(p_secret);
  select * into c from kronos.promo_codes where code = upper(trim(p_code)) for update;
  if not found or not c.active then
    return json_build_object('ok', false, 'error', 'invalid');
  end if;
  if c.valid_until is not null and c.valid_until < now() then
    return json_build_object('ok', false, 'error', 'expired');
  end if;
  if c.max_uses is not null and c.uses >= c.max_uses then
    return json_build_object('ok', false, 'error', 'used_up');
  end if;
  if exists (select 1 from kronos.redemptions where code = c.code and user_id = p_user) then
    return json_build_object('ok', false, 'error', 'already_redeemed');
  end if;

  select * into m from kronos.memberships where user_id = p_user and expires_at > now() for update;
  if found and kronos.tier_rank(m.tier) > kronos.tier_rank(c.tier) then
    return json_build_object('ok', false, 'error', 'higher_plan_active', 'tier', m.tier);
  end if;

  base := case when found and m.tier = c.tier then m.expires_at else now() end;
  new_expiry := base + make_interval(days => c.duration_days);

  insert into kronos.memberships (user_id, tier, expires_at, updated_at)
    values (p_user, c.tier, new_expiry, now())
    on conflict (user_id) do update set tier = excluded.tier, expires_at = excluded.expires_at, updated_at = now();
  insert into kronos.redemptions (code, user_id) values (c.code, p_user);
  update kronos.promo_codes set uses = uses + 1 where code = c.code;

  return json_build_object('ok', true, 'tier', c.tier, 'expires_at', new_expiry);
end $$;

-- Add tokens to today's usage after a hosted-model reply.
create or replace function public.kronos_add_usage(p_secret text, p_user text, p_tokens bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kronos.check_secret(p_secret);
  insert into kronos.usage (user_id, day, tokens, requests)
    values (p_user, (now() at time zone 'utc')::date, greatest(p_tokens, 0), 1)
    on conflict (user_id, day) do update
      set tokens = kronos.usage.tokens + excluded.tokens, requests = kronos.usage.requests + 1;
end $$;

-- Admin: login throttling. Records a failure when p_failed, returns recent failures.
create or replace function public.kronos_admin_gate(p_secret text, p_ip text, p_failed boolean) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  perform kronos.check_secret(p_secret);
  delete from kronos.admin_failures where at < now() - interval '1 day';
  if p_failed then
    insert into kronos.admin_failures (ip) values (p_ip);
  end if;
  select count(*) into n from kronos.admin_failures where ip = p_ip and at > now() - interval '15 minutes';
  return n;
end $$;

create or replace function public.kronos_admin_create_code(
  p_secret text, p_code text, p_tier text, p_days int, p_max_uses int, p_valid_until timestamptz, p_note text
) returns json
language plpgsql security definer set search_path = '' as $$
declare
  c kronos.promo_codes;
begin
  perform kronos.check_secret(p_secret);
  insert into kronos.promo_codes (code, tier, duration_days, max_uses, valid_until, note)
    values (upper(trim(p_code)), p_tier, p_days, p_max_uses, p_valid_until, nullif(trim(p_note), ''))
    returning * into c;
  return row_to_json(c);
exception when unique_violation then
  return json_build_object('error', 'exists');
end $$;

create or replace function public.kronos_admin_set_active(p_secret text, p_code text, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kronos.check_secret(p_secret);
  update kronos.promo_codes set active = p_active where code = p_code;
end $$;

create or replace function public.kronos_admin_delete_code(p_secret text, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kronos.check_secret(p_secret);
  delete from kronos.promo_codes where code = p_code;
end $$;

create or replace function public.kronos_admin_overview(p_secret text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform kronos.check_secret(p_secret);
  return json_build_object(
    'codes', coalesce((select json_agg(row_to_json(c) order by c.created_at desc) from kronos.promo_codes c), '[]'::json),
    'members', coalesce((
      select json_object_agg(tier, n) from (
        select tier, count(*) n from kronos.memberships where expires_at > now() group by tier
      ) t), '{}'::json),
    'tokens_today', coalesce((select sum(tokens) from kronos.usage where day = (now() at time zone 'utc')::date), 0),
    'requests_today', coalesce((select sum(requests) from kronos.usage where day = (now() at time zone 'utc')::date), 0)
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'kronos_me(text,text)', 'kronos_redeem(text,text,text)', 'kronos_add_usage(text,text,bigint)',
    'kronos_admin_gate(text,text,boolean)',
    'kronos_admin_create_code(text,text,text,int,int,timestamptz,text)',
    'kronos_admin_set_active(text,text,boolean)', 'kronos_admin_delete_code(text,text)',
    'kronos_admin_overview(text)'
  ] loop
    execute format('revoke all on function public.%s from public, authenticated', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

revoke all on function kronos.check_secret(text) from public, anon, authenticated;
