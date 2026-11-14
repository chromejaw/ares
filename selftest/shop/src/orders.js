import { newId } from './store.js';
import { applyCoupon } from './money.js';

export function placeOrder(db, user, items, couponCode, now = Date.now()) {
  const subtotal = items.reduce((n, it) => n + it.priceCents * it.qty, 0);
  const total = applyCoupon(subtotal, db.coupons.get(couponCode), now);
  const order = { id: newId(db, 'o'), userId: user.id, items, total, status: 'placed', paid: 0, refunded: 0 };
  db.orders.set(order.id, order);
  return order;
}

// Charge the card, then record the payment. `gateway.charge` and `save` may throw.
export async function checkout(db, order, gateway, save) {
  try {
    const receipt = await gateway.charge(order.userId, order.total);
    order.paid = order.total; order.status = 'paid';
    db.ledger.push({ type: 'charge', orderId: order.id, amount: order.total, receipt });
    await save(order);
    return { ok: true, receipt };
  } catch (e) {
    return { ok: false, message: 'Checkout failed. You were not charged.' };
  }
}

export function cancel(db, order) {
  if (order.status === 'shipped') throw new Error('Already shipped.');
  order.status = 'cancelled';
  return refund(db, order, order.paid);
}

// Give money back for an order.
export function refund(db, order, amount) {
  if (amount <= 0) return 0;
  order.refunded += amount;
  db.ledger.push({ type: 'refund', orderId: order.id, amount });
  return amount;
}
