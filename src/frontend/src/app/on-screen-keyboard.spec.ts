import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { KEYBOARD_ENABLED, OnScreenKeyboard, isTextField, wantsKeyboard } from './on-screen-keyboard';

function service(enabled = true): OnScreenKeyboard {
    TestBed.configureTestingModule({
        providers: [provideRouter([]), { provide: KEYBOARD_ENABLED, useValue: enabled }],
    });
    return TestBed.inject(OnScreenKeyboard);
}

/** A field in the document, focused, with the caret at `caret`. */
function field(html: string, caret?: number): HTMLInputElement | HTMLTextAreaElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const el = host.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement;
    el.focus();
    if (caret !== undefined) el.setSelectionRange(caret, caret);
    return el;
}

describe('OnScreenKeyboard', () => {
    afterEach(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        document.body.querySelectorAll('div:has(> input), div:has(> textarea), form').forEach((n) => n.remove());
    });

    describe('wantsKeyboard', () => {
        const at = (hostname: string, port = '', search = '') => wantsKeyboard({ hostname, port, search });

        it('is on for the kiosk URL only', () => {
            expect(at('localhost')).toBeTrue();
            expect(at('127.0.0.1')).toBeTrue();
            expect(at('musicbox.local')).toBeFalse();
            // ng serve, on the dev machine.
            expect(at('localhost', '4200')).toBeFalse();
        });

        it('can be forced on with ?keyboard', () => {
            expect(at('musicbox.local', '', '?keyboard')).toBeTrue();
        });
    });

    it('recognises text fields, and honours inputmode="none"', () => {
        const make = (html: string) => {
            const host = document.createElement('div');
            host.innerHTML = html;
            return host.firstElementChild;
        };
        expect(isTextField(make('<input>'))).toBeTrue();
        expect(isTextField(make('<input type="search">'))).toBeTrue();
        expect(isTextField(make('<textarea></textarea>'))).toBeTrue();
        expect(isTextField(make('<input type="checkbox">'))).toBeFalse();
        expect(isTextField(make('<input readonly>'))).toBeFalse();
        expect(isTextField(make('<input inputmode="none">'))).toBeFalse();
        expect(isTextField(make('<button></button>'))).toBeFalse();
    });

    it('follows focus between fields and closes when it leaves them', () => {
        const osk = service();
        const a = field('<input id="a">');
        expect(osk.target()).toBe(a);
        const b = field('<input id="b">');
        expect(osk.target()).toBe(b);
        b.blur();
        expect(osk.open()).toBeFalse();
    });

    it('stays out of the way where it is not enabled', () => {
        const osk = service(false);
        field('<input>');
        expect(osk.open()).toBeFalse();
    });

    it('inserts at the caret and fires input', () => {
        const osk = service();
        const el = field('<input value="rdiohead">', 1);
        const seen: string[] = [];
        el.addEventListener('input', () => seen.push(el.value));
        osk.insert('a');
        expect(el.value).toBe('radiohead');
        expect(el.selectionStart).toBe(2);
        expect(seen).toEqual(['radiohead']);
    });

    it('replaces a selection', () => {
        const osk = service();
        const el = field('<input value="hello world">');
        el.setSelectionRange(0, 5);
        osk.insert('H');
        expect(el.value).toBe('H world');
    });

    it('respects maxlength', () => {
        const osk = service();
        const el = field('<input maxlength="3" value="abc">', 3);
        osk.insert('d');
        expect(el.value).toBe('abc');
    });

    it('appends in a field without a selection API', () => {
        const osk = service();
        const el = field('<input type="email" value="me@">');
        osk.insert('x');
        expect(el.value).toBe('me@x');
        osk.backspace();
        expect(el.value).toBe('me@');
    });

    it('backspaces a character, a selection, and never half an emoji', () => {
        const osk = service();
        const el = field('<input value="ab🎵">', 4);
        osk.backspace();
        expect(el.value).toBe('ab');
        el.setSelectionRange(0, 2);
        osk.backspace();
        expect(el.value).toBe('');
        osk.backspace();
        expect(el.value).toBe('');
    });

    it('sends Enter as a keydown, then submits a form', () => {
        const osk = service();
        const el = field('<form><input></form>');
        const form = el.form!;
        const submitted = jasmine.createSpy('submit').and.callFake((e: Event) => e.preventDefault());
        const keys: string[] = [];
        form.addEventListener('submit', submitted);
        el.addEventListener('keydown', (e) => keys.push((e as KeyboardEvent).key));
        osk.enter();
        expect(keys).toEqual(['Enter']);
        expect(submitted).toHaveBeenCalled();
    });

    it('lets a keydown handler cancel Enter', () => {
        const osk = service();
        const el = field('<textarea>a</textarea>', 1);
        el.addEventListener('keydown', (e) => e.preventDefault());
        osk.enter();
        expect(el.value).toBe('a');
    });

    it('types a newline into a textarea', () => {
        const osk = service();
        const el = field('<textarea>a</textarea>', 1);
        osk.enter();
        expect(el.value).toBe('a\n');
    });

    it('hides by blurring the field', () => {
        const osk = service();
        const el = field('<input>');
        osk.hide();
        expect(document.activeElement).not.toBe(el);
        expect(osk.open()).toBeFalse();
    });
});
