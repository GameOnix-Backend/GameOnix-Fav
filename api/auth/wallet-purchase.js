import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import { getWalletBalanceByUsername } from "../../lib/sheets.js";
import {
  createWalletPurchaseRequest,
  getWalletPurchaseRequests,
  isWalletSheetQuotaError,
} from "../../lib/wallet-ledger.js";
import {
  sendWalletPurchaseRequestEmail,
  sendWalletPurchaseStatusEmail,
} from "../../lib/wallet-mailer.js";
import { createWalletNotification } from "../../lib/wallet-notifications.js";
import { applyPurchaseDecision } from "../../lib/purchase-decisions.js";

const CATALOG_URL =
  "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-Content/main/recharge.json";
const PAYMENTS_URL =
  "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-Content/main/payments.json";
const RAW_ASSET_BASE =
  "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-Content/main/";

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

function getGameIcon(image) {
  if (typeof image !== "string" || !image.trim()) return "";
  const path = image.trim();
  const url = /^https?:\/\//i.test(path)
    ? path
    : RAW_ASSET_BASE + path.replace(/^(\.\.\/)+|^\/+/g, "");
  return url.replace(/[^/]+$/, (filename) =>
    filename.replace(/\.[^.]+$/, "").replace(/-icon$/, "") + "-icon.webp"
  );
}

function isValidOptionalText(value, maxLength = 120) {
  return typeof value === "string" && value.trim().length <= maxLength;
}

const DECISION_ACTIONS = new Set([
  "approve-purchase-request",
  "reject-purchase-request",
]);

function getAdminUsernames() {
  return new Set(
    String(process.env.GAMEONIX_NOTIFICATION_ADMIN_USERNAMES || "")
      .split(",")
      .map((adminUsername) => adminUsername.trim().toLowerCase())
      .filter(Boolean)
  );
}

function requireAdmin(req, res) {
  const username = requireUser(req, res);
  if (!username) return null;

  if (!getAdminUsernames().has(username.toLowerCase())) {
    res.status(403).json({ error: "Admin access is required." });
    return null;
  }

  return username;
}

function sendWalletQuotaError(res) {
  res.setHeader("Retry-After", "60");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  return res.status(429).json({
    error:
      "Google Sheets is rate limited (60 reads per minute per user). Wait about a minute, then try again.",
  });
}

async function handleProductRequestList(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const requests = await getWalletPurchaseRequests();
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({ success: true, requests });
  } catch (error) {
    if (isWalletSheetQuotaError(error)) return sendWalletQuotaError(res);
    console.error("Wallet product request list failed:", error);
    return res
      .status(500)
      .json({ error: "Unable to load product requests." });
  }
}

