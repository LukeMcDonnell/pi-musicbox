// LD_PRELOAD for mpd: a CD track starts and skips in about a second, and a bad
// sector cannot hold the drive for a minute. See .claude/docs/cd.md.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>

typedef struct cdrom_drive_s cdrom_drive_t;
typedef struct cdrom_paranoia_s cdrom_paranoia_t;
typedef struct _CdIo CdIo_t;

// One drive read per block. libcdio's 1200 (16s) must finish before a stop is
// seen or the first sample is returned; a stop now waits for one read at most.
#define BLOCK_SECTORS 25

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

// An unreadable chunk is silence, as a CD player mutes it. Reported as an error,
// libcdio retries it 9 times and paranoia 20, each read up to 6s, while a stop
// waits. A missing disc is still an error, so MPD stops instead of playing nothing.
int cdio_read_audio_sectors(const CdIo_t *c, void *buf, int32_t lsn, uint32_t n)
{
    int (*real)(const CdIo_t *, void *, int32_t, uint32_t) =
        (int (*)(const CdIo_t *, void *, int32_t, uint32_t))
        dlvsym(RTLD_NEXT, "cdio_read_audio_sectors", "CDIO_19");
    if (!real)
        return -1; // DRIVER_OP_ERROR

    errno = 0;
    int rc = real(c, buf, lsn, n);
    if (rc == 0 || errno == ENOMEDIUM || !buf)
        return rc;
    memset(buf, 0, (size_t)n * 2352); // CDIO_CD_FRAMESIZE_RAW
    return 0;
}
