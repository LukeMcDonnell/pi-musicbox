import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, linkedSignal, signal } from '@angular/core';
import {
    LucideArrowBigUp,
    LucideArrowBigUpDash,
    LucideCornerDownLeft,
    LucideDelete,
    LucideKeyboardOff,
} from '@lucide/angular';
import { OnScreenKeyboard, type TextField } from '../../on-screen-keyboard';

/*
  The on-screen keyboard's keys. What they type into, and how, is
  OnScreenKeyboard; placement is app.html.

  Keys act on pointerdown and the root cancels touchstart and mousedown, which is
  what stops a tap from moving focus off the field. `:active` doesn't fire once
  touchstart is cancelled, hence the `pressed` signal. No transitions: see
  REPAINTS in library.ts.
*/

export type Layer = 'letters' | 'digits' | 'symbols';
export type Shift = 'off' | 'once' | 'lock';
type Action = 'shift' | 'backspace' | 'layer' | 'space' | 'enter' | 'hide';

export interface Key {
    id: string;
    /** Out of the 20 columns every row fills. */
    span: number;
    char?: string;
    action?: Action;
    label?: string;
    /** For a layer key: the layer it switches to. */
    to?: Layer;
}

const REPEAT_DELAY_MS = 450;
const REPEAT_EVERY_MS = 60;

const ENTER_LABELS: Record<string, string> = {
    done: 'Done', go: 'Go', next: 'Next', previous: 'Prev', search: 'Search', send: 'Send',
};

const chars = (text: string, span = 2): Key[] =>
    [...text].map((char) => ({ id: `c:${char}`, span, char }));
const spacer = (id: string, span: number): Key => ({ id, span });

function startingLayer(el: TextField | null): Layer {
    if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'tel')) return 'digits';
    return el && ['numeric', 'decimal', 'tel'].includes(el.inputMode) ? 'digits' : 'letters';
}

@Component({
    selector: 'app-keyboard',
    imports: [LucideArrowBigUp, LucideArrowBigUpDash, LucideCornerDownLeft, LucideDelete, LucideKeyboardOff],
    templateUrl: './keyboard.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Keyboard {
    readonly keyboard = inject(OnScreenKeyboard);

    readonly layer = linkedSignal(() => startingLayer(this.keyboard.target()));
    readonly shift = linkedSignal<TextField | null, Shift>({
        source: this.keyboard.target,
        computation: () => 'off',
    });
    readonly pressed = signal<string | null>(null);

    private repeat: ReturnType<typeof setTimeout> | undefined;

    readonly enterLabel = computed(() => ENTER_LABELS[this.keyboard.target()?.enterKeyHint ?? ''] ?? null);

    readonly rows = computed<Key[][]>(() => {
        const layer = this.layer();
        const backspace: Key = { id: 'backspace', span: 3, action: 'backspace', label: 'Backspace' };
        const bottom: Key[] = [
            layer === 'letters'
                ? { id: 'layer', span: 3, action: 'layer', label: '?123', to: 'digits' }
                : { id: 'layer', span: 3, action: 'layer', label: 'ABC', to: 'letters' },
            ...chars(','),
            { id: 'space', span: 8, action: 'space', label: 'Space' },
            ...chars('.'),
            { id: 'enter', span: 3, action: 'enter', label: 'Enter' },
            { id: 'hide', span: 2, action: 'hide', label: 'Hide keyboard' },
        ];
        // Ids are per row: `.` is on two rows of the symbol layers.
        const numbered = (rows: Key[][]) =>
            rows.map((row, r) => row.map((key) => ({ ...key, id: `${r}:${key.id}` })));
        if (layer === 'letters') {
            const upper = this.shift() !== 'off';
            const letters = (text: string) => chars(upper ? text.toUpperCase() : text);
            return numbered([
                letters('qwertyuiop'),
                [spacer('s:l', 1), ...letters('asdfghjkl'), spacer('s:r', 1)],
                [{ id: 'shift', span: 3, action: 'shift', label: 'Shift' }, ...letters('zxcvbnm'), backspace],
                bottom,
            ]);
        }
        const other: Key = layer === 'digits'
            ? { id: 'more', span: 5, action: 'layer', label: '#+=', to: 'symbols' }
            : { id: 'more', span: 5, action: 'layer', label: '123', to: 'digits' };
        return numbered([
            chars(layer === 'digits' ? '1234567890' : '[]{}#%^*+='),
            chars(layer === 'digits' ? '-/:;()$&@"' : '_\\|~<>€£¥•'),
            [other, ...chars(".,?!'"), { ...backspace, span: 5 }],
            bottom,
        ]);
    });

    constructor() {
        inject(DestroyRef).onDestroy(() => this.stopRepeat());
    }

    press(key: Key, event: PointerEvent): void {
        event.preventDefault();
        this.pressed.set(key.id);
        if (key.char !== undefined) {
            this.keyboard.insert(key.char);
            if (this.shift() === 'once') this.shift.set('off');
            return;
        }
        switch (key.action) {
            case 'space':
                this.keyboard.insert(' ');
                break;
            case 'shift':
                this.shift.update((s) => (s === 'off' ? 'once' : s === 'once' ? 'lock' : 'off'));
                break;
            case 'backspace':
                this.keyboard.backspace();
                this.stopRepeat();
                this.repeat = setTimeout(() => {
                    this.repeat = setInterval(() => this.keyboard.backspace(), REPEAT_EVERY_MS);
                }, REPEAT_DELAY_MS);
                break;
            case 'layer':
                this.layer.set(key.to ?? 'letters');
                this.shift.set('off');
                break;
            case 'enter':
                this.keyboard.enter();
                break;
            case 'hide':
                this.keyboard.hide();
                break;
        }
    }

    release(): void {
        this.pressed.set(null);
        this.stopRepeat();
    }

    tone(key: Key): string {
        if (this.pressed() === key.id) return 'bg-muted text-bg';
        if (key.action === 'enter') return 'bg-accent text-on-accent font-semibold';
        if (key.action === 'shift' && this.shift() !== 'off') return 'bg-raised text-accent';
        return key.char !== undefined || key.action === 'space' ? 'bg-raised' : 'bg-surface';
    }

    private stopRepeat(): void {
        // Timeout and interval ids share one pool, so this clears either.
        clearInterval(this.repeat);
        this.repeat = undefined;
    }
}
