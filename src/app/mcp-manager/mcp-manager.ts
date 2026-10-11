import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { McpServer } from '../models/agent.model';
import { McpService } from '../services/mcp';
import { Dialog } from '../shared/dialog/dialog';

// One "KEY=value" (or "Key: value") pair per line.
function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

const formatPairs = (record: Record<string, string>, separator: '=' | ':'): string =>
  Object.entries(record)
    .map(([key, value]) => `${key}${separator === ':' ? ': ' : '='}${value}`)
    .join('\n');

@Component({
  imports: [Dialog, FormsModule],
  selector: 'app-mcp-manager',
  styleUrl: './mcp-manager.css',
  templateUrl: './mcp-manager.html',
})
export class McpManager {
  protected readonly mcp = inject(McpService);
  readonly closed = output<void>();

  protected readonly editing = signal(false);
  protected readonly error = signal('');
  protected readonly saving = signal(false);

  // form fields
  protected readonly originalName = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly type = signal<'stdio' | 'http'>('stdio');
  protected readonly command = signal('');
  protected readonly args = signal('');
  protected readonly env = signal('');
  protected readonly url = signal('');
  protected readonly headers = signal('');

  constructor() {
    void this.mcp.load();
  }

  protected startAdd(): void {
    this.originalName.set(null);
    this.name.set('');
    this.type.set('stdio');
    this.command.set('');
    this.args.set('');
    this.env.set('');
    this.url.set('');
    this.headers.set('');
    this.error.set('');
    this.editing.set(true);
  }

  protected startEdit(server: McpServer): void {
    this.startAdd();
    this.originalName.set(server.name);
    this.name.set(server.name);
    this.type.set(server.type);
    if (server.type === 'stdio') {
      this.command.set(server.command);
      this.args.set(server.args.join('\n'));
      this.env.set(formatPairs(server.env, '='));
    } else {
      this.url.set(server.url);
      this.headers.set(formatPairs(server.headers, ':'));
    }
  }

  protected async remove(name: string): Promise<void> {
    this.error.set((await this.mcp.save(this.mcp.servers().filter((s) => s.name !== name))) ?? '');
  }

  protected async submit(): Promise<void> {
    const name = this.name().trim();
    const server: McpServer =
      this.type() === 'stdio'
        ? {
            name,
            type: 'stdio',
            command: this.command().trim(),
            args: this.args()
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean),
            env: parsePairs(this.env(), '='),
          }
        : { name, type: 'http', url: this.url().trim(), headers: parsePairs(this.headers(), ':') };

    const original = this.originalName();
    const others = this.mcp.servers().filter((s) => s.name !== original);
    this.saving.set(true);
    const problem = await this.mcp.save([...others, server]);
    this.saving.set(false);
    if (problem) {
      this.error.set(problem);
      return;
    }
    this.error.set('');
    this.editing.set(false);
  }

  protected summary(server: McpServer): string {
    return server.type === 'stdio'
      ? `${server.command} ${server.args.join(' ')}`.trim()
      : server.url;
  }
}
