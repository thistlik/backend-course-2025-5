// index.js
import { Command } from 'commander';
import http from 'http';
import fs from 'fs';
import path from 'path';

const program = new Command();

// --- Кастомний вивід помилок requiredOption ---
program.configureOutput({
  writeErr: (str) => {
    if (str.includes("error: required option")) {
      if (str.includes("--host")) console.error("Please specify host");
      else if (str.includes("--port")) console.error("Please specify port");
      else if (str.includes("--cache")) console.error("Please specify cache directory");
      else console.error("Missing required option");
    } else {
      console.error(str);
    }
  }
});

program
  .requiredOption('-h, --host <host>', 'адреса сервера')
  .requiredOption('-p, --port <port>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до директорії кешу');

program.parse(process.argv);
const options = program.opts();

const host = options.host;
const port = Number(options.port);
const cacheDir = options.cache;

// --- Перевірка та створення директорії кешу ---
if (!fs.existsSync(cacheDir)) {
  console.log(`Директорії "${cacheDir}" не існує — створюю...`);
  fs.mkdirSync(cacheDir, { recursive: true });
}

// --- HTTP сервер ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Proxy server works! (Частина 1 виконана)');
});

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}/`);
  console.log(`Cache directory: ${path.resolve(cacheDir)}`);
});
