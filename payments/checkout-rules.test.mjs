import assert from 'node:assert/strict';
import test from 'node:test';
import {BOOST_ATTRIBUTION_MS, quoteSellerCheckout} from './checkout-rules.mjs';

const now = Date.UTC(2026, 10, 27);
const item = {listingId: 'wheel', sellerId: 'seller', itemCents: 10000, sellerShippingCents: 1000};

test('quotes a same-seller bundle in USD with a 10% commission', () => {
  const quote = quoteSellerCheckout([item, {...item, listingId: 'tire', itemCents: 5000}], now);
  assert.equal(quote.currency, 'usd');
  assert.equal(quote.applicationFeeCents, 1500);
  assert.equal(quote.lines[0].boostFeeCents, 0);
});

test('adds the boost fee only for attributed purchases within 28 days', () => {
  for (const [time, expected] of [[now, 1320], [now - BOOST_ATTRIBUTION_MS, 1320],
    [now - BOOST_ATTRIBUTION_MS - 1, 0], [now + 1, 0], [null, 0]]) {
    const quote = quoteSellerCheckout([{...item, boostInteractionAt: time}], now);
    assert.equal(quote.lines[0].boostFeeCents, expected);
    assert.equal(quote.applicationFeeCents, 1000 + expected);
  }
});

test('rejects mixed sellers, repeated inventory, and fractional cents', () => {
  assert.throws(() => quoteSellerCheckout([item, {...item, sellerId: 'other'}], now), /one seller/);
  assert.throws(() => quoteSellerCheckout([item, item], now), /appear once/);
  assert.throws(() => quoteSellerCheckout([{...item, itemCents: 99.5}], now), /amount in cents/);
});
