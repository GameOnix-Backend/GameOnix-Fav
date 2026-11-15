import jwt from "jsonwebtoken";
import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import {
  createWalletNotification,
  deleteGameRequestNotification,
  deleteAllWalletNotifications,
  deleteWalletNotification,
  getWalletNotifications,
  getSupportReports,
  markAllWalletNotificationsRead,
  markWalletNotificationRead,
  updateGameRequestNotification,
} from "../../lib/wallet-notifications.js";
import { getWalletTransactions } from "../../lib/wallet-ledger.js";
import { sendGameRequestReplyEmail } from "../../lib/wallet-mailer.js";

function enrichLegacyNotificationDetails(notifications, transactions) {
  return notifications.map((notification) => {
    if (
      notification.details ||
      (!/top.?up/i.test(notification.title) &&
        notification.type !== "top_up_request")
    ) {
      return notification;
    }

    const amountMatch = notification.message.match(
      /EGP\s*([\d,]+(?:\.\d{1,2})?)/i
    );
    const amount = amountMatch
      ? Number(amountMatch[1].replace(/,/g, ""))
      : NaN;
    if (!Number.isFinite(amount)) return notification;

    const methodMatch = notification.message.match(
      /\bvia\s+(.+?)(?:\s+was\b|[.!?]|$)/i
    );
    const paymentMethod = methodMatch?.[1]?.trim();
    const title = notification.title.toLowerCase();
    const terminalStatus = title.includes("approv")
      ? "approved"
      : title.includes("cancel")
        ? "cancelled"
        : null;

    const candidates = transactions.filter((transaction) => {
      if (
        transaction.type !== "top_up_request" ||
        Math.round(transaction.amount * 100) !== Math.round(amount * 100) ||
        (terminalStatus &&
          transaction.status.toLowerCase() !== terminalStatus)
      ) {
        return false;
      }

      try {
        const details = JSON.parse(transaction.description);
        return (
          details &&
          typeof details === "object" &&
          (!paymentMethod ||
            String(details.paymentMethod || "").toLowerCase() ===
              paymentMethod.toLowerCase())
        );
      } catch {
        return false;
      }
    });

    if (candidates.length !== 1) return notification;

    const transaction = candidates[0];
    const details = JSON.parse(transaction.description);
    return {
      ...notification,
      details: {
        requestId: transaction.id,
        amount: transaction.amount,
        email: details.email || "Not provided",
        paymentMethod: details.paymentMethod || "Not provided",
        mobileNumber: details.mobileNumber || "Not provided",
        whatsappNumber: details.whatsappNumber || "Not provided",
        currentBalance: details.currentBalance,
        status: transaction.status.toLowerCase(),
      },
    };
  });
}

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

