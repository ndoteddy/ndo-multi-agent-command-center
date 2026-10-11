import { Component, ViewEncapsulation, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked } from 'marked';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerAliases(['sh', 'shell', 'zsh', 'powershell', 'ps1'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['md'], { languageName: 'markdown' });

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      const known = language && hljs.getLanguage(language);
      const body = known ? hljs.highlight(text, { language }).value : escapeHtml(text);
      return (
        `<div class="code-block"><div class="code-head">` +
        `<span class="code-lang">${escapeHtml(language || 'text')}</span>` +
        `<button type="button" class="copy-btn">Copy</button></div>` +
        `<pre><code class="hljs">${body}</code></pre></div>`
      );
    },
  },
});

// Model output (and anything an MCP tool or web page feeds into it) is
// untrusted, so everything goes through DOMPurify before reaching innerHTML.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

@Component({
  selector: 'app-message-body',
  styleUrl: './message-body.css',
  // The rendered HTML is injected at runtime, so scoped styles can't reach it.
  encapsulation: ViewEncapsulation.None,
  template: `<div class="md" [innerHTML]="html()" (click)="onClick($event)"></div>`,
})
export class MessageBody {
  private readonly sanitizer = inject(DomSanitizer);

  readonly text = input.required<string>();

  protected readonly html = computed<SafeHtml>(() => {
    const raw = marked.parse(this.text(), { async: false });
    const clean = DOMPurify.sanitize(raw);
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  });

  protected onClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.copy-btn');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard
      .writeText(code)
      .then(() => {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      })
      .catch(() => (button.textContent = 'Copy failed'));
  }
}
