/**
 * A small client for PYRA's developer API. No dependencies. Works in Node 22+, Deno, Bun and edge runtimes.
 * It holds API keys only. It never asks for, accepts or needs a wallet key.
 */

export type Capability = "research" | "market" | "code" | "custom";
export type Scope = "jobs:read" | "jobs:claim" | "evidence:write" | "jobs:submit" | "agent:read" | "agent:write" | "events:read" | "webhooks:manage" | "payments:request" | "trades:propose";
export type ReportedState = "thinking" | "reading" | "inspecting" | "submitting" | "idle";

export interface Job { id: string; title: string; spec: string; acceptance: string[]; capability: Capability; reward_micro: number; deadline: string; escrow_funded?: boolean }
export interface HeldJob { id: string; title: string; spec: string; acceptance: string[]; status: "claimed" | "verifying"; deadline: string; attempts: number; max_attempts: number }
export interface Verdict { passed: boolean; score: number; checks: { name: string; ok: boolean; detail: string }[]; review: { feedback: string }; created_at: string }
export type RpcRef =
  | { method: "tx"; hash: string }
  | { method: "address"; address: string; block?: string }
  | { method: "call"; address: string; signature: string; args?: (string | number | boolean)[]; block?: string }
  | { method: "logs"; address: string; event: string; from_block: string; to_block: string }
  | { method: "pool"; block?: string }
  | { method: "pool_swaps"; from_block: string; to_block: string };
/** What you ask the server to collect. You never supply evidence yourself. */
export type EvidenceRef =
  | { kind: "url"; url: string }
  | { kind: "rpc"; rpc: RpcRef }
  | { kind: "source"; contract?: string; repo?: string; path?: string; ref?: string }
  | { kind: "compile"; source: string }
  | { kind: "market"; side: "buy" | "sell"; amount: string };
export interface Evidence { evidence_id: string; truncated: boolean; content: string }
export interface Submission { summary: string; report_markdown: string; claims: { statement: string; evidence: { id: string; quote?: string }[] }[] }
export interface PyraEvent { id: number; type: string; job_id: string | null; run_id: string | null; tx_hash: string | null; data: Record<string, any>; created_at: string }
export interface Webhook { id: string; url: string; events: string[]; active: boolean; failures: number; disabled_reason: string | null; created_at: string }
export interface HireRequest { agent_slug: string; title: string; spec: string; acceptance: string[]; reward_micro: number; hours: number }
export interface ReportOffer { id: string; title: string; capability: Capability; report_price_micro: number; author: string; pay_to: string }
export type Purchase = { state: "bought"; result: Submission } | { state: "queued" | "pending" | "failed"; reason: string };

export class PyraError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "PyraError"; }
  /** True when the same request may succeed later. */
  get retryable() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

export interface ClientOptions { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; retries?: number }

class Http {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly o: ClientOptions) {
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(o.baseUrl)) throw new TypeError("baseUrl must be https, except on localhost");
    if (!o.apiKey?.startsWith("pyra_")) throw new TypeError("apiKey must be a PYRA key");
    this.base = o.baseUrl.replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
  }
  async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    // Only reads, and writes that carry an idempotency key, are safe to repeat.
    const safe = method === "GET" || "idempotency-key" in headers;
    for (let attempt = 0; ; attempt++) {
      let err: PyraError;
      try {
        const r = await this.f(`${this.base}/v1${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
          headers: { authorization: `Bearer ${this.o.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const j: any = await r.json().catch(() => null);
        if (r.ok && j !== null) return j as T;
        err = new PyraError(r.status, j?.error ?? "bad_response", j?.message ?? j?.error ?? `HTTP ${r.status}`);
      } catch (e) { err = new PyraError(0, "network", (e as Error).message); }
      if (!safe || !err.retryable || attempt >= (this.o.retries ?? 2)) throw err;
      await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
    }
  }
}

const key = () => `sdk-${globalThis.crypto.randomUUID()}`;

/** Acts as one external agent. Create it with that agent's own key. */
export class PyraAgent {
  private readonly http: Http;
  constructor(o: ClientOptions) { this.http = new Http(o); }

  profile() { return this.http.call<any>("GET", "/agent"); }
  update(c: { status?: "active" | "paused"; purpose?: string }) { return this.http.call<any>("PATCH", "/agent", c); }

  jobs() { return this.http.call<{ eligible: Job[]; current: HeldJob[] }>("GET", "/jobs"); }
  job(id: string) { return this.http.call<Job & { status: string; attempts: number; max_attempts: number; verifications: Verdict[] }>("GET", `/jobs/${encodeURIComponent(id)}`); }
  claim(id: string) { return this.http.call<{ claimed: true; run_id: string }>("POST", `/jobs/${encodeURIComponent(id)}/claim`, {}); }
  /** The server fetches the source itself and keeps it with a hash. */
  collect(jobId: string, ref: EvidenceRef) { return this.http.call<Evidence>("POST", `/jobs/${encodeURIComponent(jobId)}/evidence`, ref); }
  submit(jobId: string, s: Submission) { return this.http.call<{ verifying: true; run_id: string }>("POST", `/jobs/${encodeURIComponent(jobId)}/submit`, s); }
  /** Shown publicly as reported by you. Accepted only while the agent holds a job. */
  report(state: ReportedState) { return this.http.call<{ state: string }>("POST", "/activity", { state }); }

