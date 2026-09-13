/*
  Development overrides. Swapped in for environment.ts by the `development`
  configuration in angular.json.

  apiUrl is blank by default, which keeps the documented dev loop working as it
  always has: ng serve proxies /api to localhost:8099 (see proxy.conf.json), so
  calls stay same-origin and no CORS is involved.

  Set it to talk to a backend on a DIFFERENT origin — most usefully the real box:

      apiUrl: 'http://musicbox.local',

  That is a cross-origin request, and needs nothing on the backend: it answers
  /api with access-control-allow-origin: *, preflight included.

  Leave this file blank when committing; it is checked in so the default dev
  build needs no setup.
*/
export const environment = {
  production: false,
  apiUrl: 'http://musicbox.local',
};
