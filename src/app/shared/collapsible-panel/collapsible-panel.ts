import { Component, input, signal } from '@angular/core';

@Component({
  imports: [],
  selector: 'app-collapsible-panel',
  styleUrl: './collapsible-panel.css',
  templateUrl: './collapsible-panel.html',
  host: {
    '[class.collapsed]': 'collapsed()',
  },
})
export class CollapsiblePanel {
  readonly title = input.required<string>();
  readonly padded = input(true);

  readonly collapsed = signal(false);

  toggle(): void {
    this.collapsed.update((value) => !value);
  }
}
