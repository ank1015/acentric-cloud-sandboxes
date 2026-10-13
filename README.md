# acentric-python-sandboxes

Open-source libraries and Cloudflare Workers for running Python sandboxes and
tool calls from [acentric-cloud](https://cloud.acentric.dev) agents.

## Layout

```
docs/                 design, providers, research
packages/contracts    types, limits and errors
packages/providers    the in-sandbox agent, the operations, provider adapters
workers/gateway       the Cloudflare Worker
```

The gateway runs Python in the caller's own sandboxes (E2B, Daytona, Blaxel and Tensorlake) and backs
two agent tools, `exec_python` and `wait`. See [docs/design.md](docs/design.md).

## Development

Requires Node 23.6+ and pnpm.

```sh
pnpm install
pnpm build
pnpm check
pnpm test
pnpm format
```
