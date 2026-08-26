import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 2000 },  // Ramp up to 2,000 users over 10 seconds
    { duration: '15s', target: 5000 },  // Surge up to 5,000 users over 15 seconds
    { duration: '20s', target: 10000 }, // Peak at 10,000 users over 20 seconds
    { duration: '10s', target: 0 },     // Ramp down gracefully to 0
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],     // Errors must be less than 1%
    http_req_duration: ['p(95)<200'],   // 95% of requests must finish under 200ms
  },
};

export default function () {
  const url = 'http://localhost:3000/api/posts/feed';
  
  const params = {
    headers: {
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjMsInVzZXJuYW1lIjoidGVzdGVyMiIsImlhdCI6MTc4NDI5NzM0MywiZXhwIjoxNzg0OTAyMTQzfQ.WlCGyNmppeMAhzIiXIsymQlQElkdZ1sEvfvE5UsSvMg',
      'Content-Type': 'application/json',
    },
  };

  const res = http.get(url, params);

  // If any requests fail, print the status and body so we catch it immediately
  if (res.status !== 200) {
    console.error(`🚨 Request failed with status ${res.status}: ${res.body}`);
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(0.1);
}
