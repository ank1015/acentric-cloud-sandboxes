/** What an execution ID may contain: it names the execution's folder in the sandbox. */
export const EXECUTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Largest `code`, in UTF-8 bytes. The code travels base64-encoded inside the
 * launch command, and Linux caps a single argument at 128 KiB.
 */
export const MAX_CODE_BYTES = 64 * 1024;

/** `wait` waits this long by default. */
export const DEFAULT_YIELD_MS = 10_000;

/** The longest `wait`. The gateway holds provider requests for under a minute each and renews them. */
export const MAX_YIELD_MS = 15 * 60_000;

/** `wait` returns this much output by default, about 10,000 tokens. */
export const DEFAULT_MAX_OUTPUT_BYTES = 40_000;

/** The most output one `wait` returns. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** `kill` waits this long after SIGTERM before SIGKILL, by default. */
export const DEFAULT_GRACE_MS = 3_000;

/** The longest grace period `kill` allows. */
export const MAX_GRACE_MS = 30_000;

/** Where each execution keeps its files: `<EXECUTIONS_DIR>/<id>/`. Present on every provider. */
export const EXECUTIONS_DIR = '/tmp/acentric/executions';
