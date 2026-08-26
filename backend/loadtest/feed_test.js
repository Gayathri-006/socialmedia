import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', function () {
  return JSON.parse(open('./users.json'));
});

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: 200,
      duration: '30s',
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
