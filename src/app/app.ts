import { Component, inject, signal } from '@angular/core';
import { AgentRoster } from './agent-roster/agent-roster';
import { Monitor } from './monitor/monitor';
import { PROVIDERS, PROVIDER_IDS, ProviderId, formatTokens } from './models/agent.model';
import { ProviderHelp } from './provider-help/provider-help';
import { CollapsiblePanel } from './shared/collapsible-panel/collapsible-panel';
import { SpawnAgent } from './spawn-agent/spawn-agent';
import { AgentService } from './services/agent';

type ResizablePanel = 'spawn' | 'roster';

const DEFAULT_WIDTH: Record<ResizablePanel, number> = { spawn: 320, roster: 440 };
const MIN_WIDTH = 240;
const MIN_MONITOR_WIDTH = 320;
const WIDTH_KEY = 'macc.panel-widths';

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

  protected readonly spawnWidth = signal(DEFAULT_WIDTH.spawn);
  protected readonly rosterWidth = signal(DEFAULT_WIDTH.roster);
  protected readonly dragging = signal(false);

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}') as Partial<
        Record<ResizablePanel, number>
      >;
      if (typeof saved.spawn === 'number') this.spawnWidth.set(saved.spawn);
      if (typeof saved.roster === 'number') this.rosterWidth.set(saved.roster);
    } catch {
      // storage unavailable or corrupt: keep the defaults
    }
  }

  private widthOf(panel: ResizablePanel) {
    return panel === 'spawn' ? this.spawnWidth : this.rosterWidth;
  }

  /** Keeps the panel within sensible bounds and leaves room for the monitor. */
  private clamp(panel: ResizablePanel, width: number): number {
    const other = this.widthOf(panel === 'spawn' ? 'roster' : 'spawn')();
    const max = Math.max(MIN_WIDTH, window.innerWidth - other - MIN_MONITOR_WIDTH - 120);
    return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
  }

  private persist(): void {
    try {
      localStorage.setItem(
        WIDTH_KEY,
        JSON.stringify({ spawn: this.spawnWidth(), roster: this.rosterWidth() }),
      );
    } catch {
      // not persisted; fine
    }
  }

  private readonly lastPress: Record<ResizablePanel, number> = { spawn: 0, roster: 0 };

  protected startResize(panel: ResizablePanel, event: PointerEvent): void {
    event.preventDefault();
    // Two quick presses reset the width. Handled here because a pointer
    // capture can swallow the browser's own dblclick event.
    const now = performance.now();
    const isDoublePress = now - this.lastPress[panel] < 350;
    this.lastPress[panel] = now;
    if (isDoublePress) {
      this.resetWidth(panel);
      return;
    }
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = this.widthOf(panel)();
    // The roster sits on the right, so dragging left makes it wider.
    const direction = panel === 'spawn' ? 1 : -1;
    this.dragging.set(true);

    const onMove = (move: PointerEvent) => {
      this.widthOf(panel).set(this.clamp(panel, startWidth + direction * (move.clientX - startX)));
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      this.dragging.set(false);
      this.persist();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  protected resizeByKey(panel: ResizablePanel, event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    const direction = (event.key === 'ArrowRight' ? 1 : -1) * (panel === 'spawn' ? 1 : -1);
    this.widthOf(panel).update((width) => this.clamp(panel, width + direction * step));
    this.persist();
  }

  protected resetWidth(panel: ResizablePanel): void {
    this.widthOf(panel).set(DEFAULT_WIDTH[panel]);
    this.persist();
  }

  protected providerLabel(id: ProviderId): string {
    const installed = this.agentService.providerStatus()?.[id]?.installed;
    return installed === false ? `${PROVIDERS[id].label} (not installed)` : PROVIDERS[id].label;
  }

  protected selectProvider(event: Event): void {
    this.agentService.setProvider((event.target as HTMLSelectElement).value as ProviderId);
  }
}
