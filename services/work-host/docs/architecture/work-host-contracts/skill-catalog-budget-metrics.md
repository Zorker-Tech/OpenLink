# Skill catalog budget metrics contract

Each budgeted catalog invocation emits one `skill_catalog_budget.applied` counter increment and three histograms for
rendered tokens, uncapped tokens, and omitted skills. All four carry the selected strategy as their only label and use
the context's metrics backend. Values describe aggregate counts and token estimates; they do not include skill names or
paths.

The strategy is one of `under_budget`, `shortened_descriptions`, `dropped_descriptions`, or `omitted_skills`, matching
the budget policy result.
