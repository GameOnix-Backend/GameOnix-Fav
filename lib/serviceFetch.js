const SERVICE_ORIGINS = {
  auth: [
    "https://gameonix-backend-2.vercel.app",
    "https://gameonix-backend.vercel.app",
  ],
  fav: [
    "https://gameonix-fav-2.vercel.app",
    "https://gameonixfav.vercel.app",
  ],
};

function shouldRetry(response, method) {
  return response.status === 402 ||
    (response.status === 429 && ["GET", "HEAD", "OPTIONS"].includes(method)) ||
    (["GET", "HEAD", "OPTIONS"].includes(method) && response.status >= 500);
}

export async function fetchReplica(service, target, options = {}, timeoutMs = 8000) {
  const origins = SERVICE_ORIGINS[service];
  if (!origins) throw new Error("Unknown GameOnix API service.");

  const targetUrl = target instanceof URL
    ? target
    : new URL(String(target), origins[0]);
  const path = targetUrl.pathname + targetUrl.search;
  // Keep normal traffic on the replica while the former primary is at its
  // Fluid CPU limit; retry a platform-disabled response on the other origin.
  const firstIndex = 0;
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
