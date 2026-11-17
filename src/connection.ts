import type { Bridge, ConnState, TcsyncSettings } from "./types";
import { rewriteToDirect } from "./route";
import { requestTimeoutMs, toBridgeRequest, toResponse, withTimeout } from "./fetchAdapter";

const DIAL_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Owns the tunnel: lazy start, single-flight init, exponential backoff after
 * failures, and routing of individual requests (tunnel or direct mode).
 */
export class Connection {
  state: ConnState = "idle";
  private upPromise: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(
    private bridge: Bridge,
    private getSettings: () => TcsyncSettings,
    private onState: (s: ConnState, detail?: string) => void,
    private now: () => number = Date.now,
    private directFetch: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Milliseconds until the next connection attempt is allowed (0 = now). */
  nextAttemptInMs(): number {
    return Math.max(0, this.nextAttemptAt - this.now());
  }

  private setState(s: ConnState, detail?: string) {
    this.state = s;
    this.onState(s, detail);
  }

  private unreachableError(): TypeError {
    let key = "(unknown)";
    try {
      key = this.bridge.publicKey(this.getSettings().privateKey);
    } catch {
      /* keep placeholder */
    }
    return new TypeError(`tcsync: server offline or this device isn't allowlisted. Device key: ${key}`);
  }

  private markUnreachable(cause?: unknown) {
    this.failures++;
    const delay = Math.min(BACKOFF_START_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.nextAttemptAt = this.now() + delay;
    this.upPromise = null;
    try {
      this.bridge.close();
    } catch {
      /* already closed */
    }
    this.setState("unreachable", cause instanceof Error ? cause.message : undefined);
  }

  /** Brings the tunnel up (once; concurrent callers share the attempt). */
  ensureUp(): Promise<void> {
    const s = this.getSettings();
    if (s.mode === "direct") {
      if (this.state !== "direct") this.setState("direct");
      return Promise.resolve();
    }
    if (this.upPromise) return this.upPromise;
    if (this.nextAttemptInMs() > 0) return Promise.reject(this.unreachableError());
    if (!s.addr) {
      this.setState("error", "no server address configured");
      return Promise.reject(new TypeError("tcsync: no server address configured"));
    }
    this.setState("connecting");
    const attempt = this.bridge
      .init({ addr: s.addr, privateKey: s.privateKey, dialTimeoutMs: DIAL_TIMEOUT_MS })
      .then(
        () => {
          this.failures = 0;
          this.nextAttemptAt = 0;
          this.setState("up");
        },
        (e) => {
          this.markUnreachable(e);
          throw this.unreachableError();
        },
      );
    this.upPromise = attempt;
    attempt.catch(() => {});
    return attempt;
  }

  /** Called when the app returns to the foreground. */
  async onResume(): Promise<void> {
    if (this.state !== "unreachable") return;
    this.nextAttemptAt = 0;
    await this.ensureUp().catch(() => {});
  }

  /** Drops the tunnel and forgets failures (settings changed, manual reconnect). */
  reset(): void {
    this.upPromise = null;
    this.failures = 0;
    this.nextAttemptAt = 0;
    try {
      this.bridge.close();
    } catch {
      /* not open */
    }
    this.setState("idle");
  }

  /** Performs one fetch-style request through the tunnel or the direct URL. */
  async request(req: RequestInfo | URL, init?: RequestInit, direct?: typeof fetch): Promise<Response> {
    const s = this.getSettings();
    const url = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    if (s.mode === "direct") {
      await this.ensureUp();
      const target = rewriteToDirect(url, s.directUrl);
      const f = direct ?? this.directFetch;
      return typeof req === "string" || req instanceof URL ? f(target, init) : f(new Request(target, req), init);
    }
    await this.ensureUp();
    const br = await toBridgeRequest(req, init);
    try {
      const res = await withTimeout(this.bridge.fetch(br), requestTimeoutMs(br.url), "tcsync: request timed out");
      return toResponse(res, br.method);
    } catch (e) {
      this.markUnreachable(e);
      throw this.unreachableError();
    }
  }
}
