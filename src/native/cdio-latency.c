// LD_PRELOAD for mpd: makes a CD track start and skip in well under a second.
// Neither changes a byte of audio. See .claude/docs/cd.md.
#define _GNU_SOURCE
#include <dlfcn.h>

typedef struct cdrom_drive_s cdrom_drive_t;
typedef struct cdrom_paranoia_s cdrom_paranoia_t;

// One read block: 1s of audio, MPD's pre-play buffer. libcdio's 1200 (16s)
// must finish before a stop is seen or the first sample is returned.
#define BLOCK_SECTORS 75

static int cached = -1;

// libcdio probes byte order by seeking across the disc, twice per track open.
// It is the drive's, so probe once.
int data_bigendianp(cdrom_drive_t *d)
{
    int v = __atomic_load_n(&cached, __ATOMIC_RELAXED);
    if (v >= 0)
        return v;

    int (*real)(cdrom_drive_t *) =
        (int (*)(cdrom_drive_t *))dlvsym(RTLD_NEXT, "data_bigendianp", "CDIO_CDDA_2");
    if (!real)
        return -1; // MPD then uses default_byte_order

    v = real(d);
    if (v >= 0) // inconclusive is not remembered: the next disc may answer
        __atomic_store_n(&cached, v, __ATOMIC_RELAXED);
    return v;
}

cdrom_paranoia_t *cdio_paranoia_init(cdrom_drive_t *d)
{
    cdrom_paranoia_t *(*real)(cdrom_drive_t *) = (cdrom_paranoia_t *(*)(cdrom_drive_t *))
        dlvsym(RTLD_NEXT, "cdio_paranoia_init", "CDIO_PARANOIA_2");
    int (*size)(cdrom_paranoia_t *, int) = (int (*)(cdrom_paranoia_t *, int))
        dlvsym(RTLD_NEXT, "cdio_paranoia_cachemodel_size", "CDIO_PARANOIA_2");
    if (!real)
        return 0;

    cdrom_paranoia_t *p = real(d);
    if (p && size)
        size(p, BLOCK_SECTORS);
    return p;
}
