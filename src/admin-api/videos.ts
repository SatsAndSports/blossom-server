import dayjs from "dayjs";
import db from "../db/db.js";
import router from "./router.js";

// POST /api/videos - Register a video (requires admin auth)
router.post("/videos", async (ctx) => {
  const { title, master_hash, duration } = ctx.request.body as {
    title?: string;
    master_hash?: string;
    duration?: number;
  };

  if (!title || !master_hash || duration === undefined) {
    ctx.status = 400;
    ctx.body = { error: "Missing required fields: title, master_hash, duration" };
    return;
  }

  const uploaded = dayjs().unix();

  db.prepare(
    `INSERT OR REPLACE INTO videos (title, master_hash, duration, uploaded) VALUES (?, ?, ?, ?)`
  ).run(title, master_hash, duration, uploaded);

  ctx.body = { title, master_hash, duration, uploaded };
});

// GET /api/videos - List all videos (also available here for admin)
router.get("/videos", async (ctx) => {
  const videos = db.prepare("SELECT * FROM videos ORDER BY uploaded DESC").all();
  ctx.body = { videos };
});

// DELETE /api/videos/:title - Remove a video
router.delete("/videos/:title", async (ctx) => {
  const { title } = ctx.params;
  const result = db.prepare("DELETE FROM videos WHERE title = ?").run(title);

  if (result.changes === 0) {
    ctx.status = 404;
    ctx.body = { error: "Video not found" };
    return;
  }

  ctx.body = { deleted: title };
});
