// Arandu — Persistência de sessões: InMemoryDb e BlobsDb (qualquer store chave-valor com escrita condicional por etag).
// Contém código modificado de terceiros sob Apache-2.0; ver NOTICE.
import type { CacheStore } from "./ferramentas.ts";
import type { AgentSession, RunOutput } from "./tipos.ts";

export interface BaseDb extends CacheStore {
  getSession(sessionId: string, userId?: string): Promise<AgentSession | null>;
  upsertSession(session: AgentSession): Promise<AgentSession | null>;
  upsertRun(run: RunOutput, sessionId: string, userId?: string): Promise<void>;
  deleteSession(sessionId: string, userId?: string): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryDb implements BaseDb {
  private sessoes = new Map<string, AgentSession>();
  private cacheMap = new Map<string, { valor: string; em: number }>();
  async getSession(id: string, userId?: string) {
    const s = this.sessoes.get(id);
    if (!s || (userId && s.userId && s.userId !== userId)) return null;
    return clone(s);
  }
  async upsertSession(s: AgentSession) {
    const atual = this.sessoes.get(s.sessionId);
    if (atual?.userId && s.userId && atual.userId !== s.userId) return null; // dono diferente: não grava
    const novo = { ...clone(s), runs: atual?.runs ?? [], createdAt: atual?.createdAt ?? s.createdAt, updatedAt: Math.floor(Date.now() / 1000) };
    this.sessoes.set(s.sessionId, novo);
    return clone(novo);
  }
  async upsertRun(run: RunOutput, sessionId: string) {
    const s = this.sessoes.get(sessionId);
    if (!s) return;
    const i = s.runs.findIndex((r) => r.runId === run.runId);
    if (i >= 0) s.runs[i] = clone(run);
    else s.runs.push(clone(run));
  }
  async deleteSession(id: string) {
    this.sessoes.delete(id);
  }
  async getCache(k: string) {
    return this.cacheMap.get(k) ?? null;
  }
  async setCache(k: string, valor: string) {
    this.cacheMap.set(k, { valor, em: Date.now() / 1000 });
  }
}

type StoreBlobs = {
  get(k: string, o: { type: "json" }): Promise<any>;
  getWithMetadata(k: string, o: { type: "json" }): Promise<{ data: any; etag?: string } | null>;
  setJSON(k: string, v: unknown, o?: { onlyIfMatch?: string; onlyIfNew?: boolean }): Promise<{ modified: boolean }>;
  delete(k: string): Promise<void>;
};

// Uma sessão por blob ("sessao:<id>"), com os runs dentro; cache em "cache:<chave>".
// maxRuns limita o tamanho guardado (o histórico usa só os últimos num_history_runs).
export class BlobsDb implements BaseDb {
  private store: StoreBlobs;
  private opts: { maxRuns?: number };
  constructor(store: StoreBlobs, opts: { maxRuns?: number } = {}) {
    this.store = store;
    this.opts = opts;
  }
  private chave = (id: string) => `sessao:${id.replace(/[^\w@.:-]/g, "_")}`;

  async getSession(id: string, userId?: string) {
    const s = (await this.store.get(this.chave(id), { type: "json" })) as AgentSession | null;
    if (!s || (userId && s.userId && s.userId !== userId)) return null;
    return s;
  }
  // Escrita condicional (etag): a sessão no blob é a fonte; runs já gravados são preservados.
  private async mudar(id: string, f: (s: AgentSession | null) => AgentSession | null) {
    for (let i = 0; i < 6; i++) {
      const atual = await this.store.getWithMetadata(this.chave(id), { type: "json" });
      const novo = f((atual?.data as AgentSession) ?? null);
      if (!novo) return null;
      const r = await this.store.setJSON(this.chave(id), novo, atual?.etag ? { onlyIfMatch: atual.etag } : { onlyIfNew: true });
      if (r.modified) return novo;
      await new Promise((res) => setTimeout(res, 40 * (i + 1)));
    }
    throw new Error(`sessão ${id}: conflito de escrita`);
  }
  async upsertSession(s: AgentSession) {
    return this.mudar(s.sessionId, (atual) => {
      if (atual?.userId && s.userId && atual.userId !== s.userId) return null;
      return { ...s, runs: atual?.runs ?? [], createdAt: atual?.createdAt ?? s.createdAt, updatedAt: Math.floor(Date.now() / 1000) };
    });
  }
  async upsertRun(run: RunOutput, sessionId: string) {
    await this.mudar(sessionId, (atual) => {
      if (!atual) return null;
      const runs = atual.runs.filter((r) => r.runId !== run.runId);
      runs.push(run);
      return { ...atual, runs: this.opts.maxRuns ? runs.slice(-this.opts.maxRuns) : runs };
    });
  }
  async deleteSession(id: string) {
    await this.store.delete(this.chave(id));
  }
  async getCache(k: string) {
    return ((await this.store.get(`cache:${k}`, { type: "json" })) as { valor: string; em: number } | null) ?? null;
  }
  async setCache(k: string, valor: string) {
    await this.store.setJSON(`cache:${k}`, { valor, em: Date.now() / 1000 });
  }
}
