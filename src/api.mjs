/** The control-plane, over `fetch`. No dependency, and every failure comes back as one readable line. */

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** An error body turned into something a person reads in a terminal. */
function readable(body, fallback) {
  const detail = body?.detail ?? body;
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  if (Array.isArray(detail?.errors)) return detail.errors.join("; ");
  if (Array.isArray(detail)) {
    return detail.map((d) => (typeof d === "string" ? d : d?.msg ?? JSON.stringify(d))).join("; ");
  }
  return detail ? JSON.stringify(detail) : fallback;
}

export async function request(host, path, { method = "GET", body, token } = {}) {
  let res;
  try {
    res = await fetch(host.replace(/\/$/, "") + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, `could not reach ${host}: ${e.message}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let parsed;
  let isJson = true;
  if (text) { try { parsed = JSON.parse(text); } catch { isJson = false; } }
  if (!res.ok) {
    // A gateway answering 502 sends HTML, not JSON. Printing the raw page into a terminal helps nobody.
    const stripped = String(text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw new ApiError(res.status, isJson ? readable(parsed, res.statusText) : (stripped || res.statusText), parsed);
  }
  return parsed ?? null;
}
