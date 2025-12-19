import dayjs from "dayjs";
import db from "../db/db.js";
import router from "./router.js";

// POST /api/videos - Register a video (requires admin auth)
router.post("/videos", async (ctx) => {
  const { title, master_hash, duration, description, source, preview_hash, sprite_meta_hash } = ctx.request.body as {
    title?: string;
    master_hash?: string;
    duration?: number;
    description?: string;
    source?: string;
    preview_hash?: string;
    sprite_meta_hash?: string;
  };

  if (!title || !master_hash || duration === undefined) {
    ctx.status = 400;
    ctx.body = { error: "Missing required fields: title, master_hash, duration" };
    return;
  }

  const uploaded = dayjs().unix();

  const result = db.prepare(
    `INSERT INTO videos (title, master_hash, duration, uploaded, description, source, preview_hash, sprite_meta_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, master_hash, duration, uploaded, description ?? null, source ?? null, preview_hash ?? null, sprite_meta_hash ?? null);

  ctx.body = { id: result.lastInsertRowid, title, master_hash, duration, uploaded, description, source, preview_hash, sprite_meta_hash };
});

// GET /api/videos - List all videos (also available here for admin)
router.get("/videos", async (ctx) => {
  const videos = db.prepare("SELECT * FROM videos ORDER BY uploaded DESC").all();
  ctx.body = { videos };
});

// DELETE /api/videos/:id - Remove a video
router.delete("/videos/:id", async (ctx) => {
  const { id } = ctx.params;
  const result = db.prepare("DELETE FROM videos WHERE id = ?").run(id);

  if (result.changes === 0) {
    ctx.status = 404;
    ctx.body = { error: "Video not found" };
    return;
  }

  ctx.body = { deleted: id };
});
