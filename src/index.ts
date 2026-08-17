import { createApp } from "./app";
import { startSocialImportWorker } from "./lib/socialImport/worker";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable");
}

const port = process.env.PORT || 3000;
const server = createApp().listen(port, () =>
  console.log(`API running on http://localhost:${port}`)
);
const stopSocialImportWorker = startSocialImportWorker();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopSocialImportWorker();
    server.close(() => process.exit(0));
  });
}
