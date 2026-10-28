// The log. Every event is one JSON line in JOURNAL_PATH and one short line on stdout. It is a log
// only: the bot reads its state from the chain. Every line is redacted first: no key, token or
// keyed URL is ever written.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const secrets = new Set<string>();
let journalPath: string | null = null;
/** Human log lines go to stdout, or to stderr when stdout carries JSON (-o json, the MCP server). */
let toStderr = false;

export function logToStderr(on: boolean): void {
  toStderr = on;
}

export function setJournal(path: string | null): void {
  journalPath = path;
  if (path !== null) mkdirSync(dirname(path), { recursive: true });
}

/** Remember a value that must never be written: a token, a key, or a URL that can carry one. */
export function addSecret(value: string | undefined): void {
  if (value === undefined || value === '') return;
  secrets.add(value);
  try {
    const u = new URL(value);
    if (u.search !== '') secrets.add(u.search.slice(1));
    if (u.pathname.length > 1) secrets.add(u.pathname);
  } catch {
    // not a URL: the value itself is enough
  }
}

export function redact(text: string): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out.replace(/([?&](?:api[-_]?key|token|key|c)=)[^&\s"'#]+/gi, '$1[redacted]');
}

/** The host of a URL, which is all a log line may say about an endpoint. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'an invalid URL';
  }
};

export function log(kind: string, fields: Record<string, unknown> = {}): void {
  const line = redact(JSON.stringify({ time: new Date().toISOString(), ...fields, kind }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  ));
  if (journalPath !== null) appendFileSync(journalPath, `${line}\n`);
  const rest = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(v)}`)
    .join(' ');
  const human = redact(`${new Date().toISOString().slice(11, 19)} ${kind} ${rest}`);
  if (toStderr) console.error(human);
  else console.log(human);
}
