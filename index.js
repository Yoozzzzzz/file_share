const express = require("express"); // 引入 Express 框架
const multer = require("multer"); // 引入 multer 中间件，用于处理文件上传
const cors = require("cors"); // 引入 cors 中间件，用于处理跨域问题
const body_parser = require("body-parser"); // 引入 body-parser 中间件，用于处理 post 请求数据
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("ws");

const app = express(); // 创建 Express 应用程序
const server = http.createServer(app);
const wss = new Server({ server });

const port = 3000; // 监听端口
const FILE_DIR = path.join(__dirname, "fileList");

if (!fs.existsSync(FILE_DIR)) {
  fs.mkdirSync(FILE_DIR, { recursive: true });
}

const decodeOriginalName = (name) => {
  if (!name) return "";
  return Buffer.from(name, "latin1").toString("utf8");
};

const filenameSanitizer = (name) => {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  return cleaned || "未命名文件";
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, FILE_DIR);
  },
  // 设置保存的文件名
  filename: function (req, file, cb) {
    const uniqueKey = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const decodedName = decodeOriginalName(file.originalname);
    const safeOriginalName = filenameSanitizer(decodedName);
    file.originalname = safeOriginalName;
    cb(null, `${uniqueKey}__${safeOriginalName}`);
  },
}); // 创建 multer 中间件，指定文件上传目录

//取消限制上传文件大小
app.use(body_parser.json({ limit: "200mb" }));
app.use(
  body_parser.urlencoded({
    limit: "200mb",
    extended: true,
    parameterLimit: 100000,
  })
);

//处理文件上传配置信息
const upload = multer({ storage: storage });
app.all("*", function (req, res, next) {
  console.log(req.url, "====>请求来了<====");
  // console.log(req.method, "====>请求方法<====");
  // 设置允许跨域的域名,*代表允许任意域名跨域
  res.header("Access-Control-Allow-Origin", "*");
  // 允许的header类型
  res.header("Access-Control-Allow-Headers", "*");
  // 跨域允许的请求方式
  res.header("Access-Control-Allow-Methods", "DELETE,PUT,POST,GET,OPTIONS");
  if (req.method.toLowerCase() == "options")
    res.sendStatus(200); // 让options 尝试请求快速结束
  else next();
});

// 静态文件目录
app.use(
  "/fileList",
  express.static(FILE_DIR, {
    setHeaders(res, filePath) {
      const filename = path.basename(filePath);
      const displayName = filename.includes("__")
        ? filename.split("__").slice(1).join("__")
        : filename;
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(displayName)}`
      );
    },
  })
);
// 首页
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));


app.post("/api/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({
      code: 400,
      msg: "未检测到上传文件",
    });
  }

  const fileInfo = buildFileInfo(file.filename, req);

  broadcastRefresh(fileInfo);

  res.json({
    code: 200,
    msg: "上传成功",
    data: fileInfo,
  });
});

app.get("/api/files", (req, res) => {
  fs.readdir(FILE_DIR, (err, files) => {
    if (err) {
      console.error(err);
      return res.status(500).json({
        code: 500,
        msg: "读取文件列表失败",
        data: [],
      });
    }

    const list = files
      .filter((file) => !file.startsWith("."))
      .map((filename) => buildFileInfo(filename, req))
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    res.json({
      code: 200,
      msg: "ok",
      data: list,
    });
  });
});

function broadcastRefresh(latestFile) {
  if (!wss || wss.clients.size === 0) return;
  const message = JSON.stringify({
    type: "files:updated",
    payload: latestFile
      ? {
          latest: latestFile,
          refreshedAt: new Date().toISOString(),
        }
      : null,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        console.error("WebSocket send error:", error);
      }
    }
  });
}

wss.on("connection", (socket, req) => {
  console.log("WebSocket 客户端已连接", req.socket.remoteAddress);
  socket.send(
    JSON.stringify({
      type: "connection:ack",
      payload: {
        message: "连接成功",
        connectedAt: new Date().toISOString(),
      },
    })
  );

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "error",
          payload: {
            message: "消息格式错误，请使用 JSON",
          },
        })
      );
      return;
    }

    if (data?.type === "files:refresh") {
      broadcastRefresh();
    }
  });

  socket.on("close", () => {
    console.log("WebSocket 客户端已断开连接");
  });
});

function buildFileInfo(filename, req) {
  const filepath = path.join(FILE_DIR, filename);
  let stats;
  try {
    stats = fs.statSync(filepath);
  } catch (error) {
    return null;
  }

  const displayName = filename.includes("__")
    ? filename.split("__").slice(1).join("__")
    : filename;

  const size = stats.size;

  return {
    filename,
    displayName,
    size,
    sizeReadable: formatBytes(size),
    mimeType: getMimeType(filename),
    mtime: stats.mtime.toISOString(),
    mtimeMs: stats.mtimeMs,
    downloadUrl: `${req.protocol}://${req.get("host")}/fileList/${encodeURIComponent(
      filename
    )}`,
    relativeDownloadUrl: `/fileList/${encodeURIComponent(filename)}`,
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${sizes[i]}`;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".rar": "application/vnd.rar",
    ".7z": "application/x-7z-compressed",
    ".txt": "text/plain",
    ".json": "application/json",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".apk": "application/vnd.android.package-archive",
  };

  return map[ext] || "application/octet-stream";
}

//处理跨域请求
app.use(cors());
server.listen(port, () => {
  console.log("HTTP + WebSocket 服务已启动 👉 http://127.0.0.1:" + port);
});
