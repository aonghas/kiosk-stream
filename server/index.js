// server/index.js
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const PORT = Number(process.env.PORT || 5000);
const DEVICE = String(process.env.AVFOUNDATION_DEVICE || "0:none");
const W = String(process.env.PREVIEW_WIDTH || "1280");
const H = String(process.env.PREVIEW_HEIGHT || "720");
const FPS = String(process.env.PREVIEW_FPS || "30");

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

// --- simple ping
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- preview pipeline (only starts when /preview is requested)
let ff = null;
let buf = Buffer.alloc(0);
let latestFrame = null;
const clients = new Set();
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function startPipeline() {
  if (ff) return;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-framerate",
    FPS,
    "-video_size",
    `${W}x${H}`,
    "-capture_cursor",
    "0",
    "-capture_mouse_clicks",
    "0",
    "-pixel_format",
    "yuyv422",
    "-video_device_index",
    DEVICE.split(":")[0], // extract device index from "0:none" format
    "-audio_device_index",
    "none",
    "-i",
    "",
    "-an",
    "-f",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];
  console.log("[preview] ffmpeg", args.join(" "));
  ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  ff.stdout.on("data", onData);
  ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString().trim()));
  ff.on("error", (e) => console.error("[ffmpeg spawn error]", e));
  ff.on("exit", (code, sig) => {
    console.warn(`[preview] ffmpeg exited code=${code} sig=${sig}`);
    ff = null;
  });
}

function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const soi = buf.indexOf(SOI);
    if (soi < 0) {
      buf = Buffer.alloc(0);
      return;
    }
    const eoi = buf.indexOf(EOI, soi + 2);
    if (eoi < 0) {
      if (soi > 0) buf = buf.slice(soi);
      return;
    }
    const frame = buf.slice(soi, eoi + 2);
    buf = buf.slice(eoi + 2);
    latestFrame = frame;
    for (const res of clients) {
      try {
        res.write(
          `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
        );
        res.write(frame);
        res.write("\r\n");
      } catch {}
    }
  }
}

app.get("/preview", (req, res) => {
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
  });
  clients.add(res);
  if (latestFrame) {
    res.write(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`
    );
    res.write(latestFrame);
    res.write("\r\n");
  }
  const cleanup = () => {
    clients.delete(res);
    try {
      res.end();
    } catch {}
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  startPipeline();
});

// ---- capture latest preview frame (mock)
const DATA_DIR = path.resolve("./data/files");
fs.mkdirSync(DATA_DIR, { recursive: true });

app.post("/capture", async (_req, res) => {
  if (!latestFrame) return res.status(503).json({ error: "no frame yet" });
  const id = crypto.randomBytes(6).toString("hex");
  const filePath = path.join(DATA_DIR, `${id}.jpg`);
  await fs.promises.writeFile(filePath, latestFrame);
  res.json({ jobId: id, status: "done", file: `/files/${id}.jpg` });
});

// ---- capture using gphoto2 (for USB-connected cameras)
app.post("/capture-gphoto2", async (_req, res) => {
  try {
    const id = crypto.randomBytes(6).toString("hex");
    const fileName = `${id}.jpg`;
    const filePath = path.join(DATA_DIR, fileName);

    // First, check if camera is connected
    const checkCamera = spawn("gphoto2", ["--summary"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    checkCamera.on("exit", (code) => {
      if (code !== 0) {
        return res
          .status(503)
          .json({ error: "No gphoto2-compatible camera detected" });
      }

      // Camera detected, proceed with capture
      const captureArgs = [
        "--capture-image-and-download",
        "--filename",
        fileName,
        "--force-overwrite",
      ];

      console.log("[gphoto2] capturing image:", captureArgs.join(" "));
      const gphoto = spawn("gphoto2", captureArgs, {
        cwd: DATA_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      gphoto.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      gphoto.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      gphoto.on("exit", (captureCode) => {
        if (captureCode === 0 && fs.existsSync(filePath)) {
          console.log("[gphoto2] capture successful:", fileName);
          res.json({
            jobId: id,
            status: "done",
            file: `/files/${fileName}`,
            method: "gphoto2",
          });
        } else {
          console.error("[gphoto2] capture failed:", stderr);
          res.status(500).json({
            error: "gphoto2 capture failed",
            details: stderr || stdout,
            code: captureCode,
          });
        }
      });

      gphoto.on("error", (err) => {
        console.error("[gphoto2] spawn error:", err);
        res
          .status(500)
          .json({ error: "Failed to execute gphoto2", details: err.message });
      });
    });

    checkCamera.on("error", (err) => {
      console.error("[gphoto2] check camera error:", err);
      res
        .status(500)
        .json({ error: "gphoto2 not available", details: err.message });
    });
  } catch (error) {
    console.error("[gphoto2] unexpected error:", error);
    res.status(500).json({
      error: "Unexpected error during gphoto2 capture",
      details: error.message,
    });
  }
});

app.use("/files", express.static(DATA_DIR));

const server = app.listen(PORT);
server.on("listening", () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
  console.log(`Preview device: avfoundation:${DEVICE} @ ${W}x${H} ${FPS}fps`);
});
server.on("error", (err) => {
  console.error("[listen error]", err);
  process.exit(1);
});

process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e);
});
