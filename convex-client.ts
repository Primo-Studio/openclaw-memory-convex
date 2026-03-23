/**
 * Lightweight Convex HTTP client — zero dependencies, just fetch.
 * Wraps the Convex HTTP API for agentMemory queries and mutations.
 */

export type MemoryFact = {
  _id: string;
  fact: string;
  category: string;
  agent: string;
  confidence: number;
  source?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  version?: number;
  accessCount?: number;
  lastAccessedAt?: number;
};

export type StoreResult = {
  action: "created" | "updated";
  id: string;
  level?: string;
  similarity?: number;
  previousFact?: string;
};

export class ConvexMemoryClient {
  constructor(private readonly baseUrl: string) {}

  /** Search facts by full-text query */
  async search(query: string, opts?: {
    category?: string;
    agent?: string;
    limit?: number;
  }): Promise<MemoryFact[]> {
    const args: Record<string, unknown> = { query };
    if (opts?.category) args.category = opts.category;
    if (opts?.agent) args.agent = opts.agent;
    if (opts?.limit) args.limit = opts.limit;

    return this.query("agentMemory:search", args);
  }

  /** Get recent facts */
  async recent(opts?: {
    agent?: string;
    hours?: number;
    limit?: number;
  }): Promise<MemoryFact[]> {
    return this.query("agentMemory:recent", opts ?? {});
  }

  /** Store a new fact (with dedup) */
  async store(fact: {
    fact: string;
    category: string;
    agent: string;
    confidence: number;
    source?: string;
    tags?: string[];
  }): Promise<StoreResult> {
    return this.mutate("agentMemory:store", {
      ...fact,
      source: fact.source ?? "auto-capture",
    });
  }

  /** Track fact access (for decay/usage stats) */
  async trackAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.mutate("agentMemory:trackAccess", { ids });
    } catch {
      // Non-critical, don't fail on tracking errors
    }
  }

  /** Get stats */
  async stats(): Promise<{
    total: number;
    withHash: number;
    categories: Record<string, number>;
    agents: Record<string, number>;
  }> {
    return this.query("agentMemory:stats", {});
  }

  // ─── Internal ───

  private async query(path: string, args: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Convex query ${path} failed: ${res.status}`);
    }

    const data = await res.json();
    if (data.status === "error") {
      throw new Error(`Convex query ${path} error: ${data.errorMessage ?? "unknown"}`);
    }
    return data.value;
  }

  private async mutate(path: string, args: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Convex mutation ${path} failed: ${res.status}`);
    }

    const data = await res.json();
    if (data.status === "error") {
      throw new Error(`Convex mutation ${path} error: ${data.errorMessage ?? "unknown"}`);
    }
    return data.value;
  }
}
