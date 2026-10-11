import { Injectable, computed, signal } from '@angular/core';
import {
  Agent,
  AgentTaskType,
  EMPTY_USAGE,
  PROVIDER_IDS,
  ProviderId,
  TokenUsage,
  totalTokens,
} from '../models/agent.model';

export interface SpawnOptions {
  brief: string;
  taskType: AgentTaskType;
  name: string;
  relatedIds: string[];
  model: string;
  mcp: string[];
}

export type ProviderStatus = Record<ProviderId, { installed: boolean; version?: string }>;

const PROVIDER_KEY = 'macc.provider';

@Injectable({ providedIn: 'root' })
export class AgentService {
  private readonly _agents = signal<Agent[]>([]);
  readonly agents = this._agents.asReadonly();

  readonly idleCount = computed(() => this._agents().filter((a) => a.status === 'idle').length);
  readonly workingCount = computed(
    () => this._agents().filter((a) => a.status === 'working').length,
  );
  readonly doneCount = computed(() => this._agents().filter((a) => a.status === 'done').length);

  /** The CLI new agents are spawned on (header dropdown). Existing agents keep theirs. */
  private readonly _provider = signal<ProviderId>(this.loadProvider());
  readonly provider = this._provider.asReadonly();

  /** Which CLIs the backend can find; null until the first check completes. */
  private readonly _providerStatus = signal<ProviderStatus | null>(null);
  readonly providerStatus = this._providerStatus.asReadonly();

  readonly totalUsage = computed<TokenUsage>(() =>
    this._agents().reduce(
      (sum, a) => ({
        inputTokens: sum.inputTokens + a.usage.inputTokens,
        outputTokens: sum.outputTokens + a.usage.outputTokens,
        costUsd: (sum.costUsd ?? 0) + (a.usage.costUsd ?? 0),
        estimated: sum.estimated || a.usage.estimated,
      }),
      { ...EMPTY_USAGE } as TokenUsage,
    ),
  );
  readonly totalTokenCount = computed(() => totalTokens(this.totalUsage()));

  private readonly sources = new Map<string, EventSource>();
  private readonly progressTimers = new Map<string, ReturnType<typeof setInterval>>();
  private nextIndex = 1;

  constructor() {
    void this.refreshProviderStatus();
  }

  setProvider(provider: ProviderId): void {
    this._provider.set(provider);
    try {
      localStorage.setItem(PROVIDER_KEY, provider);
    } catch {
      // storage unavailable (private mode); the choice just won't persist
    }
  }

  async refreshProviderStatus(): Promise<void> {
    try {
      const response = await fetch('/api/providers');
      if (response.ok) this._providerStatus.set((await response.json()) as ProviderStatus);
    } catch {
      // backend not reachable; leave status unknown
    }
  }

  private loadProvider(): ProviderId {
    try {
      const saved = localStorage.getItem(PROVIDER_KEY) as ProviderId | null;
      if (saved && PROVIDER_IDS.includes(saved)) return saved;
    } catch {
      // ignore
    }
    return 'claude';
  }

  spawn(options: SpawnOptions): Agent {
    const agent: Agent = {
      id: crypto.randomUUID(),
      name: options.name.trim() || `Agent ${this.nextIndex++}`,
      brief: options.brief.trim(),
      taskType: options.taskType,
      provider: this._provider(),
      model: options.model.trim(),
      mcp: options.mcp,
      relatedIds: options.relatedIds,
      status: 'idle',
      progress: 0,
      transcript: [],
      usage: { ...EMPTY_USAGE },
      error: false,
    };
    this._agents.update((list) => [...list, agent]);
    return agent;
  }

  start(id: string): void {
    const agent = this._agents().find((a) => a.id === id);
    if (!agent || agent.status === 'working') return;
    this.runTurn(id, agent.brief);
  }

  reply(id: string, message: string): void {
    const agent = this._agents().find((a) => a.id === id);
    if (!agent || agent.status === 'working' || !message.trim()) return;
    this.runTurn(id, message.trim());
  }

