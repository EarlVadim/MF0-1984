import express from "express";
import { rerankPassages } from "../services/localReranker.mjs";

const router = express.Router();

// POST /api/memory/rerank — local reranker via ollama
router.post("/rerank", async (req, res) => {
  const { query, passages } = req.body;
  
  if (!query || !Array.isArray(passages)) {
    return res.status(400).json({ ok: false, error: "Missing query or passages" });
  }
  
  try {
    const ranked = await rerankPassages(query, passages);
    res.json({ ok: true, ranked });
  } catch (err) {
    console.error("[rerank endpoint]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
