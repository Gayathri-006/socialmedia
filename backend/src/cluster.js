const cluster = require('cluster');
const os = require('os');

const numCPUs = 2;

if (cluster.isMaster || cluster.isPrimary) {
  console.log(`Master process ${process.pid} is running`);
  console.log(`Forking ${numCPUs} workers (one per CPU core)...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died (code: ${code}, signal: ${signal}). Restarting...`);
    cluster.fork(); // auto-restart crashed workers, like production would
  });

  cluster.on('online', (worker) => {
    console.log(`Worker ${worker.process.pid} is online`);
  });

} else {
  // Worker processes run the actual Express app
  require('./server');
}
