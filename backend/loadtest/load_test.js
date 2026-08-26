import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', function () {
  return JSON.parse(open('./users.json'));
});

export const options = {
  discardResponseBodies: true,
  stages: [
    { duration: '30s', target: 500 },  // Warm up the connections
    { duration: '1m', target: 2000 },  // Find a stable high baseline
    { duration: '1m', target: 5000 },  // Push to peak stress
    { duration: '30s', target: 0 },    // Cool down gracefully
  ],
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
    console.error(`User ${user.id} failed with status ${res.status}: ${res.body}`);
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(0.1);
}