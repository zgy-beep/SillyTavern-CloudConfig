import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use('/src/client', express.static(path.join(root, 'src/client')));
app.use('/src/common', express.static(path.join(root, 'src/common')));
app.get('/', (req, res) => res.sendFile(path.join(root, 'scripts/preview-ui.html')));
const server = app.listen(Number(process.env.PORT) || 13077, '127.0.0.1', () => {
  console.log(`CloudConfig UI preview: http://127.0.0.1:${server.address().port} (sample data only)`);
});
