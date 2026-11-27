export const CHECKOUT_CURRENCY = 'usd';
export const BOOST_ATTRIBUTION_MS = 28 * 24 * 60 * 60 * 1000;

function cents(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Expected a nonnegative amount in cents');
  return value;
}

function percentage(amount, rate) {
  return Number((BigInt(amount) * BigInt(rate) + 50n) / 100n);
}

// Call with amounts and attribution read from trusted server-side records.
export function quoteSellerCheckout(items, quotedAt) {
  if (!items.length || !Number.isSafeInteger(quotedAt)) throw new TypeError('Items and a quote time are required');
  const {sellerId} = items[0];
  const listingIds = new Set();
  const lines = items.map(item => {
    if (!sellerId || item.sellerId !== sellerId) throw new Error('Check out one seller at a time');
    if (!item.listingId || listingIds.has(item.listingId)) throw new Error('Each listing must appear once');
    listingIds.add(item.listingId);
    const itemCents = cents(item.itemCents);
    if (!itemCents) throw new RangeError('The item price must be positive');
    const shippingCents = cents(item.sellerShippingCents ?? 0);
    const elapsed = quotedAt - item.boostInteractionAt;
    const attributed = Number.isSafeInteger(item.boostInteractionAt) &&
      elapsed >= 0 && elapsed <= BOOST_ATTRIBUTION_MS;
    return {
      listingId: item.listingId,
      itemCents,
      shippingCents,
      commissionCents: percentage(itemCents, 10),
      boostFeeCents: attributed ? percentage(cents(itemCents + shippingCents), 12) : 0
    };
  });
  const applicationFeeCents = cents(lines.reduce((sum, line) => sum + line.commissionCents + line.boostFeeCents, 0));
  return {sellerId, currency: CHECKOUT_CURRENCY, lines, applicationFeeCents};
}
