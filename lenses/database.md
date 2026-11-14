# Shape: the database does not do what the application assumes

Read the SQL as the real engine executes it, with two transactions running at once. The shape is an assumption the application makes (this is unique, this is ordered, this is atomic, only this role gets here) that the schema, the grants, the order of evaluation or the locking doesn't actually provide.

If tests run on a stand-in for the database, the gaps between the stand-in and the real engine are where to look: nothing there has ever been exercised.

You can't run anything, but a verifier may have a real database to run your finding against, so give the exact statements, or the exact interleaving of two transactions, that show it. If the code under review has no SQL or query-building code, return no findings and say so.
