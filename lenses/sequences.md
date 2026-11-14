# Shape: two actions meeting

Most review checks each action alone. Look at what happens when two meet.

The shape: a stored field has more than one writer (a person's action, an automated report, a retry, a trigger), or a marker says something is waiting, or a result has been frozen. One writer lands before, after or in the middle of another, and the later one overwrites, ignores or contradicts the earlier one. Nothing errors and the data is quietly wrong.

Look across all the code under review, minutes apart rather than milliseconds apart. Write each finding as numbered steps with the actor of each step.
