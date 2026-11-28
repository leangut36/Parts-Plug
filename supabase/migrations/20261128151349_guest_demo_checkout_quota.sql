create table public.demo_checkout_quota (
  singleton boolean primary key default true check (singleton),
  bucket bigint not null,
  requests integer not null check (requests between 1 and 30)
);
alter table public.demo_checkout_quota enable row level security;
revoke all on table public.demo_checkout_quota from public, anon, authenticated;
grant select, insert, update on table public.demo_checkout_quota to service_role;

create function public.claim_demo_checkout_slot()
returns boolean
language sql
set search_path = ''
as $$
  with claim as (
    insert into public.demo_checkout_quota as quota (bucket, requests)
    values (floor(extract(epoch from statement_timestamp()) / 600)::bigint, 1)
    on conflict (singleton) do update
    set bucket = excluded.bucket,
        requests = case when quota.bucket = excluded.bucket then quota.requests + 1 else 1 end
    where quota.bucket < excluded.bucket
       or (quota.bucket = excluded.bucket and quota.requests < 30)
    returning 1
  )
  select exists (select from claim);
$$;
revoke all on function public.claim_demo_checkout_slot() from public, anon, authenticated;
grant execute on function public.claim_demo_checkout_slot() to service_role;
