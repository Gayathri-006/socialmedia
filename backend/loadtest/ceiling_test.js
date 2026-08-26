import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', function () {
  return JSON.parse(open('./users.json'));
});

export const options = {
  scenarios: {
    ramping_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 200 },
        { duration: '20s', target: 500 },
        { duration: '20s', target: 1000 },
        { duration: '20s', target: 2000 },
        { duration: '20s', target: 3000 },
        { duration: '20s', target: 4000 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  discardResponseBodies: true,
};

export default function () {
  const user = users[Math.floor(Math.random() * users.length)];

  const res = http.get('http://localhost:3000/api/posts/feed', {
    headers: { Authorization: `Bearer ${user.token}` },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
