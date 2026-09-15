import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { KEYBOARD_ENABLED, OnScreenKeyboard } from '../../services/on-screen-keyboard';
import { Keyboard, type Key } from './keyboard';

function create() {
    TestBed.configureTestingModule({
        imports: [Keyboard],
        providers: [provideRouter([]), { provide: KEYBOARD_ENABLED, useValue: true }],
    });
    const fixture = TestBed.createComponent(Keyboard);
    return { fixture, cmp: fixture.componentInstance, osk: TestBed.inject(OnScreenKeyboard) };
}

function focus(html: string): HTMLInputElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const el = host.querySelector('input')!;
    el.focus();
    return el;
}

const pointer = () => new PointerEvent('pointerdown', { cancelable: true });
const find = (cmp: Keyboard, test: (k: Key) => boolean) => cmp.rows().flat().find(test)!;
const char = (cmp: Keyboard, c: string) => find(cmp, (k) => k.char === c);
const action = (cmp: Keyboard, a: string) => find(cmp, (k) => k.action === a);

describe('Keyboard', () => {
    afterEach(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        document.body.querySelectorAll('div:has(> input)').forEach((n) => n.remove());
    });

    it('fills all 20 columns on every row of every layer', () => {
        const { cmp } = create();
        for (const layer of ['letters', 'digits', 'symbols'] as const) {
            cmp.layer.set(layer);
            for (const row of cmp.rows()) {
                expect(row.reduce((sum, k) => sum + k.span, 0)).withContext(layer).toBe(20);
            }
        }
    });

    it('renders nothing until a field has focus', () => {
        const { fixture } = create();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('button')).toBeNull();
        focus('<input>');
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('button').length).toBeGreaterThan(30);
    });

    it('types, and stops a tap from doing anything else', () => {
        const { cmp } = create();
        const el = focus('<input>');
        const event = pointer();
        cmp.press(char(cmp, 'q'), event);
        expect(el.value).toBe('q');
        // What keeps focus on the field.
        expect(event.defaultPrevented).toBeTrue();
    });

    it('shifts once, then locks, then releases', () => {
        const { cmp } = create();
        const el = focus('<input>');
        cmp.press(action(cmp, 'shift'), pointer());
        cmp.press(char(cmp, 'A'), pointer());
        cmp.press(char(cmp, 'b'), pointer());
        expect(el.value).toBe('Ab');

        cmp.press(action(cmp, 'shift'), pointer());
        cmp.press(action(cmp, 'shift'), pointer());
        expect(cmp.shift()).toBe('lock');
        cmp.press(char(cmp, 'C'), pointer());
        cmp.press(char(cmp, 'D'), pointer());
        expect(el.value).toBe('AbCD');
    });

    it('starts a numeric field on digits, and resets per field', () => {
        const { cmp } = create();
        focus('<input type="tel">');
        expect(cmp.layer()).toBe('digits');
        cmp.press(find(cmp, (k) => k.label === 'ABC'), pointer());
        expect(cmp.layer()).toBe('letters');
        focus('<input inputmode="numeric">');
        expect(cmp.layer()).toBe('digits');
        focus('<input>');
        expect(cmp.layer()).toBe('letters');
    });

    it('labels Enter from enterkeyhint', () => {
        const { cmp } = create();
        focus('<input enterkeyhint="search">');
        expect(cmp.enterLabel()).toBe('Search');
        focus('<input>');
        expect(cmp.enterLabel()).toBeNull();
    });

    it('repeats backspace while held, and stops on release', async () => {
        jasmine.clock().install();
        try {
            const { cmp } = create();
            const el = focus('<input value="abcdefghij">');
            el.setSelectionRange(10, 10);
            cmp.press(action(cmp, 'backspace'), pointer());
            expect(el.value).toBe('abcdefghi');
            jasmine.clock().tick(450 + 60 * 3);
            expect(el.value).toBe('abcdef');
            cmp.release();
            jasmine.clock().tick(1000);
            expect(el.value).toBe('abcdef');
        } finally {
            jasmine.clock().uninstall();
        }
    });
});
