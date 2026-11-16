import { randomUUID } from "node:crypto";
import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import {
  addReviewReplyById,
  checkCommunityText,
  getReviews,
  saveReviewByUsername,
} from "../../lib/sheets.js";

function getRequestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} is required.`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return text;
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const target = getQueryValue(req.query?.target);
      const gameSlug = getQueryValue(req.query?.gameSlug);

      if (target && !["game", "site"].includes(target)) {
        return res.status(400).json({ error: "Invalid review target." });
      }

      if (
        target === "game" &&
        (typeof gameSlug !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,159}$/i.test(gameSlug))
      ) {
        return res.status(400).json({ error: "A valid game slug is required." });
      }

      return res.status(200).json({
        reviews: await getReviews({ target, gameSlug }),
      });
    }

    const username = requireUser(req, res);
    if (!username) return;

    const body = getRequestBody(req);
    if (body.action === "reply") {
      const reviewId = typeof body.reviewId === "string" ? body.reviewId.trim() : "";
      let reply;
      try {
        reply = normalizeText(body.reply, "Reply", 600);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      const moderation = await checkCommunityText(username, reply);
      if (!moderation.allowed) return res.status(moderation.status).json(moderation);
      if (!reviewId || reviewId.length > 100) {
        return res.status(400).json({ error: "A valid review ID is required." });
      }
      const result = await addReviewReplyById(reviewId, username, reply);
      if (!result) return res.status(404).json({ error: "Review was not found." });
      return res.status(200).json(result);
    }

    if (!["game", "site"].includes(body.target)) {
      return res.status(400).json({ error: "Invalid review target." });
    }

    let review;
    try {
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new Error("Rating must be a whole number from 1 to 5.");
      }

      const comment = normalizeText(body.comment, "Review", 2000);
      const moderation = await checkCommunityText(username, comment);
      if (!moderation.allowed) return res.status(moderation.status).json(moderation);
      review = {
        type: "review",
        id: randomUUID(),
        target: body.target,
        rating,
        comment,
      };

      if (body.target === "game") {
        if (
          typeof body.gameSlug !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,159}$/i.test(body.gameSlug)
        ) {
          throw new Error("A valid game slug is required.");
        }
        review.gameSlug = body.gameSlug;
        review.gameTitle = normalizeText(body.gameTitle, "Game title", 120);
      }
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const savedReview = await saveReviewByUsername(username, review);
    if (!savedReview) {
      return res.status(404).json({ error: "User account was not found." });
    }

    return res.status(200).json({ review: savedReview });
  } catch (error) {
    console.error("Reviews API error:", error);
    return res.status(500).json({ error: "Unable to load or save reviews." });
  }
}