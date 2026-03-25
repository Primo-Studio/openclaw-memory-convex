import fs from "fs/promises";
import path from "path";

interface Fact {
  _id: string;
  fact: string;
  category: string;
  agent: string;
  confidence: number;
  source?: string;
  tags?: string[];
  factHash?: string;
  keywordHash?: string;
  superseded?: boolean;
  supersededBy?: string;
  supersededAt?: number;
  accessCount?: number;
  lastAccessedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export class JsonFactStore {
  private filePath: string;
  private cache: Fact[] | null = null;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, "memory", "facts.json");
  }

  async ensureFile(): Promise<void> {
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, "[]", "utf-8");
    }
  }

  async load(): Promise<Fact[]> {
    if (this.cache) return this.cache;
    await this.ensureFile();
    const data = await fs.readFile(this.filePath, "utf-8");
    this.cache = JSON.parse(data) as Fact[];
    return this.cache;
  }

  async save(facts: Fact[]): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(facts, null, 2), "utf-8");
    this.cache = facts;
  }

  async store(fact: Omit<Fact, "_id" | "createdAt" | "updatedAt">): Promise<Fact> {
    const facts = await this.load();
    const now = Date.now();
    const newFact: Fact = {
      ...fact,
      _id: `fact_${now}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now,
      updatedAt: now,
      accessCount: fact.accessCount ?? 0,
      lastAccessedAt: fact.lastAccessedAt ?? now,
    };
    facts.push(newFact);
    await this.save(facts);
    return newFact;
  }

  async search(query: string, limit = 10): Promise<Fact[]> {
    const facts = await this.load();
    const active = facts.filter(f => !f.superseded);
    if (!query) return active.slice(0, limit);
    const lowerQuery = query.toLowerCase();
    const matches = active.filter(f => f.fact.toLowerCase().includes(lowerQuery));
    return matches.slice(0, limit);
  }

  async recent(hoursAgo = 24, limit = 10): Promise<Fact[]> {
    const facts = await this.load();
    const cutoff = Date.now() - hoursAgo * 3600 * 1000;
    const recent = facts.filter(f => !f.superseded && f.createdAt >= cutoff);
    recent.sort((a, b) => b.createdAt - a.createdAt);
    return recent.slice(0, limit);
  }

  async trackAccess(factId: string): Promise<void> {
    const facts = await this.load();
    const fact = facts.find(f => f._id === factId);
    if (!fact) return;
    fact.accessCount = (fact.accessCount ?? 0) + 1;
    fact.lastAccessedAt = Date.now();
    await this.save(facts);
  }
}

  async stats(): Promise<{total: number; categories: Record<string, number>; agents: Record<string, number>}> {
    const facts = await this.load();
    const active = facts.filter(f => !f.superseded);
    const categories: Record<string, number> = {};
    const agents: Record<string, number> = {};
    for (const f of active) {
      categories[f.category] = (categories[f.category] || 0) + 1;
      agents[f.agent] = (agents[f.agent] || 0) + 1;
    }
    return { total: active.length, categories, agents };
  }

  async list(limit = 100): Promise<Fact[]> {
    const facts = await this.load();
    return facts.slice(-limit);
  }