  private runTurn(id: string, message: string): void {
    const agent = this._agents().find((a) => a.id === id);
    if (!agent) return;

    this.stopRun(id);
    this.patch(id, {
      status: 'working',
      progress: 2,
      error: false,
      transcript: [
        ...agent.transcript,
        { role: 'user', text: message },
        { role: 'agent', text: '' },
      ],
    });

    // Crawl progress toward 92% while we wait on real output; the final
    // jump to 100% happens when the backend reports the run is done.
    const progressTimer = setInterval(() => {
      const current = this._agents().find((a) => a.id === id);
      if (!current) return;
      this.patch(id, { progress: Math.min(92, current.progress + 3) });
    }, 500);
    this.progressTimers.set(id, progressTimer);

    const params = new URLSearchParams({
      brief: message,
      taskType: agent.taskType,
      id: agent.id,
      name: agent.name,
      relatedIds: agent.relatedIds.join(','),
      provider: agent.provider,
      model: agent.model,
      mcp: agent.mcp.join(','),
    });
    const source = new EventSource(`/api/agents/run?${params.toString()}`);
    this.sources.set(id, source);

    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as {
        type: string;
        text?: string;
        message?: string;
      } & Partial<TokenUsage>;

      if (data.type === 'chunk') {
        this.appendToLastTurn(id, data.text ?? '');
      } else if (data.type === 'usage') {
        this.addUsage(id, {
          inputTokens: data.inputTokens ?? 0,
          outputTokens: data.outputTokens ?? 0,
          costUsd: data.costUsd,
          estimated: data.estimated,
        });
      } else if (data.type === 'error') {
        this.appendToLastTurn(id, `Error: ${data.message ?? 'unknown error'}`);
        this.patch(id, { status: 'done', progress: 100, error: true });
        this.stopRun(id);
      } else if (data.type === 'done') {
        this.patch(id, { status: 'done', progress: 100 });
        this.stopRun(id);
      }
    };

    source.onerror = () => {
      const current = this._agents().find((a) => a.id === id);
      if (current && current.status === 'working') {
        this.appendToLastTurn(id, 'Error: lost connection to agent backend.');
        this.patch(id, { status: 'done', progress: 100, error: true });
      }
      this.stopRun(id);
    };
  }

  reset(id: string): void {
    this.stopRun(id);
    this.forgetBackendSession(id);
    this.patch(id, {
      status: 'idle',
      progress: 0,
      transcript: [],
      usage: { ...EMPTY_USAGE },
      error: false,
    });
  }

  remove(id: string): void {
    this.stopRun(id);
    this.forgetBackendSession(id);
    this._agents.update((list) => list.filter((a) => a.id !== id));
  }

  private appendToLastTurn(id: string, text: string): void {
    const current = this._agents().find((a) => a.id === id);
    if (!current || current.transcript.length === 0) return;
    const transcript = current.transcript.slice();
    const last = transcript[transcript.length - 1];
    transcript[transcript.length - 1] = { ...last, text: last.text + text };
    this.patch(id, { transcript });
  }

  private addUsage(id: string, usage: TokenUsage): void {
    const current = this._agents().find((a) => a.id === id);
    if (!current) return;
    const transcript = current.transcript.slice();
    const last = transcript[transcript.length - 1];
    if (last) transcript[transcript.length - 1] = { ...last, usage };
    this.patch(id, {
      transcript,
      usage: {
        inputTokens: current.usage.inputTokens + usage.inputTokens,
        outputTokens: current.usage.outputTokens + usage.outputTokens,
        costUsd:
          usage.costUsd === undefined && current.usage.costUsd === undefined
            ? undefined
            : (current.usage.costUsd ?? 0) + (usage.costUsd ?? 0),
        estimated: current.usage.estimated || usage.estimated,
      },
    });
  }

  private patch(id: string, changes: Partial<Agent>): void {
    this._agents.update((list) =>
      list.map((agent) => (agent.id === id ? { ...agent, ...changes } : agent)),
    );
  }

  private stopRun(id: string): void {
    this.sources.get(id)?.close();
    this.sources.delete(id);

    const timer = this.progressTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.progressTimers.delete(id);
    }
  }

  private forgetBackendSession(id: string): void {
    fetch(`/api/agents/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}
