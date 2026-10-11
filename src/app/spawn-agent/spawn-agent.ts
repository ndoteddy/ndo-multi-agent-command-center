import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentTaskType, PROVIDERS, TASK_TYPE_LABELS } from '../models/agent.model';
import { McpManager } from '../mcp-manager/mcp-manager';
import { AgentService } from '../services/agent';
import { McpService } from '../services/mcp';
import { ModelService } from '../services/models';

const CUSTOM_MODEL = '__custom__';

@Component({
  imports: [FormsModule, McpManager],
  selector: 'app-spawn-agent',
  styleUrl: './spawn-agent.css',
  templateUrl: './spawn-agent.html',
})
export class SpawnAgent {
  protected readonly agentService = inject(AgentService);
  protected readonly mcpService = inject(McpService);
  protected readonly modelService = inject(ModelService);
  protected readonly taskTypeLabels = TASK_TYPE_LABELS;
  protected readonly taskTypes: AgentTaskType[] = ['draft-article', 'web-search', 'generic'];
  protected readonly customModelValue = CUSTOM_MODEL;

  protected readonly name = signal('');
  protected readonly brief = signal('');
  protected readonly taskType = signal<AgentTaskType>('draft-article');
  protected readonly relatedIds = signal<string[]>([]);
  protected readonly mcpNames = signal<string[]>([]);
  protected readonly showMcpManager = signal(false);

  protected readonly modelChoice = signal('');
  protected readonly customModel = signal('');
  // Models detected from the installed CLI win; presets are the fallback.
  protected readonly modelOptions = computed(() => {
    const provider = this.agentService.provider();
    const found = this.modelService.modelsFor(provider);
    if (found.length === 0) {
      return PROVIDERS[provider].models.map((m) => ({ ...m, disabled: false, title: '' }));
    }
    return found.map((m) => ({
      value: m.value,
      label: m.resolved && m.resolved !== m.value ? `${m.label} · ${m.resolved}` : m.label,
      disabled: !m.available,
      title: m.note ?? '',
    }));
  });
  protected readonly detected = computed(
    () => this.modelService.modelsFor(this.agentService.provider()).length > 0,
  );

  constructor() {
    // Model ids are provider-specific, so switching CLI resets the choice.
    effect(() => {
      this.agentService.provider();
      this.modelChoice.set('');
      this.customModel.set('');
    });
  }

  spawn(): void {
    if (!this.brief().trim()) return;
    const model = this.modelChoice() === CUSTOM_MODEL ? this.customModel() : this.modelChoice();
    // Drop names deleted from the library since they were ticked.
    const known = new Set(this.mcpService.servers().map((s) => s.name));
    this.agentService.spawn({
      brief: this.brief(),
      taskType: this.taskType(),
      name: this.name(),
      relatedIds: this.relatedIds(),
      model,
      mcp: this.mcpNames().filter((n) => known.has(n)),
    });
    this.name.set('');
    this.brief.set('');
    this.relatedIds.set([]);
    this.mcpNames.set([]);
  }

  toggleRelated(id: string, checked: boolean): void {
    this.relatedIds.update((ids) =>
      checked ? [...ids, id] : ids.filter((existing) => existing !== id),
    );
  }

  toggleMcp(name: string, checked: boolean): void {
    this.mcpNames.update((names) =>
      checked ? [...names, name] : names.filter((existing) => existing !== name),
    );
  }
}
