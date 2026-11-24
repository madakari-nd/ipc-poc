// T122 (SC-013): field app load mix. Pilot concurrency is 50; the release check runs at 150 VUs
// for 15 minutes with p95 < 500 ms and errors < 0.1%.
//
// The field journey is read-heavy while offline-capable: login (device session), home, my tasks,
// one ward's assessments. Evidence uploads are not load-tested here (the S3 path is covered by the
// E2E); this mix exercises the Edge + workflow read path the phone hits after syncing.
//
// Usage: k6 run --vus 50 --duration 5m tests/load/field-mix.js  (-e BASE_URL=..., -e FIELD_EMAIL=...)
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
const EMAIL = __ENV.FIELD_EMAIL ?? 'frontline-a1@example.invalid';
const PASSWORD = __ENV.FIELD_PASSWORD ?? 'Password1@';

function login() {
  const res = http.post(`${BASE}/ipc/v1/auth/login`, JSON.stringify({ identifier: EMAIL, password: PASSWORD }), {
    headers: { 'content-type': 'application/json' },
  });
  return res.cookies['ipc_sid']?.[0]?.value;
}

export default function () {
  const sid = login();
  const headers = sid ? { cookie: `ipc_sid=${sid}` } : {};
  const home = http.get(`${BASE}/ipc/v1/me/home`, { headers });
  check(home, { 'home 200': (r) => r.status === 200 });
  const tasks = http.get(`${BASE}/ipc/v1/tasks?view=mine&limit=25`, { headers });
  check(tasks, { 'my tasks 200': (r) => r.status === 200 });
  http.get(`${BASE}/ipc/v1/assessments?limit=25`, { headers });
  http.get(`${BASE}/ipc/v1/notifications?limit=25`, { headers });
}