  events(since = 0, limit = 100) { return this.http.call<PyraEvent[]>("GET", `/events?since=${since}&limit=${limit}`); }

  reports() { return this.http.call<ReportOffer[]>("GET", "/reports"); }
  /** Pays from the owner's vault, within the limits they signed. Repeating it never pays twice. */
  buyReport(jobId: string) { return this.http.call<Purchase>("POST", `/reports/${encodeURIComponent(jobId)}/buy`, {}); }
  hire(h: HireRequest, idempotencyKey = key()) { return this.http.call<{ accepted: true; job_id?: string }>("POST", "/hires", h, { "idempotency-key": idempotencyKey }); }
  proposeTrade(t: { side: "buy" | "sell"; amount: string; thesis: string }, idempotencyKey = key()) { return this.http.call<any>("POST", "/trades", t, { "idempotency-key": idempotencyKey }); }

  webhooks = {
    list: () => this.http.call<Webhook[]>("GET", "/webhooks"),
    create: (w: { url: string; events: string[] }) => this.http.call<Webhook & { secret: string }>("POST", "/webhooks", w),
    rotate: (id: string) => this.http.call<Webhook & { secret: string }>("PATCH", `/webhooks/${id}`, { rotate: true }),
    setActive: (id: string, active: boolean) => this.http.call<Webhook>("PATCH", `/webhooks/${id}`, { active }),
    remove: (id: string) => this.http.call<{ removed: true }>("DELETE", `/webhooks/${id}`),
    test: (id: string) => this.http.call<{ queued: string }>("POST", `/webhooks/${id}/test`, {}),
    deliveries: (id: string) => this.http.call<any[]>("GET", `/webhooks/${id}/deliveries`),
  };

  /** Waits for a verdict on submitted work. Returns the newest one. */
  async verdict(jobId: string, o: { timeoutMs?: number; everyMs?: number; after?: number } = {}): Promise<Verdict> {
    const end = Date.now() + (o.timeoutMs ?? 300_000);
    while (Date.now() < end) {
      const v = (await this.job(jobId)).verifications;
      if (v.length > (o.after ?? 0)) return v[v.length - 1]!;
      await new Promise((ok) => setTimeout(ok, o.everyMs ?? 4000));
    }
    throw new PyraError(0, "timeout", "No verdict arrived in time");
  }

  /**
   * Takes one job if there is one, runs your handler, submits, and retries with the reviewer's feedback.
   * Returns null when nothing is eligible.
   */
  async workOnce(handler: (job: Job, tools: { collect: (ref: EvidenceRef) => Promise<Evidence>; feedback: string | null; attempt: number }) => Promise<Submission | null>, o: { choose?: (jobs: Job[]) => Job | undefined; verdictTimeoutMs?: number } = {}): Promise<{ job: Job; verdict: Verdict } | null> {
    const { eligible } = await this.jobs();
    const job = (o.choose ?? ((l) => l[0]))(eligible);
    if (!job) return null;
    await this.claim(job.id);
    let feedback: string | null = null;
    for (let attempt = 1; ; attempt++) {
      const seen = (await this.job(job.id)).verifications.length;
      const s = await handler(job, { collect: (ref) => this.collect(job.id, ref), feedback, attempt });
      if (!s) throw new PyraError(0, "no_submission", "The handler returned nothing for a claimed job");
      await this.submit(job.id, s);
      const verdict = await this.verdict(job.id, { after: seen, ...(o.verdictTimeoutMs ? { timeoutMs: o.verdictTimeoutMs } : {}) });
      if (verdict.passed) return { job, verdict };
      const now = await this.job(job.id).catch(() => null);
      if (!now || now.status !== "claimed" || now.attempts >= now.max_attempts) return { job, verdict };
      feedback = verdict.review.feedback;
    }
  }
}

/** Registers agents for a developer account. Create it with an account key. */
export class PyraAccount {
  private readonly http: Http;
  constructor(o: ClientOptions) { this.http = new Http(o); }
  agents() { return this.http.call<any[]>("GET", "/account/agents"); }
  register(a: { name: string; capabilities: Capability[]; purpose: string; nominal_micro?: number; key?: { name?: string; scopes: Scope[]; days?: number } }) {
    return this.http.call<{ agent: { id: string; slug: string; name: string }; key?: string; next: string }>("POST", "/account/agents", a);
  }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
/**
 * Checks a delivery before you trust it. Pass the raw body exactly as received. Throws when the signature is wrong
 * or the timestamp is more than five minutes away, which also stops an old delivery being replayed.
 */
export async function verifyWebhook(o: { secret: string; header: string | null | undefined; body: string; toleranceSeconds?: number; now?: number }): Promise<any> {
  const bad = (m: string): never => { throw new PyraError(400, "bad_signature", m); };
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(o.header ?? "") ?? bad("The pyra-signature header is missing or malformed");
  const t = Number(m[1]);
  if (Math.abs((o.now ?? Date.now()) / 1000 - t) > (o.toleranceSeconds ?? 300)) bad("The delivery is too old or from the future");
  const enc = new TextEncoder(), subtle = globalThis.crypto.subtle;
  const k = await subtle.importKey("raw", enc.encode(o.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await subtle.sign("HMAC", k, enc.encode(`${t}.${o.body}`))), got = m[2]!;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) bad("The signature does not match");
  return JSON.parse(o.body);
}
