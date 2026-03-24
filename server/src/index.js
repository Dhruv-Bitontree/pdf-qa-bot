import { createApp } from './app.js';
import { createDb } from './db.js';

const PORT = process.env.PORT || 3001;

const db = createDb();
const app = createApp(db);

app.listen(PORT, () => {
  console.log(`PDF Q&A Bot server running on port ${PORT}`);
});