function getNotificationAdmins() {
  return new Set(
    String(process.env.GAMEONIX_NOTIFICATION_ADMIN_USERNAMES || "")
      .split(",")
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isSheetsRateLimitError(error) {
  const status = Number(error?.response?.status ?? error?.code);
  const reasons = Array.isArray(error?.errors)
    ? error.errors.map((item) => item.reason)
    : [];
  return (
    status === 429 ||
    (status === 403 &&
      reasons.some((reason) =>
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason)
      ))
  );
}

function createAdminActionToken(username) {
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Admin actions are not configured.");
  }

  return jwt.sign(
    { purpose: "admin-password-reset-link", username },
    secret,
    {
      algorithm: "HS256",
      expiresIn: "60s",
      issuer: "gameonix-community-api",
      audience: "gameonix-admin-action",
    }
  );
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  try {
    if (req.method === "GET" && req.query?.admin === "reports") {
      if (!getNotificationAdmins().has(username.toLowerCase())) {
        return res.status(403).json({ error: "Admin access is required." });
      }
      const reports = await getSupportReports();
      return res.status(200).json({ reports, canSend: true });
    }

    if (req.method === "DELETE") {
      const { notificationId, deleteAll } = getRequestBody(req);
      if (deleteAll === true) {
        const deletedCount = await deleteAllWalletNotifications(username);
        return res.status(200).json({ success: true, deletedCount });
      }

      if (typeof notificationId !== "string" || !notificationId.trim()) {
        return res.status(400).json({
          error: "A valid notification ID is required.",
        });
      }

      const deleted = await deleteWalletNotification(
        username,
        notificationId.trim()
      );
      if (!deleted) {
        return res.status(404).json({ error: "Notification was not found." });
      }

      return res.status(200).json({ success: true });
    }

    if (req.method === "GET") {
      let notifications = await getWalletNotifications(username);
      if (
        notifications.some(
          (notification) =>
            !notification.details && /top.?up/i.test(notification.title)
        )
      ) {
        const transactions = await getWalletTransactions(username);
        notifications = enrichLegacyNotificationDetails(
          notifications,
          transactions
        );
      }
      return res.status(200).json({
        notifications,
        canSend: getNotificationAdmins().has(username.toLowerCase()),
        unreadCount: notifications.filter(
          (notification) => !notification.readAt
        ).length,
      });
    }

    const body = getRequestBody(req);
    if (body.action === "delete-game-request") {
      if (!getNotificationAdmins().has(username.toLowerCase())) {
        return res.status(403).json({ error: "Admin access is required." });
      }

      const notificationId =
        typeof body.notificationId === "string"
          ? body.notificationId.trim()
          : "";
      if (!notificationId || notificationId.length > 100) {
        return res.status(400).json({
          error: "A valid game request ID is required.",
        });
      }

      const deleted = await deleteGameRequestNotification({
        username,
        notificationId,
      });
      if (!deleted) {
        return res.status(404).json({ error: "Game request was not found." });
      }

      return res.status(200).json({
        success: true,
        message: "Game request deleted.",
      });
    }

    if (body.action === "update-game-request") {
      if (!getNotificationAdmins().has(username.toLowerCase())) {
        return res.status(403).json({ error: "Admin access is required." });
      }

      const notificationId =
        typeof body.notificationId === "string"
          ? body.notificationId.trim()
          : "";
      const status = body.status;
      const replyInput =
        typeof body.reply === "string"
          ? body.reply.replace(/\r\n?/g, "\n").trim()
          : "";
      if (
        !notificationId ||
        notificationId.length > 100 ||
        !["pending", "accepted", "rejected"].includes(status) ||
        (body.reply !== undefined &&
          (typeof body.reply !== "string" || body.reply.length > 2000))
      ) {
        return res.status(400).json({
          error: "Enter a valid game request status and reply.",
        });
      }

      let reply = "";
      let alreadyNotified = false;
      let emailAlreadySent = false;
      const statusUpdatedAt = new Date().toISOString();
      const updatedRequest = await updateGameRequestNotification({
        username,
        notificationId,
        updateDetails: (current) => {
          const gameTitle =
            typeof current.gameTitle === "string" ? current.gameTitle : "";
          const requesterUsername =
            typeof current.username === "string" ? current.username : "";
          const email =
            typeof current.email === "string"
              ? current.email.trim().toLowerCase()
              : "";
          const platform =
            typeof current.platform === "string" ? current.platform : "";
          if (
            !gameTitle ||
            !requesterUsername ||
            !platform ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          ) {
            throw new Error("Game request contact details are invalid.");
          }

          reply =
            status === "pending"
              ? replyInput
              : replyInput || `Your request for ${gameTitle} was ${status}.`;
          const previousStatus = ["pending", "accepted", "rejected"].includes(
            current.status
          )
            ? current.status
            : "pending";
          const previousNotificationSentAt =
            typeof current.notificationSentAt === "string"
              ? current.notificationSentAt
              : "";
          alreadyNotified =
            status !== "pending" &&
            previousStatus === status &&
            current.reply === reply &&
            Boolean(previousNotificationSentAt) &&
            Boolean(current.replyNotificationId);
          const previousEmailSentAt =
            typeof current.emailSentAt === "string"
              ? current.emailSentAt
              : !Object.hasOwn(current, "emailSentAt") && alreadyNotified
                ? previousNotificationSentAt
                : "";
          emailAlreadySent = alreadyNotified && Boolean(previousEmailSentAt);

          return {
            ...current,
            status,
            reply,
            statusUpdatedAt,
            notificationSentAt:
              status === "pending"
                ? ""
                : alreadyNotified
                  ? previousNotificationSentAt
                  : "",
            emailSentAt:
              status === "pending"
                ? ""
                : alreadyNotified
                  ? previousEmailSentAt
                  : "",
            replyNotificationId:
              status === "pending"
                ? ""
                : alreadyNotified
                  ? String(current.replyNotificationId || "")
                  : "",
          };
        },
      });
      if (!updatedRequest) {
        return res.status(404).json({ error: "Game request was not found." });
      }

      if (status === "pending") {
        return res.status(200).json({
          success: true,
          message: "Game request status saved.",
          notificationSentAt: "",
          emailSentAt: "",
        });
      }
      const request = updatedRequest.details;
      let notificationSentAt = String(request.notificationSentAt || "");
      let emailSentAt = String(request.emailSentAt || "");

      if (alreadyNotified && emailAlreadySent) {
        return res.status(200).json({
          success: true,
          message: "Status saved; the player was already notified in GameOnix and by email.",
          notificationSentAt,
          emailSentAt,
        });
      }

      let playerNotification;
      if (!alreadyNotified) {
        try {
          playerNotification = await createWalletNotification({
            username: request.username,
            title: `Your game request was ${status}`,
            message: reply,
            type: "game_request_reply",
            details: {
              gameTitle: request.gameTitle,
              platform: request.platform,
              status,
              reply,
              requestId: request.requestId || notificationId,
            },
          });

          notificationSentAt = new Date().toISOString();
          const deliveryRecorded = await updateGameRequestNotification({
            username,
            notificationId,
            updateDetails: (current) => ({
              ...current,
              notificationSentAt,
              emailSentAt: "",
              replyNotificationId: playerNotification.id,
            }),
          });
          if (!deliveryRecorded) {
            throw new Error(
              "The game request disappeared before the in-app notification was recorded."
            );
          }
        } catch (error) {
          console.error("Game request in-app reply delivery failed:", error);
          if (playerNotification) {
            try {
              await deleteWalletNotification(
                request.username,
                playerNotification.id
              );
            } catch (cleanupError) {
              console.error(
                "Failed to clean up unrecorded game request notification:",
                cleanupError
              );
            }
          }

          return res.status(502).json({
            error:
              "The status was saved, but we could not save the in-app notification. Try saving again.",
          });
        }
      }

      if (!emailAlreadySent) {
        try {
          await sendGameRequestReplyEmail({
            gameTitle: request.gameTitle,
            platform: request.platform,
            status,
            reply,
            username: request.username,
            to: request.email,
          });
        } catch (error) {
          console.error("Game request reply email failed:", error);
          return res.status(200).json({
            success: true,
            message:
              "Status and in-app notification were saved, but email delivery failed. Check the email configuration and save again to retry without sending a duplicate in-app notification.",
            notificationSentAt,
            emailSentAt: "",
          });
        }

        emailSentAt = new Date().toISOString();
        const emailDeliveryRecorded = await updateGameRequestNotification({
          username,
          notificationId,
          updateDetails: (current) => ({
            ...current,
            emailSentAt,
          }),
        });
        if (!emailDeliveryRecorded) {
          console.error(
            "Game request email was sent, but its delivery record could not be saved."
          );
          return res.status(502).json({
            error:
              "The player was notified in GameOnix and by email, but the email delivery record could not be saved. Check before retrying.",
            notificationSentAt,
            emailSentAt: "",
          });
        }
      }

      return res.status(200).json({
        success: true,
        message:
          "Status saved and the player was notified by email and in GameOnix.",
        notificationSentAt,
        emailSentAt,
      });
    }
    if (body.action === "send-password-reset-link") {
      if (!getNotificationAdmins().has(username.toLowerCase())) {
        return res.status(403).json({ error: "Admin access is required." });
      }

      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }

      const token = createAdminActionToken(username);
      const response = await fetch(
        "https://gameonix-backend.vercel.app/api/auth/forgot-password",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action: "admin-reset-link", email }),
          signal: AbortSignal.timeout(8000),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error(
          "Admin password reset request failed:",
          data.error || response.status
        );
        return res.status(502).json({
          error: "Unable to send the password reset link. Please try again.",
        });
      }

      return res.status(200).json({
        success: true,
        message:
          "If an active account uses that email, a secure reset link was sent.",
      });
    }

    if (body.action === "send") {
      if (!getNotificationAdmins().has(username.toLowerCase())) {
        return res.status(403).json({ error: "Admin access is required." });
      }

      const recipientUsername =
        typeof body.username === "string" ? body.username.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      const imageData =
        typeof body.imageData === "string" ? body.imageData : "";
      const hasInvalidImageData =
        body.imageData !== undefined &&
        body.imageData !== null &&
        typeof body.imageData !== "string";

      if (
        !recipientUsername ||
        recipientUsername.length > 64 ||
        !/^[a-zA-Z0-9._-]+$/.test(recipientUsername) ||
        !title ||
        title.length > 100 ||
        !message ||
        message.length > 2000 ||
        hasInvalidImageData ||
        (imageData &&
          (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData) ||
            imageData.length > 44000))
      ) {
        return res.status(400).json({
          error: "Enter a valid recipient, title, message, and image.",
        });
      }

      const notification = await createWalletNotification({
        username: recipientUsername,
        title,
        message,
        type: "direct_message",
        details: imageData ? { imageData } : null,
      });
      return res.status(201).json({ success: true, notification });
    }

    const { notificationId, markAll } = body;
    if (markAll === true) {
      await markAllWalletNotificationsRead(username);
      return res.status(200).json({ success: true });
    }

    if (typeof notificationId !== "string" || !notificationId.trim()) {
      return res.status(400).json({
        error: "A valid notification ID is required.",
      });
    }

    const result = await markWalletNotificationRead(
      username,
      notificationId.trim()
    );
    if (!result) {
      return res.status(404).json({ error: "Notification was not found." });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Wallet notifications request failed:", error);
    if (isSheetsRateLimitError(error)) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({
        error: "Notifications are temporarily rate-limited. Please try again shortly.",
      });
    }
    return res.status(500).json({
      error: "Unable to load or update your notifications.",
    });
  }
}
