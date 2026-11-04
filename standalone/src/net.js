/*
 * Network requests with a deadline, shared by the price and card-reading integrations.
 *
 * `fetchJSON(url, {timeoutMs, fetch, ...fetchOptions})` makes one request and reads its JSON body within
 * one deadline: a server that never sends headers, or sends headers and then stalls the body, fails with
 * a timeout error instead of leaving the screen waiting forever. On the deadline the underlying request is
 * aborted (AbortController) and the timer is always cleared, on success, error or timeout.
 *
 * -> {res, ok, status, body} where body is the parsed JSON, or null when the body isn't JSON.
 * A network failure rejects with the fetch's own error; the deadline rejects with a TimeoutError
 * (`isTimeout(err)` is true for it).
 *
 * Works in browsers and in Node (tests inject `fetch`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Net = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 15000;

  function timeoutError(timeoutMs) {
    const err = new Error(`No answer within ${Math.round(timeoutMs / 1000)} s.`);
    err.name = "TimeoutError";
    err.code = "ETIMEDOUT";
    err.timeout = true;
    err.timeoutMs = timeoutMs;
    return err;
  }

  const isTimeout = (err) => !!err && (err.timeout === true || err.name === "TimeoutError");

  async function fetchJSON(url, opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetch: injected, ...init } = opts;
    const F = injected || (typeof fetch === "function" ? fetch : null);
    if (!F) throw new Error("No network available.");
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    let timedOut = null;
    // One deadline for the headers and the body together.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = timeoutError(timeoutMs);
        reject(timedOut);
        if (ctrl) { try { ctrl.abort(timedOut); } catch (err) { /* already finished */ } }
      }, timeoutMs);
    });
    deadline.catch(() => {});   // handled by the races below; never an unhandled rejection
    try {
      let res;
      try {
        res = await Promise.race([F(url, ctrl ? { ...init, signal: ctrl.signal } : init), deadline]);
      } catch (err) {
        throw timedOut || err;
      }
      let body = null;
      try {
        body = await Promise.race([Promise.resolve().then(() => res.json()), deadline]);
      } catch (err) {
        if (timedOut) throw timedOut;
        body = null;   // not JSON
      }
      if (timedOut) throw timedOut;
      return { res, ok: !!res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchJSON, isTimeout, timeoutError, DEFAULT_TIMEOUT_MS };
});
