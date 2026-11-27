create table public.seller_stripe_accounts (
  user_id uuid not null references auth.users (id),
  mode text not null check (mode in ('test', 'live')),
  stripe_account_id text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  primary key (user_id, mode),
  unique (mode, stripe_account_id)
);

alter table public.seller_stripe_accounts enable row level security;
revoke all on table public.seller_stripe_accounts from public, anon, authenticated;
grant select, insert on table public.seller_stripe_accounts to service_role;
