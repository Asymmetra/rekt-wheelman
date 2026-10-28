// One error type for every refusal, and the one JSON envelope the CLI and the MCP server print.
//   { ok: true, data }   or   { ok: false, error: { category, code, message, retryable } }
// `retryable` is true only where sending the same request again cannot open a second position.

export type Category = 'config' | 'venue' | 'risk' | 'rpc' | 'send' | 'session' | 'paper' | 'internal';

export class Refusal extends Error {
  readonly category: Category;
  readonly code: string;
  readonly retryable: boolean;
  /** How long a loop waits before it tries again, in ms. */
  readonly waitMs: number;
  constructor(category: Category, code: string, message: string, retryable = false, waitMs = retryable ? 30_000 : 600_000) {
    super(message);
    this.category = category;
    this.code = code;
    this.retryable = retryable;
    this.waitMs = waitMs;
  }
}

export type Envelope = { ok: true; data: unknown } | { ok: false; error: { category: Category; code: string; message: string; retryable: boolean } };

export function envelopeOf(e: unknown): Envelope {
  if (e instanceof Refusal) return { ok: false, error: { category: e.category, code: e.code, message: e.message, retryable: e.retryable } };
  return { ok: false, error: { category: 'internal', code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e), retryable: false } };
}

/** JSON with bigint as decimal text. */
export const toJson = (value: unknown, indent?: number): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), indent);