async function handleProductRequestDecision(req, res, body) {
  if (!requireAdmin(req, res)) return;

  const { action, requestId, giftCardCodes } = body;
  if (typeof requestId !== "string" || !requestId.trim()) {
    return res.status(400).json({ error: "The product request id is required." });
  }
  if (
    giftCardCodes !== undefined &&
    (!Array.isArray(giftCardCodes) ||
      giftCardCodes.some(
        (code) => typeof code !== "string" || code.length > 200
      ))
  ) {
    return res.status(400).json({ error: "The gift card codes are invalid." });
  }

  try {
    const result = await applyPurchaseDecision({
      requestId: requestId.trim(),
      action: action === "approve-purchase-request" ? "approve" : "reject",
      giftCardCodes: Array.isArray(giftCardCodes) ? giftCardCodes : [],
    });

    if (result.kind === "missing") {
      return res
        .status(404)
        .json({ error: "This product request was not found." });
    }
    if (result.kind === "unavailable") {
      return res.status(409).json({
        error: `This request is no longer pending. Current status: ${result.status || "unknown"}.`,
      });
    }
    if (result.kind === "changed") {
      return res.status(409).json({
        error: "The request details changed. Refresh the list and review it again.",
      });
    }
    if (result.kind === "insufficientFunds") {
      return res.status(409).json({
        error: `Insufficient wallet balance (EGP ${Number(result.balance || 0).toFixed(2)}). No money was deducted.`,
      });
    }

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      status: result.status,
      message: result.message,
      notificationCreated: result.notificationCreated,
      emailSent: result.emailSent,
      balance: result.balance,
      request: result.request,
    });
  } catch (error) {
    if (isWalletSheetQuotaError(error)) return sendWalletQuotaError(res);

    const message =
      typeof error?.message === "string" && error.message.trim()
        ? error.message.trim()
        : "Unable to process this product request.";
    console.error("Wallet product request decision failed:", error);
    return res
      .status(/gift card/i.test(message) ? 400 : 500)
      .json({ error: message });
  }
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (req.method === "GET") {
    return handleProductRequestList(req, res);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = getRequestBody(req);
  if (DECISION_ACTIONS.has(body.action)) {
    return handleProductRequestDecision(req, res, body);
  }
  if (typeof body.action === "string" && body.action.trim()) {
    return res.status(400).json({ error: "Unsupported product request action." });
  }

  const username = requireUser(req, res);
  if (!username) return;
  const {
    productId,
    packIndex,
    quantity,
    paymentMethod,
    mobileNumber = "",
    whatsappNumber = "",
    playerId = "",
    serverId = "",
    contactEmail = "",
    isGift = false,
    recipient = "",
  } = body;

  if (
    typeof productId !== "string" ||
    !productId.trim() ||
    typeof paymentMethod !== "string" ||
    !paymentMethod.trim() ||
    !Number.isInteger(packIndex) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 99 ||
    typeof isGift !== "boolean" ||
    !isValidOptionalText(playerId) ||
    !isValidOptionalText(mobileNumber) ||
    typeof whatsappNumber !== "string" ||
    !/^[+\d][\d\s()-]{5,28}$/.test(whatsappNumber.trim()) ||
    !isValidOptionalText(serverId) ||
    !isValidOptionalText(contactEmail, 254) ||
    (contactEmail.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) ||
    !isValidOptionalText(recipient)
  ) {
    return res.status(400).json({ error: "Enter valid game order details." });
  }

  try {
    const [account, catalogResponse, paymentsResponse] = await Promise.all([
      getWalletBalanceByUsername(username),
      fetch(CATALOG_URL, { cache: "no-store" }),
      fetch(PAYMENTS_URL, { cache: "no-store" }),
    ]);
    if (!account) {
      return res.status(404).json({ error: "Wallet account was not found." });
    }
    if (!catalogResponse.ok) {
      throw new Error(`Game catalog request failed (${catalogResponse.status}).`);
    }
    if (!paymentsResponse.ok) {
      throw new Error(`Payment methods request failed (${paymentsResponse.status}).`);
    }

    const [catalog, paymentMethods] = await Promise.all([
      catalogResponse.json(),
      paymentsResponse.json(),
    ]);
    if (!Array.isArray(catalog) || !Array.isArray(paymentMethods)) {
      throw new Error("The game catalog or payment methods format is invalid.");
    }
    const isWalletPayment = paymentMethod.trim().toLowerCase() === "wallet";
    const selectedPayment = isWalletPayment
      ? { name: "Wallet", logo: "", av: true }
      : paymentMethods.find(
          (method) =>
            String(method?.name || "").trim().toLowerCase() ===
            paymentMethod.trim().toLowerCase()
        );
    if (!selectedPayment?.av) {
      return res.status(400).json({
        error: "The selected payment method is unavailable. Refresh and try again.",
      });
    }
    if (
      !isWalletPayment &&
      selectedPayment["mobile-number"] &&
      !mobileNumber.trim()
    ) {
      return res.status(400).json({
        error: "Enter the mobile number required by the selected payment method.",
      });
    }
    const product = catalog.find(
      (item) => String(item?.id || "") === productId.trim()
    );
    const pack = product?.packs?.[packIndex];
    const unitPrice = Number(pack?.price);
    if (
      !product ||
      product.able === false ||
      !pack ||
      pack.able === false ||
      !Number.isFinite(unitPrice) ||
      unitPrice <= 0 ||
      !Number.isFinite(unitPrice * quantity) ||
      unitPrice * quantity > 100000
    ) {
      return res.status(400).json({
        error: "This game package is no longer available. Refresh the store and try again.",
      });
    }
    const total = Math.round(unitPrice * quantity * 100) / 100;
    const productType = String(product.type || "").trim().toLowerCase();
    const isGiftCard =
      productType === "gift card" || productType === "gift cards";
    const playerAccount = isGift ? recipient.trim() : playerId.trim();
    if (!isGiftCard && !playerAccount) {
      return res.status(400).json({
        error: isGift
          ? "Enter the gift recipient's player or account ID."
          : "Enter your player or account ID.",
      });
    }
    const giftCardDeliveryEmail = isGift
      ? contactEmail.trim()
      : String(account.email || "").trim();
    if (
      isGiftCard &&
      (!giftCardDeliveryEmail ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(giftCardDeliveryEmail))
    ) {
      return res.status(400).json({
        error: isGift
          ? "A valid recipient email is required to send Gift Card codes."
          : "A valid account email is required to receive Gift Card codes.",
      });
    }
    if (isWalletPayment && account.balance < total) {
      return res.status(409).json({
        error: `Insufficient wallet balance. Available: EGP ${Number(account.balance).toFixed(2)}.`,
      });
    }

    const details = {
      gameId: String(product.id),
      gameName: String(product.name || product.title || product.id),
      gameIcon: getGameIcon(product.image),
      packageName: `${String(pack.title || "")}${pack.type ? ` ${String(pack.type)}` : ""}`.trim(),
      packageTitle: String(pack.title || ""),
      packageType: String(pack.type || ""),
      // "Top-Up" for game recharge packs, "Gift Cards" for redeemable codes.
      productType: String(product.type || "").trim(),
      isGiftCard,
      quantity,
      paymentMethod: selectedPayment.name,
      paymentMethodLogo: String(selectedPayment.logo || ""),
      walletPayment: isWalletPayment,
      mobileNumber: mobileNumber.trim(),
      whatsappNumber: whatsappNumber.trim(),
      playerId: isGift ? "" : playerId.trim(),
      serverId: serverId.trim(),
      isGift,
      recipient: isGift ? recipient.trim() : "",
      email: account.email || "",
      contactEmail: giftCardDeliveryEmail || contactEmail.trim() || account.email || "",
    };

    const request = await createWalletPurchaseRequest({
      username,
      amount: total,
      details,
    });
    const message = `${details.gameName} · ${details.packageName} × ${quantity} (${`EGP ${total.toFixed(2)}`}) is waiting for approval. No funds have been deducted yet.`;
    const results = await Promise.allSettled([
      createWalletNotification({
        username,
        title: "Game purchase request submitted",
        message,
        type: "game_purchase",
        details: {
          ...details,
          requestId: request.id,
          amount: total,
          currentBalance: account.balance,
          status: "pending",
        },
      }),
      sendWalletPurchaseRequestEmail({
        requestId: request.id,
        username,
        email: account.email || "",
        amount: total,
        currentBalance: account.balance,
        details,
      }),
      details.contactEmail
        ? sendWalletPurchaseStatusEmail({
              email: details.contactEmail,
            username,
            requestId: request.id,
            amount: total,
            details,
            status: "submitted",
          })
        : Promise.reject(new Error("No account email is available.")),
    ]);
    const [notificationResult, adminEmailResult, userEmailResult] = results;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Game purchase request side effect ${index + 1} failed:`, result.reason);
      }
    });

    return res.status(201).json({
      success: true,
      request: {
        id: request.id,
        type: "purchase_request",
        description: JSON.stringify(details),
        amount: total,
        status: "pending",
        createdAt: request.createdAt,
      },
      notificationCreated: notificationResult.status === "fulfilled",
      adminEmailSent: adminEmailResult.status === "fulfilled",
      userEmailSent: userEmailResult.status === "fulfilled",
    });
  } catch (error) {
    if (isWalletSheetQuotaError(error)) return sendWalletQuotaError(res);
    console.error("Game wallet purchase request failed:", error);
    return res.status(500).json({
      error: error.message || "Unable to submit this game purchase request.",
    });
  }
}
