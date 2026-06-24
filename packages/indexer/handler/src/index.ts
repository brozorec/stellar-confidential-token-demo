import { Hono } from "hono";
import { cors } from "hono/cors";

import { registerEventsRoute } from "./routes/events";
import { registerHealthRoute } from "./routes/health";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const origin = c.env.CORS_ORIGIN ?? "*";
  return cors({
    origin,
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
  })(c, next);
});

registerHealthRoute(app);
registerEventsRoute(app);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));
app.onError((error, c) =>
  c.json({ error: { code: "INTERNAL", message: error.message } }, 500),
);

export default app;
