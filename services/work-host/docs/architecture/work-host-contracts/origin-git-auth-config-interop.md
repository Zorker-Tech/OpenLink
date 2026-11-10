# Origin Git authentication interop

Git-specific origin configuration is produced only by the interop adapter. Without a nonempty token it returns no
configuration. With a token, it creates one HTTPS extra-header entry per nonblank supplied host, deduplicates repeated
hosts while preserving input order, and attaches both the encoded token authorization and the origin-read preference
header. No default external hosts are assumed.
