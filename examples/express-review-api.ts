import express from "express";
import { reviewDiff } from "../src/index.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/review", async (req, res) => {
  const diff = req.body?.diff || "";
  const result = await reviewDiff(diff, {
    provider: process.env.PR_REVIEW_PROVIDER || "local"
  });

  res.json(result);
});

app.listen(3001, () => {
  console.log("PR review API listening on http://localhost:3001");
});

