/**
 * Focus a field and make sure focusin/focusout fire.
 *
 * Headless Chrome (151+) starts with no focused window, and an unfocused
 * window moves activeElement without sending focus events.
 */

export function focus(el: HTMLElement): void {
    const prev = document.activeElement;
    el.focus();
    if (document.hasFocus()) return;
    if (prev instanceof HTMLElement && prev !== document.body && prev !== el) {
        prev.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: el }));
    }
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: prev === document.body ? null : prev }));
}

export function blur(el: HTMLElement): void {
    el.blur();
    if (document.hasFocus()) return;
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
}
