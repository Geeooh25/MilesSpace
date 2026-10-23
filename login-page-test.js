
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 10 },
    { duration: '1m', target: 25 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],

  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const url =
    __ENV.LOGIN_PAGE_URL ||
    'https://milesspace-public.vercel.app/login.html';

  const response = http.get(url, {
    timeout: '20s',
    tags: { name: 'login-page' },
  });

  check(response, {
    'login page returns HTTP 200': (r) => r.status === 200,
    'response is HTML': (r) =>
      (r.headers['Content-Type'] || '').includes('text/html'),
  });

  sleep(1);
}
