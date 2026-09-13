/*
  Build-time configuration. This is the file production compiles; angular.json
  swaps in environment.development.ts for the development configuration only.

  apiUrl is the origin that /api calls are sent to. Blank means "whatever origin
  served this page", which is the only correct answer in production: one Fastify
  process serves both this bundle and /api, and the kiosk loads http://localhost/.
  Never set it here — a value baked into a production build would point the panel
  at another machine.
*/
export const environment = {
  production: true,
  apiUrl: '',
};
