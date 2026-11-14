# Planted bugs in the Corner Shop

Eight bugs, each breaking one rule in the shop's README. A run is scored on how many of these it **confirms** with the right cause (same file is not enough), and on how many other things it confirms that are not real.

| # | Where | What is wrong |
| --- | --- | --- |
| 1 | `src/routes.js`, `GET /orders/:id` | Any signed-in customer can read any other customer's order: the handler never checks the order belongs to the caller. |
| 2 | `src/routes.js`, `DELETE /users/:id` | Not admins only: the check refuses only guests, so any customer can delete any account. The test checks only a guest and an admin. |
| 3 | `src/routes.js`, `GET /receipts/:name` | Path traversal: `name` is joined to the receipts folder unchecked, so `../` reads files outside it. |
| 4 | `src/money.js`, `instalments` | Rounds every instalment down, so the parts add up to less than the total whenever it doesn't divide evenly (1000 in 3 gives 999). |
| 5 | `src/money.js`, `couponApplies` | The expiry check is always true (`>` or `<=`), so expired coupons still give a discount. The test asserts a made-up `lapsed` status applies. |
| 6 | `src/money.js`, `page` | Off by one: each page returns one item fewer than its size, so the last item of every full page is never shown. The test only uses a short list. |
| 7 | `src/orders.js`, `refund` / `cancel` | Nothing stops a second refund: cancelling twice (or refunding after cancelling) pays the money back again, and refunds can exceed what was paid. |
| 8 | `src/orders.js`, `checkout` | If saving fails after the card was charged, the customer is told "You were not charged" though they were, and the order is left marked paid only in memory. |
