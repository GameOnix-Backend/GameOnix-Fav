import {
  approveWalletPurchaseRequest,
  cancelWalletPurchaseRequest,
  readPurchaseRow,
} from "./wallet-ledger.js";
import { createWalletNotification } from "./wallet-notifications.js";
import { sendWalletPurchaseStatusEmail } from "./wallet-mailer.js";

function formatCurrency(value) {
  return Number(value || 0).toFixed(2);
}

function buildNotification({ action, result, status }) {
  const approved = action === "approve";
  const orderLabel = `${result.details.gameName} · ${result.details.packageName}`;
  const giftCardNote = result.details.isGiftCard
    ? " Your gift card codes are shown in this notification and were also emailed to you."
    : "";
  // Gift card codes stay in the notification for the player who bought them;
  // game top-up orders never have any.
  const notificationDetails = { ...result.details };
  if (notificationDetails.isGiftCard !== true) {
    delete notificationDetails.giftCardCodes;
  }

  return {
    username: result.username,
    title: approved ? "Game purchase approved" : "Game purchase rejected",
    message: approved
      ? result.chargedFromWallet
        ? `${orderLabel} was approved. EGP ${formatCurrency(result.amount)} was deducted from your wallet.${giftCardNote}`
        : `${orderLabel} was approved using ${result.details.paymentMethod}. No wallet funds were deducted.${giftCardNote}`
      : `${orderLabel} was rejected. No money was deducted.`,
    type: "game_purchase",
    details: {
      ...notificationDetails,
      requestId: result.id,
      amount: result.amount,
      email: result.details?.email || "Not provided",
      paymentMethod: result.details?.paymentMethod || "",
      mobileNumber: result.details?.mobileNumber || "",
      currentBalance: approved ? result.balance : undefined,
      status,
    },
  };
}

function buildDecisionMessage({ action, result, status, emailSent }) {
  const giftCardDeliveryMessage = result.details?.isGiftCard
    ? emailSent
      ? ` Gift card codes were saved to wallet history and emailed to ${result.details.contactEmail || result.details.email}.`
      : " Gift card codes were saved to wallet history, but email delivery failed."
    : "";

  if (action !== "approve") {
    return `The purchase request for ${result.username} was rejected. No funds were deducted.`;
  }

  return result.chargedFromWallet
    ? `Purchase approved. ${result.details.gameName} · ${result.details.packageName} was deducted from ${result.username}'s wallet. New balance: ${formatCurrency(result.balance)} EGP.${giftCardDeliveryMessage}`
    : `Purchase approved using ${result.details.paymentMethod}. No wallet funds were deducted.${giftCardDeliveryMessage}`;
}

/**
 * Approves or rejects a pending product (game card / gift card) purchase request.
 * Mirrors the decision side effects of the emailed admin action link:
 * wallet deduction, in-app notification, and the player status email.
 */
export async function applyPurchaseDecision({
  requestId,
  action,
  giftCardCodes = [],
}) {
  // One read of the ledger row, reused by the approval/cancellation below.
  const request = await readPurchaseRow(requestId);
  if (request.missing) return { kind: "missing" };
  if (request.status !== "pending") {
    return { kind: "unavailable", status: request.status };
  }

  const result =
    action === "approve"
      ? await approveWalletPurchaseRequest({
          id: requestId,
          username: request.username,
          prefetched: request,
          giftCardCodes,
        })
      : await cancelWalletPurchaseRequest({
          id: requestId,
          username: request.username,
          prefetched: request,
        });

  if (!result) return { kind: "missing" };
  if (result.unavailable) {
    return { kind: "unavailable", status: result.status };
  }
  if (result.changed) return { kind: "changed" };
  if (result.insufficientFunds) {
    return { kind: "insufficientFunds", balance: result.balance };
  }

  const status =
    action === "approve"
      ? result.chargedFromWallet
        ? "completed"
        : "approved"
      : "rejected";

  let notificationCreated = true;
  try {
    const notification = buildNotification({ action, result, status });
    await createWalletNotification(notification);
  } catch (notificationError) {
    notificationCreated = false;
    console.error(
      "Wallet purchase decision notification failed:",
      notificationError
    );
  }

  let emailSent = false;
  try {
    await sendWalletPurchaseStatusEmail({
      email: result.details?.contactEmail || result.details?.email,
      username: result.username,
      requestId: result.id,
      amount: result.amount,
      currentBalance: result.balance,
      details: result.details,
      status,
    });
    emailSent = true;
  } catch (emailError) {
    console.error("Wallet purchase decision email failed:", emailError);
  }

  const message = [
    buildDecisionMessage({ action, result, status, emailSent }),
    !notificationCreated &&
      "However, the player's in-app notification could not be created.",
    !emailSent && !(result.details?.isGiftCard)
      ? "The request was processed, but the confirmation email could not be sent."
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    kind: "done",
    status,
    message,
    notificationCreated,
    emailSent,
    balance: result.balance,
    request: {
      id: result.id,
      username: result.username,
      amount: result.amount,
      status,
      createdAt: request.createdAt,
    },
  };
}
