import type { Bridge, ConnState, TcsyncSettings } from "./types";
import { rewriteToDirect } from "./route";
import { requestTimeoutMs, rewriteFeedUrl, toBridgeRequest, toResponse, withTimeout } from "./fetchAdapter";

const DIAL_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Absence after which a resumed app checks that an "up" tunnel still works. */
const RESUME_CHECK_AFTER_MS = 30_000;
const RESUME_PING_TIMEOUT_MS = 10_000;

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

function signalOf(req: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (req instanceof Request ? req.signal : undefined) ?? undefined;
}

/**
 * Owns the tunnel: lazy start, single-flight init, exponential backoff after
 * failures, and routing of individual requests (tunnel or direct mode).
 *
 * Every connection lifetime has a generation number. Results that arrive for
 * an older generation (a connect attempt or request started before a reset or
 * failure) are ignored, so they can't tear down or relabel a newer tunnel.
 * Inits are serialised, because the bridge holds a single global client.
 */
export class Connection {
  state: ConnState = "idle";
  private gen = 0;
  private upPromise: Promise<void> | null = null;
  private lastInit: Promise<unknown> = Promise.resolve();
  private failures = 0;
  private nextAttemptAt = 0;
  /** Port of the last tunnelled request, used for resume health checks. */
  private lastPort = 5984;

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

  private closeBridge() {
    try {
      this.bridge.close();
    } catch {
      /* not open */
    }
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

  /** Ends generation `g` as failed (once), closing its tunnel and backing off. */
  private markUnreachable(g: number, cause?: unknown) {
    if (g !== this.gen) return;
    this.gen++;
    this.failures++;
    const delay = Math.min(BACKOFF_START_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.nextAttemptAt = this.now() + delay;
    this.upPromise = null;
    this.closeBridge();
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
    const g = this.gen;
    this.setState("connecting");
    const init = this.lastInit
      .catch(() => {})
      .then(() => this.bridge.init({ addr: s.addr, privateKey: s.privateKey, dialTimeoutMs: DIAL_TIMEOUT_MS }));
    this.lastInit = init;
    const attempt = init.then(
      () => {
        if (g !== this.gen) {
          // Superseded (reset, mode change) while connecting: drop this tunnel.
          this.closeBridge();
          throw new TypeError("tcsync: connection was reset");
        }
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.setState("up");
      },
      (e) => {
        if (g !== this.gen) throw new TypeError("tcsync: connection was reset");
        this.markUnreachable(g, e);
        throw this.unreachableError();
      },
    );
    this.upPromise = attempt;
    attempt.catch(() => {});
    return attempt;
  }

  /**
   * Called when the app returns to the foreground after `hiddenMs`. Retries at
   * once when unreachable; after a long absence, checks an "up" tunnel with a
   * ping, because the relay connection may have died while the app was frozen.
   */
  async onResume(hiddenMs = Infinity): Promise<void> {
    if (this.state === "unreachable") {
      this.nextAttemptAt = 0;
      await this.ensureUp().catch(() => {});
      return;
    }
    if (this.state !== "up" || hiddenMs < RESUME_CHECK_AFTER_MS) return;
    const g = this.gen;
    try {
      await withTimeout(this.bridge.ping(RESUME_PING_TIMEOUT_MS, this.lastPort), RESUME_PING_TIMEOUT_MS + 5_000, "ping timed out");
    } catch (e) {
      this.markUnreachable(g, e);
      this.nextAttemptAt = 0;
      await this.ensureUp().catch(() => {});
    }
  }

  /** Drops the tunnel and forgets failures (settings changed, manual reconnect). */
  reset(): void {
    this.gen++;
    this.upPromise = null;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.closeBridge();
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
    // An already-aborted signal fails at once, like fetch. An abort that comes
    // later doesn't cancel the request: native fetch resolves as soon as
    // headers arrive (immediately for CouchDB feeds) and PouchDB aborts feeds
    // as routine, which LiveSync tolerates only in that form. The request runs
    // to completion, but once abandoned it can no longer tear down the tunnel.
    const signal = signalOf(req, init);
    if (signal?.aborted) throw abortError();
    let abandoned = false;
    signal?.addEventListener("abort", () => (abandoned = true), { once: true });
    await this.ensureUp();
    const g = this.gen;
    const br = await toBridgeRequest(req, init);
    br.url = rewriteFeedUrl(br.url);
    const port = Number(new URL(br.url).port);
    if (port > 0) this.lastPort = port;
    try {
      const res = await withTimeout(this.bridge.fetch(br), requestTimeoutMs(br.url), "tcsync: request timed out");
      return toResponse(res, br.method);
    } catch (e) {
      if (!abandoned) this.markUnreachable(g, e);
      throw this.unreachableError();
    }
  }
}
