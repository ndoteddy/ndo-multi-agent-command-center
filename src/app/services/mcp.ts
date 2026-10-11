import { Injectable, signal } from '@angular/core';
import { McpServer } from '../models/agent.model';

// Client for the saved MCP library on the backend (config/mcp-servers.json).
// Agents reference servers by name; the backend writes each CLI's own config.
@Injectable({ providedIn: 'root' })
export class McpService {
  private readonly _servers = signal<McpServer[]>([]);
  readonly servers = this._servers.asReadonly();

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const response = await fetch('/api/mcp');
      if (response.ok) this._servers.set((await response.json()) as McpServer[]);
    } catch {
      // backend not up yet; the manager dialog reloads on open
    }
  }

  /** Replaces the whole library. Resolves with an error message, or null on success. */
  async save(servers: McpServer[]): Promise<string | null> {
    try {
      const response = await fetch('/api/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(servers),
      });
      const body = await response.json();
      if (!response.ok) return (body as { error?: string }).error ?? 'Could not save MCP servers.';
      this._servers.set(body as McpServer[]);
      return null;
    } catch {
      return 'Could not reach the backend. Is `npm run server` running?';
    }
  }
}
