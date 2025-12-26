import db from "../db/db.js";
import { router } from "./router.js";

// GET /videos - List all videos (public, no auth required)
router.get("/videos", async (ctx) => {
  const rows = db.prepare("SELECT * FROM videos ORDER BY views DESC, uploaded DESC").all() as Array<Record<string, unknown>>;

  // Parse quality_stats JSON for each video
  const videos = rows.map(row => ({
    ...row,
    quality_stats: row.quality_stats ? JSON.parse(row.quality_stats as string) : null
  }));

  ctx.body = { videos };
});
