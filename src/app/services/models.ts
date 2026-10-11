import { Injectable, computed, signal } from '@angular/core';
import { ProviderId } from '../models/agent.model';

export interface DiscoveredModel {
  value: string;
  label: string;
  /** Concrete model id the alias currently points to, e.g. claude-opus-4-8. */
  resolved?: string;
  available: boolean;
  /** 'versions' marks specific pinned versions, as opposed to latest-aliases. */
  group?: string;
  note?: string;
}

interface ModelCache {
  updatedAt: string | null;
  providers: Partial<Record<ProviderId, { models: DiscoveredModel[]; error?: string }>>;
}

// Model lists found by asking the installed CLIs (backend /api/models).
// Providers with nothing discovered fall back to the presets in agent.model.ts.
@Injectable({ providedIn: 'root' })
export class ModelService {
  private readonly cache = signal<ModelCache>({ updatedAt: null, providers: {} });
  readonly loading = signal(false);
  readonly error = signal('');
  readonly updatedAt = computed(() => this.cache().updatedAt);

  constructor() {
    void this.load(false);
  }

  modelsFor(provider: ProviderId): DiscoveredModel[] {
    return this.cache().providers[provider]?.models ?? [];
  }

  /** `refresh` re-asks the CLIs, which makes a few tiny Claude calls (a few cents). */
  async load(refresh: boolean): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await fetch(`/api/models${refresh ? '?refresh=1' : ''}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const cache = (await response.json()) as ModelCache;
      this.cache.set(cache);
      if (refresh) {
        const failed = Object.entries(cache.providers)
          .filter(([, p]) => p?.error && p.models.length === 0)
          .map(([id, p]) => `${id}: ${p?.error}`);
        this.error.set(failed.join(' · '));
      }
    } catch {
      this.error.set('Could not reach the backend to detect models.');
    } finally {
      this.loading.set(false);
    }
  }
}
