import { messageTimestamp } from "./message-timestamp.ts";

// A message without a usable timestamp is stamped by the host's clock, so a recorded
// delivery replays at its recorded instant.
export function messageAt(ts: string | undefined, now: () => Date): string {
  const value = messageTimestamp(ts);
  if (value > 0) return new Date(value * 1000).toISOString();
  return now().toISOString();
}
