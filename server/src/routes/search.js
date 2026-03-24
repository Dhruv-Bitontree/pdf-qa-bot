import { Router } from "express";
import { checkStatus } from "../services/vector-store.js";
import { authenticate } from "../middleware/auth.js";

export function createSearchRoutes() {
  const router = Router();
  router.use(authenticate);

  // Get search status
  router.get("/status", async (req, res) => {
    try {
      const pineconeStatus = await checkStatus();
      const searchMode = process.env.SEARCH_MODE || "hybrid";
      const llmModel = process.env.GEMINI_MODEL || "gemini-2.5-pro";
      const geminiConfigured = !!process.env.GEMINI_API_KEY;
      const openrouterConfigured = !!process.env.OPENROUTER_API_KEY;

      const degradedMode =
        pineconeStatus.configured && !pineconeStatus.connected;

      let message = "All systems operational";
      if (degradedMode) {
        message = "Pinecone unavailable - using BM25 search only";
      } else if (!pineconeStatus.configured) {
        message = "Pinecone not configured - using BM25 search only";
      }

      res.json({
        pinecone_configured: pineconeStatus.configured,
        pinecone_connected: pineconeStatus.connected,
        pinecone_reason: pineconeStatus.reason || null,
        search_mode: searchMode,
        embedding_model: "openai/text-embedding-3-large",
        embedding_provider: "openrouter",
        embedding_configured: openrouterConfigured,
        llm_model: llmModel,
        llm_provider: "google",
        llm_configured: geminiConfigured,
        degraded_mode: degradedMode,
        message,
      });
    } catch (err) {
      console.error("Status check failed:", err);
      res.status(500).json({ error: "Failed to check system status" });
    }
  });

  return router;
}
