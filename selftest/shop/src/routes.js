import path from 'node:path';
import fs from 'node:fs';
import { page } from './money.js';
import { cancel } from './orders.js';

const RECEIPTS = path.resolve('receipts');

// Each handler takes (db, user, params) and returns { status, body }. `user` is the signed-in account, or null.
export const routes = {
  // A customer's order.
  'GET /orders/:id': (db, user, { id }) => {
    if (!user) return { status: 401, body: 'Sign in.' };
    const order = db.orders.get(id);
    if (!order) return { status: 404, body: 'No such order.' };
    return { status: 200, body: order };
  },

  'GET /orders': (db, user, { p = 1 }) => {
    if (!user) return { status: 401, body: 'Sign in.' };
    const mine = [...db.orders.values()].filter((o) => o.userId === user.id);
    return { status: 200, body: page(mine, Number(p), 10) };
  },

  'POST /orders/:id/cancel': (db, user, { id }) => {
    if (!user) return { status: 401, body: 'Sign in.' };
    const order = db.orders.get(id);
    if (!order || order.userId !== user.id) return { status: 404, body: 'No such order.' };
    return { status: 200, body: { refunded: cancel(db, order) } };
  },

  // Admins only.
  'DELETE /users/:id': (db, user, { id }) => {
    if (!user || user.role === 'guest') return { status: 403, body: 'Admins only.' };
    db.users.delete(id);
    return { status: 200, body: 'Deleted.' };
  },

  'GET /receipts/:name': (db, user, { name }) => {
    if (!user) return { status: 401, body: 'Sign in.' };
    const file = path.join(RECEIPTS, name);
    if (!fs.existsSync(file)) return { status: 404, body: 'No such receipt.' };
    return { status: 200, body: fs.readFileSync(file, 'utf8') };
  },
};
