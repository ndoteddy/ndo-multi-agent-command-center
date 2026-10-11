import { TestBed } from '@angular/core/testing';
import { MessageBody } from './message-body';

async function render(text: string): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(MessageBody);
  fixture.componentRef.setInput('text', text);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('MessageBody', () => {
  it('renders markdown structure instead of raw syntax', async () => {
    const el = await render('# Title\n\n- one\n- two\n\n**bold** and `code`');
    expect(el.querySelector('h1')?.textContent).toBe('Title');
    expect(el.querySelectorAll('li').length).toBe(2);
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.textContent).not.toContain('**');
  });

  it('renders fenced code with a language label and copy button', async () => {
    const el = await render('```ts\nconst x: number = 1;\n```');
    expect(el.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(el.querySelector('.copy-btn')).toBeTruthy();
    expect(el.querySelector('code .hljs-keyword')).toBeTruthy();
  });

  it('renders GFM tables', async () => {
    const el = await render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(el.querySelectorAll('th').length).toBe(2);
  });

  it('strips scripts and event handlers from model output', async () => {
    const el = await render('hi <script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')?.getAttribute('onerror')).toBeNull();
  });

  it('opens links in a new tab safely', async () => {
    const el = await render('[site](https://example.com)');
    const link = el.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });
});
