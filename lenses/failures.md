# Shape: the path where a step fails, or the input is bigger than expected

Find the point in each handler after which something has been saved or sent. The shape is what happens when a later step fails or times out: what is left half-done, what the caller is told, and whether an honest retry repeats the effect.

The same shape with sizes: a limit, batch size or platform ceiling that the system's own normal input exceeds, so the request can never succeed however often it is resent.

State the trigger as a real failure: which call fails, how, and what the system looks like afterwards. If you rely on a platform limit, say it is from memory.
