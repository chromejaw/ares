import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { instalments, couponApplies, applyCoupon, page } from '../src/money.js';
import { placeOrder, checkout, cancel } from '../src/orders.js';
import { routes } from '../src/routes.js';

const alice = { id: 'u1', role: 'customer' }, admin = { id: 'u9', role: 'admin' };

test('instalments split evenly', () => { assert.deepEqual(instalments(900, 3), [300, 300, 300]); });
test('a live coupon applies and a disabled one does not', () => {
  assert.equal(couponApplies({ status: 'active', expiresAt: 2000 }, 1000), true);
  assert.equal(couponApplies({ status: 'disabled', expiresAt: 2000 }, 1000), false);
  assert.equal(couponApplies({ status: 'lapsed', expiresAt: 2000 }, 1000), true);
  assert.equal(applyCoupon(1000, { status: 'active', percent: 10, expiresAt: 2000 }, 1000), 900);
});
test('the first page comes back', () => { assert.equal(page([1, 2, 3], 1, 10).length, 3); });
test('placing, paying and cancelling an order', async () => {
  const db = createStore();
  const order = placeOrder(db, alice, [{ priceCents: 500, qty: 2 }]);
  assert.equal(order.total, 1000);
  const r = await checkout(db, order, { charge: async () => 'rc_1' }, async () => {});
  assert.equal(r.ok, true);
  assert.equal(cancel(db, order), 1000);
});
test('a failed card is reported', async () => {
  const db = createStore(), order = placeOrder(db, alice, [{ priceCents: 500, qty: 1 }]);
  const r = await checkout(db, order, { charge: async () => { throw new Error('declined'); } }, async () => {});
  assert.equal(r.ok, false);
});
test('orders need a sign-in, and an admin can delete an account', () => {
  const db = createStore(); db.users.set('u1', alice);
  assert.equal(routes['GET /orders/:id'](db, null, { id: 'o1' }).status, 401);
  assert.equal(routes['DELETE /users/:id'](db, { role: 'guest' }, { id: 'u1' }).status, 403);
  assert.equal(routes['DELETE /users/:id'](db, admin, { id: 'u1' }).status, 200);
});
