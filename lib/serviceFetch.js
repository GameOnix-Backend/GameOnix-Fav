const SERVICE_ORIGINS = {
  auth: [
    "https://gameonix-backend.vercel.app",
    "https://gameonix-backend-2.vercel.app",
  ],
  fav: [
    "https://gameonixfav.vercel.app",
    "https://gameonix-fav-2.vercel.app",
  ],
};

function shouldRetry(response, method) {
  return response.status === 429 ||
    (["GET", "HEAD", "OPTIONS"].includes(method) && response.status >= 500);
}

export async function fetchReplica(service, target, options = {}, timeoutMs = 8000) {
  const origins = SERVICE_ORIGINS[service];
  if (!origins) throw new Error("Unknown GameOnix API service.");

  const targetUrl = target instanceof URL
    ? target
    : new URL(String(target), origins[0]);
  const path = targetUrl.pathname + targetUrl.search;
  const firstIndex = Math.random() < 0.5 ? 0 : 1;
  const orderedOrigins = [origins[firstIndex], origins[1 - firstIndex]];
  const method = String(options.method || "GET").toUpperCase();
  let firstError;

  for (let index = 0; index < orderedOrigins.length; index += 1) {
    const attemptOptions = { ...options };
    if (timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      attemptOptions.signal = AbortSignal.timeout(timeoutMs);
    }

    try {
      const response = await fetch(new URL(path, orderedOrigins[index]), attemptOptions);
      if (index === 0 && shouldRetry(response, method)) continue;
      return response;
    } catch (error) {
      firstError ||= error;
      if (index === 0 && ["GET", "HEAD", "OPTIONS"].includes(method)) continue;
      throw error;
    }
  }

  throw firstError || new Error("All GameOnix API replicas are unavailable.");
}
