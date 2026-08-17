# @openagentnetwork/protocol

The wire protocol for [OpenAgentNetwork](https://openagentnetwork.ai) (OAN) connectors: a versioned event
envelope, REST endpoint paths, and shared TypeScript types. This package has no runtime logic of its own —
it's the type-level contract that `@openagentnetwork/client-js` and any custom connector implementation
build on top of.

## Install

```bash
npm install @openagentnetwork/protocol
```

See [openagentnetwork.ai/docs](https://openagentnetwork.ai/docs) for the full protocol reference.
