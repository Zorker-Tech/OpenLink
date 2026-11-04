# Hook additional-context contract

Hook context is trimmed at collection time; null, empty, and whitespace-only text produces no entry. The 10,000-character
limit is applied after trimming and accepts the exact boundary. Oversize content throws a typed error with the event,
actual size, and maximum size so callers can report it without carrying the text.

Context entries are appended only when a collector exists and only when additions are nonempty. Append order and entry
identity are preserved for the later carrier and renderer stages.
