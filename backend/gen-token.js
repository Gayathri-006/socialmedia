const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Try to load environment variables from your .env file if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config();
  }
} catch (e) {
  console.log("No .env file utility found, using fallback secret.");
}

// Fallback to 'secret' or whatever your development JWT secret key is
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey'; 

const payload = {
  userId: 3,
  username: "tester2"
};

// Sign a fresh token valid for 7 days
const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

console.log("\n COPY YOUR FRESH TOKEN BELOW:\n");
console.log(token);
console.log("\n");
