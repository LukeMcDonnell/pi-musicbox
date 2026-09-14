/**
 * The panel's on-screen keyboard: which field it is typing into, and the edits.
 *
 * Attaches to every text field in the document through focusin/focusout, so a
 * new input needs no wiring. `inputmode="none"` opts a field out, `type` or
 * `inputmode` numeric starts it on digits, and `enterkeyhint` labels Enter.
 *
 * Panel only: cage runs no system keyboard, phones have their own. Why this is
 * in the app rather than the compositor is in .claude/docs/decisions.md.
 */

import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

export type TextField = HTMLInputElement | HTMLTextAreaElement;

/** `email` and `number` have no selection API; edits there go at the end. */
const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

/**
 * The kiosk loads `http://localhost/` (setup-kiosk.sh); phones use the hostname
 * and `ng serve` has a port. `?keyboard` forces it on anywhere, for development.
 */
export function wantsKeyboard(location: Pick<Location, 'hostname' | 'port' | 'search'>): boolean {
    if (new URLSearchParams(location.search).has('keyboard')) return true;
    return (location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
        location.port === '';
}

export const KEYBOARD_ENABLED = new InjectionToken<boolean>('KEYBOARD_ENABLED', {
    providedIn: 'root',
    factory: () => wantsKeyboard(inject(DOCUMENT).location),
});

export function isTextField(el: EventTarget | null): el is TextField {
    if (el instanceof HTMLTextAreaElement) {
        return !el.readOnly && !el.disabled && el.inputMode !== 'none';
    }
    return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) &&
        !el.readOnly && !el.disabled && el.inputMode !== 'none';
}

@Injectable({ providedIn: 'root' })
export class OnScreenKeyboard {
    readonly enabled = inject(KEYBOARD_ENABLED);

    private readonly _target = signal<TextField | null>(null);

    /** The field being typed into, or null when the keyboard is down. */
    readonly target = this._target.asReadonly();

    readonly open = computed(() => this._target() !== null);

    constructor() {
        if (!this.enabled) return;
        const doc = inject(DOCUMENT);

        const onFocusIn = (event: FocusEvent) => {
            const field = event.target;
            if (isTextField(field)) {
                this._target.set(field);
                // After the page has grown its keyboard padding. See app.html.
                requestAnimationFrame(() => {
                    if (this._target() === field) field.scrollIntoView({ block: 'nearest' });
                });
            }
        };
        // Moving straight to another field leaves it to focusin, so no flicker.
        const onFocusOut = (event: FocusEvent) => {
            if (event.target === this._target() && !isTextField(event.relatedTarget)) {
                this._target.set(null);
            }
        };
        doc.addEventListener('focusin', onFocusIn);
        doc.addEventListener('focusout', onFocusOut);

        // Chromium fires no focusout when a focused field is removed, which is
        // what a navigation does.
        const navigations = inject(Router).events.subscribe((event) => {
            if (event instanceof NavigationEnd && !this._target()?.isConnected) {
                this._target.set(null);
            }
        });

        inject(DestroyRef).onDestroy(() => {
            doc.removeEventListener('focusin', onFocusIn);
            doc.removeEventListener('focusout', onFocusOut);
            navigations.unsubscribe();
        });
    }

    /** Replace the selection (or insert at the caret) with `text`. */
    insert(text: string): void {
        const el = this._target();
        if (!el) return;
        const [start, end] = caret(el);
        if (el.maxLength >= 0 && el.value.length - (end - start) + text.length > el.maxLength) {
            return;
        }
        edit(el, start, end, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }

    /** Delete the selection, or the character before the caret. */
    backspace(): void {
        const el = this._target();
        if (!el) return;
        let [start, end] = caret(el);
        if (start === end) {
            if (start === 0) return;
            // Don't split a surrogate pair — emoji arrive pasted, if not typed.
            const low = el.value.charCodeAt(start - 1);
            start -= low >= 0xdc00 && low <= 0xdfff && start >= 2 ? 2 : 1;
        }
        edit(el, start, end, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }

    /**
     * Enter, as a hardware key would behave: keydown for `(keydown.enter)`
     * handlers, then a newline in a textarea or a submit in a form.
     */
    enter(): void {
        const el = this._target();
        if (!el) return;
        const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
        const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        if (!proceed || !el.isConnected) return;
        if (el instanceof HTMLTextAreaElement) {
            this.insert('\n');
        } else {
            el.form?.requestSubmit();
        }
    }

    hide(): void {
        this._target()?.blur();
        this._target.set(null);
    }
}

function caret(el: TextField): [number, number] {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === null || end === null) return [el.value.length, el.value.length];
    return [start, end];
}

function edit(el: TextField, start: number, end: number, text: string): void {
    if (el.selectionStart === null) {
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
    } else {
        el.setRangeText(text, start, end, 'end');
    }
}
