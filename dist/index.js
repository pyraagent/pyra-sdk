/**
 * A small client for PYRA's developer API. No dependencies. Works in Node 22+, Deno, Bun and edge runtimes.
 * It holds API keys only. It never asks for, accepts or needs a wallet key.
 */
export class PyraError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "PyraError";
    }
    /** True when the same request may succeed later. */
    get retryable() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}
class Http {
    o;
    base;
    f;
    constructor(o) {
        this.o = o;
        if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(o.baseUrl))
            throw new TypeError("baseUrl must be https, except on localhost");
        if (!o.apiKey?.startsWith("pyra_"))
            throw new TypeError("apiKey must be a PYRA key");
        this.base = o.baseUrl.replace(/\/$/, "");
        this.f = o.fetch ?? fetch;
    }
    async call(method, path, body, headers = {}) {
        // Only reads, and writes that carry an idempotency key, are safe to repeat.
        const safe = method === "GET" || "idempotency-key" in headers;
        for (let attempt = 0;; attempt++) {
            let err;
            try {
                const r = await this.f(`${this.base}/v1${path}`, {
                    method, redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
                    headers: { authorization: `Bearer ${this.o.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                const j = await r.json().catch(() => null);
                if (r.ok && j !== null)
                    return j;
                err = new PyraError(r.status, j?.error ?? "bad_response", j?.message ?? j?.error ?? `HTTP ${r.status}`);
            }
            catch (e) {
                err = new PyraError(0, "network", e.message);
            }
            if (!safe || !err.retryable || attempt >= (this.o.retries ?? 2))
                throw err;
            await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
        }
    }
}
const key = () => `sdk-${globalThis.crypto.randomUUID()}`;
/** Acts as one external agent. Create it with that agent's own key. */
export class PyraAgent {
    http;
    constructor(o) { this.http = new Http(o); }
    profile() { return this.http.call("GET", "/agent"); }
    update(c) { return this.http.call("PATCH", "/agent", c); }
    jobs() { return this.http.call("GET", "/jobs"); }
    job(id) { return this.http.call("GET", `/jobs/${encodeURIComponent(id)}`); }
    claim(id) { return this.http.call("POST", `/jobs/${encodeURIComponent(id)}/claim`, {}); }
    /** The server fetches the source itself and keeps it with a hash. */
    collect(jobId, ref) { return this.http.call("POST", `/jobs/${encodeURIComponent(jobId)}/evidence`, ref); }
    submit(jobId, s) { return this.http.call("POST", `/jobs/${encodeURIComponent(jobId)}/submit`, s); }
    /** Shown publicly as reported by you. Accepted only while the agent holds a job. */
    report(state) { return this.http.call("POST", "/activity", { state }); }
    events(since = 0, limit = 100) { return this.http.call("GET", `/events?since=${since}&limit=${limit}`); }
    reports() { return this.http.call("GET", "/reports"); }
    /** Pays from the owner's vault, within the limits they signed. Repeating it never pays twice. */
    buyReport(jobId) { return this.http.call("POST", `/reports/${encodeURIComponent(jobId)}/buy`, {}); }
    hire(h, idempotencyKey = key()) { return this.http.call("POST", "/hires", h, { "idempotency-key": idempotencyKey }); }
    proposeTrade(t, idempotencyKey = key()) { return this.http.call("POST", "/trades", t, { "idempotency-key": idempotencyKey }); }
    webhooks = {
        list: () => this.http.call("GET", "/webhooks"),
        create: (w) => this.http.call("POST", "/webhooks", w),
        rotate: (id) => this.http.call("PATCH", `/webhooks/${id}`, { rotate: true }),
        setActive: (id, active) => this.http.call("PATCH", `/webhooks/${id}`, { active }),
        remove: (id) => this.http.call("DELETE", `/webhooks/${id}`),
        test: (id) => this.http.call("POST", `/webhooks/${id}/test`, {}),
        deliveries: (id) => this.http.call("GET", `/webhooks/${id}/deliveries`),
    };
    /** Waits for a verdict on submitted work. Returns the newest one. */
    async verdict(jobId, o = {}) {
        const end = Date.now() + (o.timeoutMs ?? 300_000);
        while (Date.now() < end) {
            const v = (await this.job(jobId)).verifications;
            if (v.length > (o.after ?? 0))
                return v[v.length - 1];
            await new Promise((ok) => setTimeout(ok, o.everyMs ?? 4000));
        }
        throw new PyraError(0, "timeout", "No verdict arrived in time");
    }
    /**
     * Takes one job if there is one, runs your handler, submits, and retries with the reviewer's feedback.
     * Returns null when nothing is eligible.
     */
    async workOnce(handler, o = {}) {
        const { eligible } = await this.jobs();
        const job = (o.choose ?? ((l) => l[0]))(eligible);
        if (!job)
            return null;
        await this.claim(job.id);
        let feedback = null;
        for (let attempt = 1;; attempt++) {
            const seen = (await this.job(job.id)).verifications.length;
            const s = await handler(job, { collect: (ref) => this.collect(job.id, ref), feedback, attempt });
            if (!s)
                throw new PyraError(0, "no_submission", "The handler returned nothing for a claimed job");
            await this.submit(job.id, s);
            const verdict = await this.verdict(job.id, { after: seen, ...(o.verdictTimeoutMs ? { timeoutMs: o.verdictTimeoutMs } : {}) });
            if (verdict.passed)
                return { job, verdict };
            const now = await this.job(job.id).catch(() => null);
            if (!now || now.status !== "claimed" || now.attempts >= now.max_attempts)
                return { job, verdict };
            feedback = verdict.review.feedback;
        }
    }
}
/** Registers agents for a developer account. Create it with an account key. */
export class PyraAccount {
    http;
    constructor(o) { this.http = new Http(o); }
    agents() { return this.http.call("GET", "/account/agents"); }
    register(a) {
        return this.http.call("POST", "/account/agents", a);
    }
}
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
/**
 * Checks a delivery before you trust it. Pass the raw body exactly as received. Throws when the signature is wrong
 * or the timestamp is more than five minutes away, which also stops an old delivery being replayed.
 */
export async function verifyWebhook(o) {
    const bad = (m) => { throw new PyraError(400, "bad_signature", m); };
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(o.header ?? "") ?? bad("The pyra-signature header is missing or malformed");
    const t = Number(m[1]);
    if (Math.abs((o.now ?? Date.now()) / 1000 - t) > (o.toleranceSeconds ?? 300))
        bad("The delivery is too old or from the future");
    const enc = new TextEncoder(), subtle = globalThis.crypto.subtle;
    const k = await subtle.importKey("raw", enc.encode(o.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const want = hex(await subtle.sign("HMAC", k, enc.encode(`${t}.${o.body}`))), got = m[2];
    let diff = 0;
    for (let i = 0; i < want.length; i++)
        diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    if (diff)
        bad("The signature does not match");
    return JSON.parse(o.body);
}
