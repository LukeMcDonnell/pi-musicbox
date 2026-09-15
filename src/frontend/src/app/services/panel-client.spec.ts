import { isPanel } from './panel-client';

function at(hostname: string, port = '', search = ''): Pick<Location, 'hostname' | 'port' | 'search'> {
    return { hostname, port, search };
}

describe('isPanel', () => {
    it('is true for the kiosk, which loads http://localhost/', () => {
        // install/setup-kiosk.sh: KIOSK_URL="http://localhost/". The backend
        // decides the same thing from the other side by looking for loopback.
        expect(isPanel(at('localhost'))).toBeTrue();
        expect(isPanel(at('127.0.0.1'))).toBeTrue();
    });

    it('is false for a phone, which uses the hostname', () => {
        expect(isPanel(at('musicbox.local'))).toBeFalse();
        expect(isPanel(at('192.168.1.91'))).toBeFalse();
    });

    it('is false for ng serve, which has a port', () => {
        // The dev server is localhost:4200 — a browser at a desk, not the panel.
        expect(isPanel(at('localhost', '4200'))).toBeFalse();
        expect(isPanel(at('127.0.0.1', '4200'))).toBeFalse();
    });

    it('can be forced on for development with ?panel', () => {
        expect(isPanel(at('localhost', '4200', '?panel'))).toBeTrue();
        expect(isPanel(at('musicbox.local', '', '?panel'))).toBeTrue();
        // Not a privilege: the backend refuses to sleep the panel for any request
        // that is not loopback, whatever the page believes about itself.
    });
});
