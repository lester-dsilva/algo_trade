/**
 * Express server for backtest dashboard API.
 * Run from repo root: node server/index.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', apiRouter);

// Serve React build in production
const distPath = path.join(ROOT, 'client', 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.error(`Dashboard API: http://localhost:${PORT}`);
});

// Disable socket timeout — backtest-all over 200+ dates can take several minutes
server.timeout = 0;
server.keepAliveTimeout = 0;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT=4001.`);
    process.exit(1);
  }
  throw err;
});
