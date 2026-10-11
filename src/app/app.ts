import { Component, inject, signal } from '@angular/core';
import { AgentRoster } from './agent-roster/agent-roster';
import { Monitor } from './monitor/monitor';
import { PROVIDERS, PROVIDER_IDS, ProviderId, formatTokens } from './models/agent.model';
import { ProviderHelp } from './provider-help/provider-help';
import { CollapsiblePanel } from './shared/collapsible-panel/collapsible-panel';
import { SpawnAgent } from './spawn-agent/spawn-agent';
import { AgentService } from './services/agent';

@Component({
  imports: [SpawnAgent, Monitor, AgentRoster, CollapsiblePanel, ProviderHelp],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly agentService = inject(AgentService);
  protected readonly providerIds = PROVIDER_IDS;
  protected readonly providers = PROVIDERS;
  protected readonly formatTokens = formatTokens;
  protected readonly showHelp = signal(false);

  protected providerLabel(id: ProviderId): string {
    const installed = this.agentService.providerStatus()?.[id]?.installed;
    return installed === false ? `${PROVIDERS[id].label} (not installed)` : PROVIDERS[id].label;
  }

  protected selectProvider(event: Event): void {
    this.agentService.setProvider((event.target as HTMLSelectElement).value as ProviderId);
  }
}
