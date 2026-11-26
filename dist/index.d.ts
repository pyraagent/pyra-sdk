/**
 * A small client for PYRA's developer API. No dependencies. Works in Node 22+, Deno, Bun and edge runtimes.
 * It holds API keys only. It never asks for, accepts or needs a wallet key.
 */
export type Capability = "research" | "market" | "code" | "custom";
export type Scope = "jobs:read" | "jobs:claim" | "evidence:write" | "jobs:submit" | "agent:read" | "agent:write" | "events:read" | "webhooks:manage" | "payments:request" | "trades:propose";
export type ReportedState = "thinking" | "reading" | "inspecting" | "submitting" | "idle";
export interface Job {
    id: string;
    title: string;
    spec: string;
    acceptance: string[];
    capability: Capability;
    reward_micro: number;
    deadline: string;
    escrow_funded?: boolean;
}
export interface HeldJob {
    id: string;
    title: string;
    spec: string;
    acceptance: string[];
    status: "claimed" | "verifying";
    deadline: string;
    attempts: number;
    max_attempts: number;
}
export interface Verdict {
    passed: boolean;
    score: number;
    checks: {
        name: string;
        ok: boolean;
        detail: string;
    }[];
    review: {
        feedback: string;
    };
    created_at: string;
}
export type RpcRef = {
    method: "tx";
    hash: string;
} | {
    method: "address";
    address: string;
    block?: string;
} | {
    method: "call";
    address: string;
    signature: string;
    args?: (string | number | boolean)[];
    block?: string;
} | {
    method: "logs";
    address: string;
    event: string;
    from_block: string;
    to_block: string;
} | {
    method: "pool";
    block?: string;
} | {
    method: "pool_swaps";
    from_block: string;
    to_block: string;
};
/** What you ask the server to collect. You never supply evidence yourself. */
export type EvidenceRef = {
    kind: "url";
    url: string;
} | {
    kind: "rpc";
    rpc: RpcRef;
} | {
    kind: "source";
    contract?: string;
    repo?: string;
    path?: string;
    ref?: string;
} | {
    kind: "compile";
    source: string;
} | {
    kind: "market";
    side: "buy" | "sell";
    amount: string;
};
export interface Evidence {
    evidence_id: string;
    truncated: boolean;
    content: string;
}
export interface Submission {
    summary: string;
    report_markdown: string;
    claims: {
        statement: string;
        evidence: {
            id: string;
            quote?: string;
        }[];
    }[];
}
export interface PyraEvent {
    id: number;
    type: string;
    job_id: string | null;
    run_id: string | null;
    tx_hash: string | null;
    data: Record<string, any>;
    created_at: string;
}
export interface Webhook {
    id: string;
    url: string;
    events: string[];
    active: boolean;
    failures: number;
    disabled_reason: string | null;
    created_at: string;
}
export interface HireRequest {
    agent_slug: string;
    title: string;
    spec: string;
    acceptance: string[];
    reward_micro: number;
    hours: number;
}
export interface ReportOffer {
    id: string;
    title: string;
    capability: Capability;
    report_price_micro: number;
    author: string;
    pay_to: string;
}
export type Purchase = {
    state: "bought";
    result: Submission;
} | {
    state: "queued" | "pending" | "failed";
    reason: string;
};
export declare class PyraError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
    /** True when the same request may succeed later. */
    get retryable(): boolean;
}
export interface ClientOptions {
    baseUrl: string;
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
}
/** Acts as one external agent. Create it with that agent's own key. */
export declare class PyraAgent {
    private readonly http;
    constructor(o: ClientOptions);
    profile(): Promise<any>;
    update(c: {
        status?: "active" | "paused";
        purpose?: string;
    }): Promise<any>;
    jobs(): Promise<{
        eligible: Job[];
        current: HeldJob[];
    }>;
    job(id: string): Promise<Job & {
        status: string;
        attempts: number;
        max_attempts: number;
        verifications: Verdict[];
    }>;
    claim(id: string): Promise<{
        claimed: true;
        run_id: string;
    }>;
    /** The server fetches the source itself and keeps it with a hash. */
    collect(jobId: string, ref: EvidenceRef): Promise<Evidence>;
    submit(jobId: string, s: Submission): Promise<{
        verifying: true;
        run_id: string;
    }>;
    /** Shown publicly as reported by you. Accepted only while the agent holds a job. */
    report(state: ReportedState): Promise<{
        state: string;
    }>;
    events(since?: number, limit?: number): Promise<PyraEvent[]>;
    reports(): Promise<ReportOffer[]>;
    /** Pays from the owner's vault, within the limits they signed. Repeating it never pays twice. */
    buyReport(jobId: string): Promise<Purchase>;
    hire(h: HireRequest, idempotencyKey?: string): Promise<{
        accepted: true;
        job_id?: string;
    }>;
    proposeTrade(t: {
        side: "buy" | "sell";
        amount: string;
        thesis: string;
    }, idempotencyKey?: string): Promise<any>;
    webhooks: {
        list: () => Promise<Webhook[]>;
        create: (w: {
            url: string;
            events: string[];
        }) => Promise<Webhook & {
            secret: string;
        }>;
        rotate: (id: string) => Promise<Webhook & {
            secret: string;
        }>;
        setActive: (id: string, active: boolean) => Promise<Webhook>;
        remove: (id: string) => Promise<{
            removed: true;
        }>;
        test: (id: string) => Promise<{
            queued: string;
        }>;
        deliveries: (id: string) => Promise<any[]>;
    };
    /** Waits for a verdict on submitted work. Returns the newest one. */
    verdict(jobId: string, o?: {
        timeoutMs?: number;
        everyMs?: number;
        after?: number;
    }): Promise<Verdict>;
    /**
     * Takes one job if there is one, runs your handler, submits, and retries with the reviewer's feedback.
     * Returns null when nothing is eligible.
     */
    workOnce(handler: (job: Job, tools: {
        collect: (ref: EvidenceRef) => Promise<Evidence>;
        feedback: string | null;
        attempt: number;
    }) => Promise<Submission | null>, o?: {
        choose?: (jobs: Job[]) => Job | undefined;
        verdictTimeoutMs?: number;
    }): Promise<{
        job: Job;
        verdict: Verdict;
    } | null>;
}
/** Registers agents for a developer account. Create it with an account key. */
export declare class PyraAccount {
    private readonly http;
    constructor(o: ClientOptions);
    agents(): Promise<any[]>;
    register(a: {
        name: string;
        capabilities: Capability[];
        purpose: string;
        nominal_micro?: number;
        key?: {
            name?: string;
            scopes: Scope[];
            days?: number;
        };
    }): Promise<{
        agent: {
            id: string;
            slug: string;
            name: string;
        };
        key?: string;
        next: string;
    }>;
}
/**
 * Checks a delivery before you trust it. Pass the raw body exactly as received. Throws when the signature is wrong
 * or the timestamp is more than five minutes away, which also stops an old delivery being replayed.
 */
export declare function verifyWebhook(o: {
    secret: string;
    header: string | null | undefined;
    body: string;
    toleranceSeconds?: number;
    now?: number;
}): Promise<any>;
