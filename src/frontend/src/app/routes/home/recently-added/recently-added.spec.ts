import { TestBed } from '@angular/core/testing';
import { RecentlyAdded } from './recently-added';

describe('RecentlyAdded', () => {
    it('says it is a stub', () => {
        TestBed.configureTestingModule({ imports: [RecentlyAdded] });
        const fixture = TestBed.createComponent(RecentlyAdded);
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('not built yet');
    });
});
