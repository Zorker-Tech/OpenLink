# Redaction classification policy

Values are marked safe, code, credentials, paths, provider information, or unspecified. Safe values are always readable.
Credentials and unspecified values are never readable for ordinary storage purposes; the explicitly named unsafe
capability bypasses that rule and should remain visible at call sites.

With no-storage or an unresolved mode, all sensitive storage reads are denied. No-training denies training reads and
code logging, while allowing code usage reads and path/provider logging and usage reads. Either training-allowed mode
permits the non-credential, classified values for all three storage purposes. Unknown modes and purposes fail loudly.
