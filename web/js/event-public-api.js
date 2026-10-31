// The calls the public page and the guest page of a 会 make (D 5-1). They go to our own FastAPI, the same path in
// the deployment and in local mode, so there is no backend switch here. The host and member screens keep their
// calls in events-api.js; these are only the ones a guest needs.

import { api } from './net.js';

const path = (code) => encodeURIComponent(code);

export const publicApi = {
  /** The public page's numbers (no sign-in). 404 -> the 会 does not exist. */
  info: (code) => api.get(`/api/public/events/${path(code)}`, { auth: false }),
  /** 近い人が来るか見てみる: { level, count, genres }. Sends the interests only; the server keeps none. */
  probe: (code, interests) => api.post(`/api/public/events/${path(code)}/probe`, { interests }, { auth: false }),
  /** The 会 and my own state (signed in). */
  get: (code) => api.get(`/api/events/${path(code)}`),
  /** My live registrations: [{ code, title, starts_at, status }]. */
  mine: async () => ((await api.get('/api/events/mine')) || {}).events || [],
  apply: (code, body) => api.post(`/api/events/${path(code)}/apply`, body),
  cancel: (code) => api.post(`/api/events/${path(code)}/cancel`, {}),
  late: (code, minutes) => api.post(`/api/events/${path(code)}/late`, { minutes }),
};
