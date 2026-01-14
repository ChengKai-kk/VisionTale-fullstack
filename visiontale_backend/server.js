const http = require("http");
const { router } = require("./src/router");
const { setCors, handleOptions, sendJson, handleError } = require("./src/common/http");

const PORT = Number(process.env.PORT || 9000);

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (handleOptions(req, res)) return;

    const handled = await router(req, res);
    if (!handled) sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    handleError(res, err);
  }
});

server.listen(PORT, () => {
  console.log(`[visiontale_backend] server listening on ${PORT}`);
});
