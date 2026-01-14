// src/common/http.js
const { URL } = require("url");

function setCors(res) {
  // ✅ 本地开发 + 线上都能用（演示阶段先用 *）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");

  // ✅ 允许的方法
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  // ✅ 允许的自定义请求头（重点：Content-Type + X-API-Token）
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Token, X-Client-Id, X-Session-Id"
  );

  // ✅ 如果你前端需要读一些自定义响应头，就把它们加进来
  res.setHeader("Access-Control-Expose-Headers", "Date,x-fc-request-id");

  // 预检缓存（可选）
  res.setHeader("Access-Control-Max-Age", "86400");
}

function handleOptions(req, res) {
  if (req.method !== "OPTIONS") return false;

  // 只要是 OPTIONS，直接 204 结束（关键：必须是 2xx）
  res.statusCode = 204;
  res.end();
  return true;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj ?? {});
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function handleError(res, err) {
  const msg = String(err?.stack || err || "Internal Server Error");
  // 线上不要返回太多堆栈也行，你 demo 阶段先返回便于排查
  sendJson(res, 500, { error: "internal_error", message: msg });
}

function parseUrl(req) {
  const u = new URL(req.url || "/", "http://localhost");
  return { pathname: u.pathname, query: Object.fromEntries(u.searchParams.entries()) };
}

async function readJson(req, { limitBytes = 20 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("payload_too_large");
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

module.exports = {
  setCors,
  handleOptions,
  sendJson,
  handleError,
  parseUrl,
  readJson,
};
