
import { randomUUID } from "node:crypto";
import { google } from "googleapis";

const HEADERS = [
  "username",
  "password_hash",
  "email",
  "name",
  "created_at",
  "comments",
  "likes",
  "favorites",
  "theme",
  "avatar",
  "status",
  "verification_code_hash",
  "verification_expires_at",
  "pending_expires_at",
  "reset_password_code_hash",
  "reset_password_expires_at",
  "reset_password_attempts",
  "pending_email",
  "email_change_code_hash",
  "email_change_expires_at",
];

let sheetsClient;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!email || !privateKey || !spreadsheetId) {
    throw new Error("Google Sheets environment variables are missing.");
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = {
    api: google.sheets({ version: "v4", auth }),
    spreadsheetId,
  };

  return sheetsClient;
}

function getSheetName() {
  return process.env.GOOGLE_SHEET_NAME || "Sheet1";
}

function getRange() {
  const sheetName = getSheetName().replace(/'/g, "''");
  return `'${sheetName}'!A:U`;
}

async function readRows() {
  const { api, spreadsheetId } = getSheetsClient();

  const result = await api.spreadsheets.values.get({
    spreadsheetId,
    range: getRange(),
  });

  const rows = result.data.values || [];
  if (!rows.length) {
    throw new Error("The Google Sheet is empty; expected a header row.");
  }

  const headers = rows[0].map((header) => String(header).trim());
  const usernameColumn = headers.indexOf("username");
  const favoritesColumn = headers.indexOf("favorites");
  const commentsColumn = headers.indexOf("comments");
  const statusColumn = headers.indexOf("status");

  if (usernameColumn === -1 || favoritesColumn === -1 || commentsColumn === -1 || statusColumn === -1) {
    throw new Error(
      "The sheet must contain username, favorites, and comments headers."
    );
  }

  return { rows, usernameColumn, favoritesColumn, commentsColumn, statusColumn };
}

function parseFavorites(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((slug) => typeof slug === "string"))]
      : [];
  } catch {
    return [];
  }
}

export async function getFavoritesByUsername(username) {
  const { rows, usernameColumn, favoritesColumn } = await readRows();

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameColumn] || "").toLowerCase() === username.toLowerCase()
  );

  if (rowIndex === -1) return null;

  return {
    rowNumber: rowIndex + 1,
    favorites: parseFavorites(rows[rowIndex][favoritesColumn]),
  };
}

export async function saveFavoritesByUsername(username, favorites) {
  const { api, spreadsheetId } = getSheetsClient();
  const { rows, usernameColumn, favoritesColumn } = await readRows();

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameColumn] || "").toLowerCase() === username.toLowerCase()
  );

  if (rowIndex === -1) return false;

  const columnLetter = columnToLetter(favoritesColumn + 1);
  const sheetName = getSheetName().replace(/'/g, "''");
  const range = `'${sheetName}'!${columnLetter}${rowIndex + 1}`;

  await api.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [ [JSON.stringify([...new Set(favorites)])] ],
    },
  });

  return true;
}

function parseComments(value) {
  if (!value) return [];

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The stored comments value is not valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("The stored comments value must be a JSON array.");
  }

  return parsed;
}

function isReviewEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    value.type === "review" &&
    (value.target === "game" || value.target === "site")
  );
}


const PROFANITY_PATTERNS = [
  /\b(?:fuck|fucking|fucker|shit|bitch|bastard|asshole|motherfucker|cunt|dickhead|nigger|retard)\b/i,
  /(?:\u0643\u0633(?:\u0645|\u0645\u0647|\u0645\u0647\u0627|\u0645\u0647\u0645)?|\u062e\u0648\u0644|\u0634\u0631\u0645\u0648\u0637(?:\u0629|\u0647)?|\u0645\u062a\u0646\u0627\u0643(?:\u0629|\u064a\u0646)?|\u0642\u062d\u0628\u0629|\u0639\u0631\u0635|\u0645\u0646\u064a\u0648\u0643|\u0637\u064a\u0632|\u0632\u0628\u0627\u0644\u0629)/i,
];
const MODERATION_ENTRY_TYPE = "community_moderation";
const MAX_PROFANITY_STRIKES = 3;

