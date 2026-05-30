# Contributing

## Development

```
npm install
npm run typecheck
npm test
```

The agent core under `src/` is pure and unit-tested. The `nix` shelling in
`agent/nix.ts` is exercised on a real runner, not in the test suite.

## Running a reproducer

The most useful contribution is independent reproduction. Run the reproduce
workflow in your own repository, not in this one: independence comes from
distinct builders, and a build under your own identity counts as a separate
corroboration. One repository building everything is both a bottleneck and
pointless for trust.

## Pull requests

Keep commits focused, each with a single short subject line. Run the typecheck
and the tests before opening a pull request. New behavior needs a test.

## Security

Do not file security issues in public. See [SECURITY.md](SECURITY.md).
