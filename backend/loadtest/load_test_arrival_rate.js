import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', function () {
  return JSON.parse(open('./users.json'));
});

export const options = {
  discardResponseBodies: true,
  scenarios: {
    feed_load: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 500,   // pool k6 keeps warm — tune down if k6 itself struggles
      maxVUs: 2000,           // hard ceiling so k6 can't runaway-allocate on your laptop
      stages: [
        { duration: '30s', target: 500 },   // requests/sec, not VUs
        { duration: '1m', target: 1500 },
        { duration: '1m', target: 3000 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const user = users[Math.floor(Math.random() * users.length)];

  const url = 'http://localhost:3000/api/posts/feed';
  const params = {
    headers: {
      'Authorization': `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.get(url, params);

  if (res.status !== 200) {
    console.error(`User ${user.id} failed with status ${res.status}`);
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
