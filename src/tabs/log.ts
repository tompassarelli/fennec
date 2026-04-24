// Debug logging — writes a timestamped event log to <profile>/palefox-debug.log
// when the pfx.debug pref is true. Lines also go to console.log.
//
// The log file accumulates across the session; delete it to start fresh.
// Read it from the profile directory (~/.mozilla/firefox/*.default*/).
//
// Designed so each module can create its own tagged logger:
//
//   import { createLogger } from "./log.ts";
//   const log = createLogger("tabs");
//   log("event-name", { foo: 1 });

declare const PathUtils: any;
declare const Services: any;
declare const Ci: any;
declare const IOUtils: any;

/**
 * Tagged log function. Returns a no-op when pfx.debug is false (cheap to call).
 * @param event Short event name; first column in the log line.
 * @param data  Arbitrary object; serialized as JSON onto the same line.
 */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

const LOG_FILENAME = "palefox-debug.log";

let _logPath: string | null = null;
function logPath(): string {
  if (_logPath) return _logPath;
  _logPath = PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    LOG_FILENAME,
  );
  return _logPath!;
}

const _lines: string[] = [];
let _flushPending = false;

function flush(): void {
  const batch = _lines.splice(0);
  if (!batch.length) {
    _flushPending = false;
    return;
  }
  const blob = batch.join("\n") + "\n";
  const path = logPath();
  IOUtils.readUTF8(path)
    .then(
      (existing: string) => IOUtils.writeUTF8(path, existing + blob),
      () => IOUtils.writeUTF8(path, blob),
    )
    .then(() => {
      if (_lines.length) flush();
      else _flushPending = false;
    })
    .catch((e: unknown) => {
      console.error("[PFX:log] write failed", e);
      _flushPending = false;
    });
}

export function createLogger(tag: string): Logger {
  const consolePrefix = `[PFX:${tag}]`;
  return (event, data = {}) => {
    if (!Services.prefs.getBoolPref("pfx.debug", false)) return;
    console.log(consolePrefix, event, data);
    _lines.push(`${Date.now()} [${tag}] ${event} ${JSON.stringify(data)}`);
    if (!_flushPending) {
      _flushPending = true;
      Promise.resolve().then(flush);
    }
  };
}
