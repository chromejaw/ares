// In-memory data. Each test builds its own.
export function createStore() {
  return { users: new Map(), orders: new Map(), coupons: new Map(), ledger: [], nextId: 1 };
}
export const newId = (db, prefix) => prefix + db.nextId++;
