// T122 (SC-013): officer web load mix. Pilot concurrency is 50; the release check runs at 150 VUs
// for 15 minutes with p95 < 500 ms and errors < 0.1%.
//
// Usage:
//   k6 run --vus 50 --duration 5m tests/load/officer-mix.js
//   # release check:
//   k6 run --vus 150 --duration 15m tests/load/officer-mix.js
//
// Requires a signed-in session cookie. The POC login sets an httpOnly cookie, so the script obtains
// one through the login endpoint first and reuses it. Set these via -e:
//   BASE_URL   e.g. https://ipc.localhost
//   OFFICER_EMAIL / OFFICER_PASSWORD  a seeded officer account (DEMO_USER_PASSWORD)
//   HEADERS    optional JSON of extra headers (e.g. {"X-CSRF-Token":"..."})
import { check } from 'k6';
import http from 'k6/http';

export const options = {
  scenarios: {
    pilot: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '4m', target: 50 },
        { duration: '1m', target: 0 },
      ],
    },
    release: {
      executor: 'ramping-vus',
      startVUs: 30,
      stages: [
        { duration: '3m', target: 150 },
        { duration: '9m', target: 150 },
        { duration: '3m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

const BASE = __ENV.BASE_URL ?? 'http://localhost:8080';
const EMAIL = __ENV.OFFICER_EMAIL ?? 'officer-a@example.invalid';
const PASSWORD = __ENV.OFFICER_PASSWORD ?? 'Password1@';

function login() {
  const res = http.post(`${BASE}/ipc/v1/auth/login`, JSON.stringify({ identifier: EMAIL, password: PASSWORD }), {
    headers: { 'content-type': 'application/json' },
  });
  const cookies = res.cookies;
  const sid = cookies['ipc_sid']?.[0]?.value;
  return sid;
}

export default function () {
  const sid = login();
  const cookie = sid ? `ipc_sid=${sid}` : '';
  const headers = { cookie };
  // Officer journey: home, then the queues and the escalation list.
  const home = http.get(`${BASE}/ipc/v1/me/home`, { headers });
  check(home, { 'home 200': (r) => r.status === 200 });
  const reviews = http.get(`${BASE}/ipc/v1/tasks?view=review_queue&limit=25`, { headers });
  check(reviews, { 'reviews 200': (r) => r.status === 200 });
  const validations = http.get(`${BASE}/ipc/v1/tasks?view=validation_queue&limit=25`, { headers });
  check(validations, { 'validations 200': (r) => r.status === 200 });
  http.get(`${BASE}/ipc/v1/escalations?limit=25`, { headers });
  http.get(`${BASE}/ipc/v1/notifications?limit=25`, { headers });
}
