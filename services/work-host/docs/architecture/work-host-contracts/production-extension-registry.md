# Production extension registry

## Explicit composition

The production host builds one declaration per `HostExtensions` id in a single table. Startup order remains the extension registry's declared order; the host does not discover extensions from a directory. The state backstop store, local-exec codec and secrets context are required bindings from their owning composition roots.

Extensions with no production extras are bound directly. Context-dependent extras are created when that extension starts, after dependencies are available; the extension's own context wins if a supplied extra has the same key.

## Verification

`tests/packages/host-production-extensions-contract.test.ts` pins full id coverage, stable order and preservation of the caller's host ports. The generic host extension registry tests pin dependency order, startup failure cleanup and reverse-order disposal.
