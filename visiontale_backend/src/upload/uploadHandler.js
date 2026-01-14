const Busboy = require("busboy");
const crypto = require("crypto");
const { sendJson } = require("../common/http");

// demo：先内存保存图片，返回 mem://id（后续你接 OSS 就替换这里）
const memoryImages = new Map();

function handleUpload(req, res) {
  const bb = Busboy({
    headers: req.headers,
    limits: { files: 1, fileSize: 8 * 1024 * 1024 }
  });

  let gotFile = false;
  const bufs = [];

  bb.on("file", (field, file) => {
    gotFile = true;
    file.on("data", (d) => bufs.push(d));
    file.on("limit", () => file.resume());
  });

  bb.on("finish", () => {
    if (!gotFile) return sendJson(res, 400, { error: "no_file" });

    const id = crypto.randomUUID();
    memoryImages.set(id, Buffer.concat(bufs));

    sendJson(res, 200, { imageUrl: `mem://${id}` });
  });

  bb.on("error", (e) => sendJson(res, 500, { error: "upload_error", message: String(e) }));

  req.pipe(bb);
}

module.exports = { handleUpload, memoryImages };
