# @acentric-cloud/execution

Run Python in your own sandboxes (E2B, Daytona, Blaxel, Tensorlake) with one
API. Bring your own keys and sandboxes: credentials travel with each request
and are never stored, and nothing is installed in the sandbox.

```sh
npm install @acentric-cloud/execution
```

## Through the gateway

```ts
import { createClient } from '@acentric-cloud/execution';

const sandboxes = createClient({
  credentials: { e2b: { apiKey: process.env.E2B_API_KEY! } },
});

// Starts the script and returns at once.
const { execution } = await sandboxes.start({
  provider: 'e2b',
  sandboxId: 'your-sandbox-id',
  id: 'run-1', // your own ID: a retried start with the same code is the same execution
  code: 'import time\nfor i in range(3):\n    print(i)\n    time.sleep(1)',
});

// Output from `cursor` on, once the script ends or `yieldMs` passes.
let result = await sandboxes.wait({ provider: 'e2b', execution, cursor: 0, yieldMs: 10_000 });
while (result.status === 'running') {
  result = await sandboxes.wait({ provider: 'e2b', execution, cursor: result.nextCursor });
}
console.log(result.status, result.exitCode, result.output);
```

The client calls the gateway at `https://execution.cloud.acentric.dev` (`DEFAULT_BASE_URL`); pass
`baseUrl` to use another one, such as `http://localhost:8787`.

- `start` takes `code`, and optionally `env`, `cwd`, `python` and
  `maxRuntimeMs`. It never waits.
- `wait` takes a byte `cursor` and returns new output, `nextCursor` and the
  `status`: `running`, `exited`, `killed`, `timed_out` or `lost`.
  - `yieldMs` defaults to 10 s, up to 15 min.
  - `maxOutputBytes` defaults to 40,000. Longer output is cut in the middle,
    or paged from the start with `truncate: 'head'`.
- `kill` ends the script (SIGTERM, then SIGKILL after `graceMs`) and returns
  its last output.
- `list`, `delete` and `deleteAll` manage the executions a sandbox holds.

## Directly, without the gateway

```ts
import { createDirectClient } from '@acentric-cloud/execution/direct';

const sandboxes = createDirectClient({ credentials: { daytona: { apiKey: '...' } } });
```

The same client, calling providers from your process with the adapters the
gateway runs. It bundles every adapter.

## Without fetch: `@acentric-cloud/execution/core`

```ts
import {
  MAX_YIELD_MS,
  type ExecutionHandle,
  type ExecutionResult,
} from '@acentric-cloud/execution/core';
```

Everything but the clients: the request and response types, `SandboxError`
and the limits. It needs only ECMAScript, so it loads where `fetch` and the DOM
are absent, such as the pure half of an acentric-cloud agent.

## Providers

| Provider     | `credentials`            | `sandboxId`        |
| ------------ | ------------------------ | ------------------ |
| `e2b`        | `{ apiKey, domain? }`    | sandbox ID         |
| `daytona`    | `{ apiKey, apiUrl? }`    | sandbox ID or name |
| `blaxel`     | `{ apiKey, workspace? }` | sandbox name       |
| `tensorlake` | `{ apiKey }`             | sandbox ID or name |

The sandbox must have `python3`. Create it so it outlives your scripts:

- E2B: a timeout long enough.
- Daytona: `autoStopInterval: 0`, because a stop kills running scripts.
- Tensorlake: a named sandbox with a long `timeout_secs`.

## Errors

Every failure is a `SandboxError` with a `kind` (`auth`, `not_found`,
`conflict`, `sandbox_unavailable`, `timeout`, ...) and `retryable`. Calls are
never retried.
