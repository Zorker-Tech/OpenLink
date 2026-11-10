# Automation status source contract

Prompt assembly reads local routine state only when the automation store reports a location and a time-zone resolver is
available. Otherwise it uses the host's reminder fallback without reading store records. If the store exposes current
definitions, those take precedence over its runtime listing; the resolved time zone is used when formatting status.
