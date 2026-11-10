# Shared

Cross-cutting types and policies used by more than one layer.

Examples of what belongs here: channel and messaging shapes, automation schedule types,
box runtime and migration records, gateway wire types and reachability policy, connect error
mapping, inference routing policy, host settings field definitions, external URL policy.

What does not belong here: anything that only one layer uses, and anything that encodes product
decisions. Shared is for shapes and rules, not for behaviour.