function normalizeCommunityText(value) {
  return String(value || "").toLowerCase().normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[0@]/g, "o").replace(/[1!]/g, "i")
    .replace(/[3]/g, "e").replace(/[$5]/g, "s")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ");
}

function locateUserRow(rows, usernameColumn, username) {
  return rows.findIndex((row, index) => index > 0 &&
    String(row[usernameColumn] || "").trim().toLowerCase() === String(username).trim().toLowerCase());
}

export async function getCommunityModerationState(username) {
  const { rows, usernameColumn, commentsColumn, statusColumn } = await readRows();
  const rowIndex = locateUserRow(rows, usernameColumn, username);
  if (rowIndex === -1) return null;
  const comments = parseComments(rows[rowIndex][commentsColumn]);
  const entry = comments.find((item) => item?.type === "community_moderation");
  return {
    banned: String(rows[rowIndex][statusColumn] || "").trim().toLowerCase() === "banned",
    strikes: Math.max(0, Number(entry?.profanityStrikes) || 0),
  };
}

export async function recordCommunityProfanityStrike(username) {
  const { api, spreadsheetId } = getSheetsClient();
  const { rows, usernameColumn, commentsColumn, statusColumn } = await readRows();
  const rowIndex = locateUserRow(rows, usernameColumn, username);
  if (rowIndex === -1) return null;
  const comments = parseComments(rows[rowIndex][commentsColumn]);
  let entry = comments.find((item) => item?.type === "community_moderation");
  if (!entry) {
    entry = { type: "community_moderation", profanityStrikes: 0 };
    comments.push(entry);
  }
  entry.profanityStrikes = Math.min(3, (Number(entry.profanityStrikes) || 0) + 1);
  entry.lastProfanityAt = new Date().toISOString();
  const banned = entry.profanityStrikes >= 3;
  const sheetName = getSheetName().replace(/'/g, "''");
  const ranges = [{
    range: "'" + sheetName + "'!" + columnToLetter(commentsColumn + 1) + (rowIndex + 1),
    values: [[JSON.stringify(comments)]],
  }];
  if (banned) ranges.push({
    range: "'" + sheetName + "'!" + columnToLetter(statusColumn + 1) + (rowIndex + 1),
    values: [["banned"]],
  });
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: "RAW", data: ranges },
  });
  return { banned, strikes: entry.profanityStrikes };
}

export async function checkCommunityText(username, text) {
  const state = await getCommunityModerationState(username);
  if (!state) return { allowed: false, status: 404, error: "Account was not found." };
  if (state.banned) return { allowed: false, status: 403, error: "Your account is banned from posting community messages." };
  const normalized = normalizeCommunityText(text);
  if (!PROFANITY_PATTERNS.some((pattern) => pattern.test(normalized))) return { allowed: true };
  const next = await recordCommunityProfanityStrike(username);
  if (!next) return { allowed: false, status: 404, error: "Account was not found." };
  return {
    allowed: false, status: next.banned ? 403 : 422, banned: next.banned,
    strikes: next.strikes, strikesRemaining: Math.max(0, 3 - next.strikes),
    error: next.banned ? "Your account was banned after 3 profanity violations." :
      "Your message contains profanity and was not posted. Warning " + next.strikes + "/3.",
  };
}

export async function addReviewReplyById(reviewId, username, reply) {
  const { api, spreadsheetId } = getSheetsClient();
  const { rows, usernameColumn, commentsColumn } = await readRows();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const owner = String(rows[rowIndex][usernameColumn] || "").trim();
    if (!owner) continue;
    const comments = parseComments(rows[rowIndex][commentsColumn]);
    const entry = comments.find((item) => isReviewEntry(item) && item.id === reviewId);
    if (!entry) continue;
    const replies = Array.isArray(entry.replies) ? entry.replies : [];
    if (replies.length >= 100) throw new Error("This review has reached its reply limit.");
    const savedReply = { id: randomUUID(), username, comment: reply, createdAt: new Date().toISOString() };
    entry.replies = [...replies, savedReply];
    await writeComments(api, spreadsheetId, commentsColumn, rowIndex, comments);
    return { review: { ...entry, username: owner }, reply: savedReply };
  }
  return null;
}

