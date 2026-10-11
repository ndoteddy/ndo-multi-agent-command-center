import { Component, output, input } from '@angular/core';

@Component({
  selector: 'app-dialog',
  styleUrl: './dialog.css',
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="title()"
        [style.max-width.px]="width()"
        (click)="$event.stopPropagation()"
      >
        <header>
          <h2>{{ title() }}</h2>
          <button type="button" class="close" aria-label="Close" (click)="closed.emit()">✕</button>
        </header>
        <div class="body"><ng-content /></div>
      </div>
    </div>
  `,
})
export class Dialog {
  readonly title = input.required<string>();
  readonly width = input(640);
  readonly closed = output<void>();
}
