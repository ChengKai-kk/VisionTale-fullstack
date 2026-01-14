function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Token, X-Client-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function handleOptions(req, res) {
  if (req.method !== "OPTIONS") return false;
  res.statusCode = 204;
  res.end();
  return true;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseUrl(req) {
  const u = new URL(req.url, "http://localhost");
  return { pathname: u.pathname, searchParams: u.searchParams };
}

function handleError(res, err) {
  const msg = String(err && err.stack ? err.stack : err);
  console.error(msg);
  sendJson(res, 500, { error: "internal_error", message: msg });
}

module.exports = { setCors, handleOptions, sendJson, readJson, parseUrl, handleError };
