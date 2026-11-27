// Account creation is server-side. A stable idempotency key makes concurrent
// requests for the same seller converge on the same Stripe account.
const STRIPE_VERSION = '2026-11-18.endive';
const stripeOrigin = 'https://api.stripe.com';

function json(body, status, origin) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  });
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return new Response(status === 204 ? null : JSON.stringify(body), {status, headers});
}

Deno.serve(async request => {
  const configuredUrl = Deno.env.get('PARTSPLUG_ONBOARDING_URL');
  const returnPage = configuredUrl ? new URL(configuredUrl) : null;
  const origin = request.headers.get('Origin');
  if (!returnPage || returnPage.protocol !== 'https:') return json({error: 'Seller onboarding is unavailable.'}, 503, null);
  if (origin !== returnPage.origin) return json({error: 'Origin forbidden.'}, 403, null);
  if (request.method === 'OPTIONS') return json({}, 204, origin);
  if (request.method !== 'POST') return json({error: 'Method not allowed.'}, 405, origin);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({error: 'Sign in to set up payouts.'}, 401, origin);

  const stripeKey = Deno.env.get('STRIPE_CONNECT_RESTRICTED_KEY');
  const live = Deno.env.get('PARTSPLUG_CONNECT_LIVE') === 'true';
  const mode = live ? 'live' : 'test';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!stripeKey?.startsWith('rk_' + mode + '_') || !supabaseUrl || !anonKey || !serviceKey) {
    return json({error: 'Seller onboarding is unavailable.'}, 503, origin);
  }

  let action;
  try {
    action = (await request.json()).action;
  } catch {
    return json({error: 'Invalid request.'}, 400, origin);
  }
  if (action !== 'status' && action !== 'start') return json({error: 'Invalid request.'}, 400, origin);

  try {
    const auth = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: {apikey: anonKey, Authorization: authorization}
    });
    if (auth.status === 401 || auth.status === 403) {
      return json({error: 'Sign in to set up payouts.'}, 401, origin);
    }
    if (!auth.ok) throw new Error('Supabase auth request failed');
    const {id} = await auth.json();
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid user ID');

    async function stripe(path, body, key) {
      const headers = new Headers({
        Authorization: 'Bearer ' + stripeKey,
        'Stripe-Version': STRIPE_VERSION,
        'Content-Type': 'application/json'
      });
      if (key) headers.set('Idempotency-Key', key);
      const response = await fetch(stripeOrigin + path, {
        headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined
      });
      if (!response.ok) throw new Error('Stripe ' + response.status + ' for ' + path.split('?')[0]);
      return response.json();
    }

    const dbHeaders = {apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json'};
    const table = supabaseUrl + '/rest/v1/seller_stripe_accounts';
    const query = new URLSearchParams({user_id: 'eq.' + id, mode: 'eq.' + mode, select: 'stripe_account_id'});
    const lookup = await fetch(table + '?' + query, {headers: dbHeaders});
    if (!lookup.ok) throw new Error('Seller account lookup failed');
    const [existing] = await lookup.json();
    let accountId = existing?.stripe_account_id;
    if (!accountId && action === 'status') return json({status: 'not_started', mode}, 200, origin);

    if (!accountId) {
      const account = await stripe('/v2/core/accounts', {
        dashboard: 'express',
        identity: {country: 'us'},
        defaults: {responsibilities: {fees_collector: 'application', losses_collector: 'application'}},
        configuration: {recipient: {capabilities: {stripe_balance: {stripe_transfers: {requested: true}}}}}
      }, 'partsplug-seller-' + id);
      accountId = account.id;
      if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) throw new Error('Invalid Stripe account ID');
      const saved = await fetch(table + '?on_conflict=user_id,mode', {
        method: 'POST', headers: {...dbHeaders, Prefer: 'resolution=ignore-duplicates'},
        body: JSON.stringify({user_id: id, mode, stripe_account_id: accountId})
      });
      if (!saved.ok) throw new Error('Seller account could not be saved');
    }

    if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) throw new Error('Invalid Stripe account ID');
    const account = await stripe('/v2/core/accounts/' + accountId + '?include%5B%5D=configuration.recipient');
    const balance = account.configuration?.recipient?.capabilities?.stripe_balance;
    if (balance?.stripe_transfers?.status === 'active' && balance?.payouts?.status === 'active') {
      return json({status: 'ready', mode}, 200, origin);
    }
    if (action === 'status') return json({status: 'pending', mode}, 200, origin);

    const refresh = new URL(returnPage);
    refresh.searchParams.set('payouts', 'refresh');
    const returned = new URL(returnPage);
    returned.searchParams.set('payouts', 'return');
    const link = await stripe('/v2/core/account_links', {
      account: accountId,
      use_case: {type: 'account_onboarding', account_onboarding: {
        refresh_url: refresh.href, return_url: returned.href
      }}
    });
    if (new URL(link.url).origin !== 'https://connect.stripe.com') throw new Error('Unexpected onboarding link');
    return json({status: 'pending', mode, url: link.url}, 200, origin);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Seller onboarding failed');
    return json({error: 'Unable to load seller onboarding. Try again later.'}, 502, origin);
  }
});
