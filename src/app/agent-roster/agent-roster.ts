import { Component, inject, signal } from '@angular/core';
import {
  Agent,
  PROVIDERS,
  TASK_TYPE_LABELS,
  formatTokens,
  totalTokens,
} from '../models/agent.model';
import { MessageBody } from '../shared/message-body/message-body';
import { AgentService } from '../services/agent';

@Component({
  imports: [MessageBody],
  selector: 'app-agent-roster',
  styleUrl: './agent-roster.css',
  templateUrl: './agent-roster.html',
})
export class AgentRoster {
  protected readonly agentService = inject(AgentService);
  protected readonly taskTypeLabels = TASK_TYPE_LABELS;
  protected readonly providers = PROVIDERS;
  protected readonly formatTokens = formatTokens;

  protected tokenCount(agent: Agent): number {
    return totalTokens(agent.usage);
  }

  private readonly collapsedIds = signal<ReadonlySet<string>>(new Set());

  isCollapsed(id: string): boolean {
    return this.collapsedIds().has(id);
  }

  toggleCollapse(id: string): void {
    this.collapsedIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  relatedNames(ids: string[]): string {
    const agents = this.agentService.agents();
    return ids
      .map((id) => agents.find((a) => a.id === id)?.name)
      .filter((name): name is string => !!name)
      .join(', ');
  }

  start(id: string): void {
    this.agentService.start(id);
  }

  reply(id: string, input: HTMLInputElement): void {
    if (!input.value.trim()) return;
    this.agentService.reply(id, input.value);
    input.value = '';
  }

  reset(id: string): void {
    this.agentService.reset(id);
  }

  remove(id: string): void {
    this.agentService.remove(id);
  }
}
