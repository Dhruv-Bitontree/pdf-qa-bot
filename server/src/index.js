import "dotenv/config";
import { createApp } from "./app.js";
import { createDb } from "./db.js";
import { initPinecone } from "./services/vector-store.js";

const PORT = process.env.PORT || 3001;

const STARTUP_RETRY_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.STARTUP_RETRY_ATTEMPTS ?? "3", 10) || 3,
);
const STARTUP_RETRY_DELAY_MS = Math.max(
  250,
  parseInt(process.env.STARTUP_RETRY_DELAY_MS ?? "2000", 10) || 2000,
);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initializeDependencies() {
  const pineconeRequired = Boolean(process.env.PINECONE_API_KEY);

  if (!pineconeRequired) {
    console.warn(
      "PINECONE_API_KEY not set. Starting server without vector search.",
    );
    return;
  }

  for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt++) {
    const client = await initPinecone();
    if (client) {
      return;
    }

    const lastAttempt = attempt === STARTUP_RETRY_ATTEMPTS;
    if (lastAttempt) {
      throw new Error(
        `Pinecone initialization failed after ${STARTUP_RETRY_ATTEMPTS} startup attempt(s).`,
      );
    }

    console.warn(
      `Pinecone init attempt ${attempt}/${STARTUP_RETRY_ATTEMPTS} failed. Retrying in ${STARTUP_RETRY_DELAY_MS}ms...`,
    );
    await sleep(STARTUP_RETRY_DELAY_MS);
  }
}

try {
  await initializeDependencies();

  const db = await createDb();
  const app = createApp(db);

  app.listen(PORT, () => {
    console.log(`PDF Q&A Bot server running on port ${PORT}`);
  });
} catch (err) {
  console.error("Startup failed:", err?.message || err);
  process.exit(1);
}
