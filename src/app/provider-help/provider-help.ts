import { Component, computed, inject, output, signal } from '@angular/core';
import { PROVIDERS, PROVIDER_IDS, ProviderId } from '../models/agent.model';
import { AgentService } from '../services/agent';
import { Dialog } from '../shared/dialog/dialog';

@Component({
  imports: [Dialog],
  selector: 'app-provider-help',
  styleUrl: './provider-help.css',
  templateUrl: './provider-help.html',
})
export class ProviderHelp {
  protected readonly agentService = inject(AgentService);
  readonly closed = output<void>();

  protected readonly providerIds = PROVIDER_IDS;
  protected readonly providers = PROVIDERS;
  protected readonly tab = signal<ProviderId>(this.agentService.provider());
  protected readonly info = computed(() => PROVIDERS[this.tab()]);
  protected readonly status = computed(() => this.agentService.providerStatus()?.[this.tab()]);
  protected readonly copied = signal('');

  protected copy(text: string): void {
    // "copilot  (then type /login)" -> copy only the runnable part
    const command = text.split('  (')[0];
    void navigator.clipboard.writeText(command).then(() => {
      this.copied.set(text);
      setTimeout(() => this.copied.set(''), 1500);
    });
  }

  protected recheck(): void {
    void this.agentService.refreshProviderStatus();
  }
}
