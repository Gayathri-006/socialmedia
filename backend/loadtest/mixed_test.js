import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 100 }, // Ramp up to 100 VUs
    { duration: '20s', target: 200 }, // Ramp up to 200 VUs
    { duration: '30s', target: 300 }, // Sustain peak at 300 VUs
    { duration: '10s', target: 0 },   // Ramp down
  ],
};

const BASE_URL = 'http://localhost:3000/api';
const NUM_USERS = 300;

export function setup() {
  const tokens = [];
  for (let i = 0; i < NUM_USERS; i++) {
    const timestamp = Date.now();
    const email = `loadtest_${timestamp}_${i}@test.com`;
    const username = `loadtest_${timestamp}_${i}`;
    const password = 'Password123!';

    http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ username, email, password }),
      { headers: { 'Content-Type': 'application/json' } }
    );

    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (loginRes.status === 200 || loginRes.status === 201) {
      try {
        const body = JSON.parse(loginRes.body);
        const token = body.token || body.accessToken || body.jwt || body.data?.token || body.user?.token || '';
        if (token) tokens.push(token);
      } catch (e) {
        console.error('Failed to parse login response JSON:', loginRes.body);
      }
    } else {
      console.error(`Setup authentication failed (${loginRes.status}):`, loginRes.body);
    }
  }

  console.log(`Acquired ${tokens.length} tokens out of ${NUM_USERS} attempted`);
  return { tokens };
}

export default function (data) {
  if (!data.tokens || data.tokens.length === 0) {
    return;
  }

  const token = data.tokens[__VU % data.tokens.length];

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const roll = Math.random();
  let res;

  if (roll < 0.70) {
    res = http.get(`${BASE_URL}/posts/feed`, { headers });
    check(res, { 'feed status is 200': (r) => r.status === 200 });
  } else if (roll < 0.85) {
    const payload = JSON.stringify({
      content: `Test post content generated at ${Date.now()}`,
    });
    res = http.post(`${BASE_URL}/posts`, payload, { headers });
    check(res, { 'post created (200/201)': (r) => r.status === 201 || r.status === 200 });
  } else {
    res = http.get(`${BASE_URL}/posts/feed`, { headers });
    check(res, { 'feed status is 200': (r) => r.status === 200 });
  }

  if (res.status !== 200 && res.status !== 201) {
    console.error(`[Status ${res.status}] Failed request body: ${res.body}`);
  }

  sleep(0.5);
}