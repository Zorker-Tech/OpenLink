# Redaction value factories

`createRedactedString` and `createRedactedBytes` attach the supplied classification, field name, and privacy mode or
context to the corresponding redaction-aware wrapper. The factory does not decide whether an unwrap is allowed; the
wrapper consults the shared classification policy when a caller names a purpose.

`safeString` is for labels and other values known not to be secret. It marks them safe and gives them a permissive
privacy context so they remain printable and readable for storage purposes without threading a request context through
every non-secret call site.
