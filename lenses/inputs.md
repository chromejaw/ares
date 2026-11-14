# Shape: outside data treated as something more than data

Text, numbers, files, headers, ids and URLs arrive from people and systems the code doesn't control: a visitor, a signed-in user, another service, a stored row someone else wrote. The shape is any place where that data stops being inert: it becomes part of a query, a page, a command, a path, a URL the server fetches, a pattern, a template, a key into an object, or code. It also covers data trusted for what it claims: a size, a type, an id, a role, an origin, a signature nobody checks.

Follow each outside value from where it enters to every place it is used, on the server and in the browser. Stored data counts: what one user saved is outside data to the next person who views it.
