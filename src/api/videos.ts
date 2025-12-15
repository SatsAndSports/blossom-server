import db from "../db/db.js";
import { router } from "./router.js";

// GET /videos - List all videos (public, no auth required)
router.get("/videos", async (ctx) => {
  const videos = db.prepare("SELECT * FROM videos ORDER BY uploaded DESC").all();
  ctx.body = { videos };
});
