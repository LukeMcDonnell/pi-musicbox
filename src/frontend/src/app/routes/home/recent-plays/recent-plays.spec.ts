import { TestBed } from '@angular/core/testing';
import { RecentPlays } from './recent-plays';

describe('RecentPlays', () => {
    it('says it is a stub', () => {
        TestBed.configureTestingModule({ imports: [RecentPlays] });
        const fixture = TestBed.createComponent(RecentPlays);
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('not built yet');
    });
});
