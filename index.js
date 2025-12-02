// index.js
import { Command } from 'commander';
import http from 'http';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import superagent from 'superagent';

const program = new Command();

// Кастомний вивід помилок (щоб показувати зрозумілі повідомлення для required options)
program.configureOutput({
  writeErr: (str) => {
    // Commander виводить щось на stderr, наприклад:
    // "error: required option '-h, --host <host>' not specified"
    // Тому фільтруємо по рядку та виводимо коротше повідомлення
    if (str.includes('required option')) {
      if (str.includes('--host')) console.error('Please specify host');
      else if (str.includes('--port')) console.error('Please specify port');
      else if (str.includes('--cache')) console.error('Please specify cache directory');
      else console.error('Missing required option');
    } else {
      // Інші повідомлення пропускаємо
      console.error(str);
    }
  },
});

program
  .name('http-cat-proxy')
  .description('Примітивний кешуючий проксі для https://http.cat')
  .requiredOption('-h, --host <host>', 'адреса сервера')
  .requiredOption('-p, --port <port>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до директорії кешу');

program.parse(process.argv);
const options = program.opts();

const host = options.host;
const port = Number(options.port);
const cacheDir = options.cache;

// Переконаємось, що порт валідний
if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
  console.error('Invalid port');
  process.exit(1);
}

// Створюємо директорію кешу, якщо її немає (синхронно — до старту сервера)
try {
  if (!fs.existsSync(cacheDir)) {
    console.log(`Cache directory "${cacheDir}" does not exist — creating...`);
    fs.mkdirSync(cacheDir, { recursive: true });
  }
} catch (err) {
  console.error('Cannot create cache directory:', err.message);
  process.exit(1);
}

// Допоміжна функція — шлях до файлу у кеші для коду
const cacheFilePath = (code) => path.join(cacheDir, `${code}.jpg`);

// Зчитати з кешу (повертає Buffer) або кидає помилку ENOENT
async function readFromCache(code) {
  const p = cacheFilePath(code);
  return fsPromises.readFile(p);
}

// Записати в кеш (перезаписує)
async function writeToCache(code, buffer) {
  const p = cacheFilePath(code);
  await fsPromises.writeFile(p, buffer);
}

// Видалити з кешу
async function deleteFromCache(code) {
  const p = cacheFilePath(code);
  await fsPromises.unlink(p);
}

// Отримати картинку з http.cat як Buffer
async function fetchFromHttpCat(code) {
  const url = `https://http.cat/${code}`;
  try {
    // superagent повертає res.body як Buffer для бінарних відповідей, переконаємось що буферуємо
    const res = await superagent.get(url).buffer(true).parse(superagent.parse.image);
    // res.body містить Buffer
    return res.body;
  } catch (err) {
    // якщо будь-яка помилка — повернемо null і обробимо як 404
    return null;
  }
}

// Серверний обробник
const server = http.createServer((req, res) => {
  // Робимо обробку у async-контексті
  (async () => {
    try {
      // Розбираємо шлях — очікуємо формат /<code>
      const url = new URL(req.url, `http://${req.headers.host || host}`);
      const pathname = url.pathname || '/';
      const parts = pathname.split('/').filter(Boolean); // відкидає пусті
      if (parts.length !== 1) {
        // Невірний шлях — можна відповісти 400
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request. Expected path like /200');
        return;
      }

      const code = parts[0];

      // Автоматична валідація коду — має бути число. Якщо хочеш дозволити 'random' — можна змінити.
      if (!/^\d{3}$/.test(code)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request. Expected three-digit HTTP status code in path, e.g. /200');
        return;
      }

      const method = req.method.toUpperCase();

      if (method === 'GET') {
        // Спробуємо прочитати з кешу
        try {
          const data = await readFromCache(code);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': Buffer.byteLength(data),
          });
          res.end(data);
          return;
        } catch (err) {
          if (err.code !== 'ENOENT') {
            // Інша помилка читання
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
            return;
          }
          // Якщо ENOENT — немає в кеші — пробуємо запросити з http.cat
          const fetched = await fetchFromHttpCat(code);
          if (!fetched) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
          // Зберігаємо у кеш і відправляємо клієнту
          try {
            await writeToCache(code, fetched);
          } catch (writeErr) {
            // якщо запис не вдався — логнемо, але все одно повернемо картинку клієнту
            console.error('Warning: failed to write to cache:', writeErr.message);
          }
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': Buffer.byteLength(fetched),
          });
          res.end(fetched);
          return;
        }
      } else if (method === 'PUT') {
        // Отримуємо тіло запиту як бінарні дані
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);
        if (!bodyBuffer || bodyBuffer.length === 0) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: empty body');
          return;
        }
        try {
          await writeToCache(code, bodyBuffer);
          res.writeHead(201, { 'Content-Type': 'text/plain' });
          res.end('Created');
          return;
        } catch (err) {
          console.error('Error writing file:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }
      } else if (method === 'DELETE') {
        try {
          await deleteFromCache(code);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Deleted');
          return;
        } catch (err) {
          if (err.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
          console.error('Error deleting file:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }
      } else {
        // Інші методи — не дозволено
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
    } catch (err) {
      console.error('Unexpected error:', err);
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } catch (_) {}
    }
  })();
});

// Слухаємо порт/хост
server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}/`);
  console.log(`Cache directory: ${path.resolve(cacheDir)}`);
});
