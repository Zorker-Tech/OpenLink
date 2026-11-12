# Avatar source

The avatar renderer in this package is integrated from
`git@git.haokir:hydite/openlink/avatar-editor` at commit
`7f2dc30b3f33026c754c1e44554015b773339343`.

The product integration keeps the upstream render engines and component API
unchanged. `AgentAvatar` is the single rendering entry point; `complete` is the
default product form, `3d` is used for onboarding and avatar selection, and the
flat/2.5D renderers remain available for small surfaces and tooling.