function writeComments(api, spreadsheetId, commentsColumn, rowIndex, comments) {
  const columnLetter = columnToLetter(commentsColumn + 1);
  const sheetName = getSheetName().replace(/'/g, "''");

  return api.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!${columnLetter}${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[JSON.stringify(comments)]],
    },
  });
}

export async function getReviews({ target, gameSlug } = {}) {
  const { rows, usernameColumn, commentsColumn } = await readRows();
  const reviews = [];

  for (const row of rows.slice(1)) {
    const username = String(row[usernameColumn] || "").trim();
    if (!username) continue;

    for (const entry of parseComments(row[commentsColumn])) {
      if (!isReviewEntry(entry)) continue;
      if (target && entry.target !== target) continue;
      if (gameSlug && entry.gameSlug !== gameSlug) continue;

      reviews.push({
        id: entry.id,
        target: entry.target,
        gameSlug: entry.gameSlug,
        gameTitle: entry.gameTitle,
        rating: entry.rating,
        comment: entry.comment,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        username,
        replies: Array.isArray(entry.replies) ? entry.replies : [],
        adminReply: entry.adminReply || "",
        featured: entry.featured === true,
      });
    }
  }

  return reviews
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || right.createdAt || "") -
        Date.parse(left.updatedAt || left.createdAt || "")
    )
    .slice(0, 500);
}

export async function saveReviewByUsername(username, review) {
  const { api, spreadsheetId } = getSheetsClient();
  const { rows, usernameColumn, commentsColumn } = await readRows();
  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameColumn] || "").trim().toLowerCase() ===
        username.trim().toLowerCase()
  );

  if (rowIndex === -1) return null;

  const comments = parseComments(rows[rowIndex][commentsColumn]);
  const existingIndex = comments.findIndex(
    (entry) =>
      isReviewEntry(entry) &&
      entry.target === review.target &&
      (review.target === "site" || entry.gameSlug === review.gameSlug)
  );
  const now = new Date().toISOString();
  const existing = existingIndex === -1 ? null : comments[existingIndex];
  const savedReview = {
    ...(existing || {}),
    ...review,
    id: existing?.id || review.id,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existingIndex === -1) {
    comments.push(savedReview);
  } else {
    comments[existingIndex] = savedReview;
  }

  await writeComments(api, spreadsheetId, commentsColumn, rowIndex, comments);
  return { ...savedReview, username: String(rows[rowIndex][usernameColumn]).trim() };
}

export async function getWalletBalanceByUsername(username) {
  const { rows, usernameColumn } = await readRows();
  const headers = rows[0].map((header) => String(header).trim().toLowerCase());
  const emailChangeExpiresColumn = headers.indexOf("email_change_expires_at");
  const walletColumn = headers.indexOf("wallet");

  if (emailChangeExpiresColumn !== 19 || walletColumn !== 20) {
    throw new Error(
      "Google Sheet must have a wallet header in column U, immediately after email_change_expires_at."
    );
  }

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameColumn] || "").trim().toLowerCase() ===
        username.trim().toLowerCase()
  );

  if (rowIndex === -1) return null;

  const emailColumn = headers.indexOf("email");
  const nameColumn = headers.indexOf("name");
  const rawBalance = String(rows[rowIndex][walletColumn] ?? "").trim();
  const balance = rawBalance === "" ? 0 : Number(rawBalance);

  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("The wallet balance in Google Sheets is invalid.");
  }

  return {
    balance,
    email: String(rows[rowIndex][emailColumn] || "").trim(),
    name: String(rows[rowIndex][nameColumn] || "").trim(),
  };
}

function columnToLetter(column) {
  let result = "";

  while (column > 0) {
    const remainder = (column - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    column = Math.floor((column - 1) / 26);
  }

  return result;
}
