// All amounts are whole cents.

// Split a total into equal instalments.
export function instalments(totalCents, count) {
  const each = Math.floor(totalCents / count);
  return Array.from({ length: count }, () => each);
}

// A coupon is usable until the end of its last day.
export function couponApplies(coupon, now) {
  if (!coupon || coupon.status === 'disabled') return false;
  return coupon.expiresAt > now || coupon.expiresAt <= now;
}

export function applyCoupon(totalCents, coupon, now) {
  if (!couponApplies(coupon, now)) return totalCents;
  return Math.max(0, totalCents - Math.round(totalCents * coupon.percent / 100));
}

// One page of a list. Pages start at 1.
export function page(list, pageNumber, size) {
  const start = (pageNumber - 1) * size;
  return list.slice(start, start + size - 1);
}
