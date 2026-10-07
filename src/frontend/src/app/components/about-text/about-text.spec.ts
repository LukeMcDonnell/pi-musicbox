import { TestBed } from '@angular/core/testing';
import { AboutText, clip, paragraphsOf } from './about-text';
import { IS_PANEL } from '../../services/panel-client';

function create(text: string, url: string | null = null, limit?: number) {
    TestBed.configureTestingModule({ imports: [AboutText], providers: [{ provide: IS_PANEL, useValue: false }] });
    const fixture = TestBed.createComponent(AboutText);
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('url', url);
    if (limit !== undefined) fixture.componentRef.setInput('limit', limit);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('AboutText', () => {
    it('makes each line a paragraph and drops blank ones', () => {
        expect(paragraphsOf('One.\n\nTwo.\n  \nThree.')).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('clips on a word, never mid-word, and leaves short text alone', () => {
        expect(clip('short', 400)).toBe('short');
        expect(clip('The quick brown fox jumps', 12)).toBe('The quick…');
        expect(clip('Ends a sentence. Then more', 17)).toBe('Ends a sentence…');
    });

    it('renders paragraphs, and a short text has no Show more', () => {
        const { el } = create('First.\nSecond.');
        expect([...el.querySelectorAll('p')].map((p) => p.textContent?.trim())).toEqual(['First.', 'Second.']);
        expect(el.querySelector('button')).toBeNull();
    });

    it('cuts a long text behind Show more, and Show less folds it again', () => {
        const text = `${'word '.repeat(30)}\nSecond paragraph.`;
        const { fixture, el } = create(text, null, 40);
        expect(el.textContent).not.toContain('Second paragraph.');
        const button = el.querySelector('button')!;
        expect(button.textContent?.trim()).toBe('Show more');

        button.click();
        fixture.detectChanges();
        expect(el.textContent).toContain('Second paragraph.');
        expect(button.textContent?.trim()).toBe('Show less');
        expect(button.getAttribute('aria-expanded')).toBe('true');
    });

    it('credits a long text only once it is open, above Show less', () => {
        const { fixture, el } = create('word '.repeat(30), 'https://en.wikipedia.org/wiki/X', 40);
        expect(el.textContent).not.toContain('From Wikipedia');
        el.querySelector('button')!.click();
        fixture.detectChanges();
        const credit = el.querySelector('a')!;
        expect(credit.textContent?.trim()).toBe('From Wikipedia');
        expect(credit.compareDocumentPosition(el.querySelector('button')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('credits Wikipedia with a link', () => {
        const { el } = create('Text.', 'https://en.wikipedia.org/wiki/X');
        expect(el.querySelector('a')?.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/X');
    });
});
