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

// --- helpers to list cameras and resolve current name
async function listAvfoundationVideoDevices() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("error", (err) => reject(err));

    ffmpeg.on("exit", () => {
      const cameras = [];
      const lines = stderr.split("\n");
      let inVideoDevices = false;
      for (const line of lines) {
        if (
          line.includes("[AVFoundation indev") &&
          line.includes("video devices:")
        ) {
          inVideoDevices = true;
          continue;
        }
        if (
          line.includes("[AVFoundation indev") &&
          line.includes("audio devices:")
        ) {
          inVideoDevices = false;
          break;
        }
        if (inVideoDevices && line.includes("] [")) {
          const match = line.match(/\[(\d+)\]\s+(.+)/);
          if (match) {
            cameras.push({
              index: parseInt(match[1], 10),
              name: match[2].trim(),
            });
          }
        }
      }
      resolve(cameras);
    });
  });
}

async function resolveCameraName(deviceStr) {
  try {
    const idx = Number(String(deviceStr).split(":")[0]);
    if (!Number.isFinite(idx)) return null;
    const cameras = await listAvfoundationVideoDevices();
    const found = cameras.find((c) => c.index === idx);
    return found?.name || null;
  } catch (e) {
    return null;
  }
}

// Add this after the health endpoint
app.get("/cameras", async (_req, res) => {
  try {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("exit", () => {
      // Parse the camera list from stderr
      const cameras = [];
      const lines = stderr.split("\n");
      let inVideoDevices = false;

      for (const line of lines) {
        if (
          line.includes("[AVFoundation indev") &&
          line.includes("video devices:")
        ) {
          inVideoDevices = true;
          continue;
        }
        if (
          line.includes("[AVFoundation indev") &&
          line.includes("audio devices:")
        ) {
          inVideoDevices = false;
          break;
        }
        if (inVideoDevices && line.includes("] [")) {
          const match = line.match(/\[(\d+)\]\s+(.+)/);
          if (match) {
            cameras.push({
              index: parseInt(match[1]),
              name: match[2].trim(),
              device: `${match[1]}:none`,
            });
          }
        }
      }

      res.json({ cameras });
    });

    ffmpeg.on("error", (err) => {
      res
        .status(500)
        .json({ error: "Failed to list cameras", details: err.message });
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Error listing cameras", details: error.message });
  }
});

// Add this after the /cameras endpoint
app.post("/camera/switch", async (req, res) => {
  const { device } = req.body;

  if (!device || typeof device !== "string") {
    return res
      .status(400)
      .json({ error: "Device parameter required (e.g., '0:none')" });
  }

  try {
    console.log(`[camera] switching to device: ${device}`);

    console.log("clients", clients);

    if (clients.size > 0 && ff) {
      await hotSwapPipeline(device);
    } else {
      stopPipeline();
      startPipeline(device);
    }

    res.json({
      success: true,
      device,
      message: `Switched to camera device ${device}`,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to switch camera",
      details: error.message,
    });
  }
});

// Add endpoint to get current camera info
app.get("/camera/current", async (_req, res) => {
  try {
    const idx = Number(String(currentDevice).split(":")[0]);
    if (!Number.isFinite(idx)) {
      return res.json({ device: currentDevice, name: null });
    }

    const ff = spawn(
      "ffmpeg",
      ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", (err) => {
      res
        .status(500)
        .json({ device: currentDevice, name: null, error: err.message });
    });
    ff.on("exit", () => {
      let name = null;
      const lines = stderr.split("\n");
      let inVideo = false;
      for (const line of lines) {
        if (
          line.includes("[AVFoundation indev") &&
          line.includes("video devices:")
        ) {
          inVideo = true;
          continue;
        }
        if (
          line.includes("[AVFoundation indev") &&
          line.includes("audio devices:")
        ) {
          inVideo = false;
          break;
        }
        if (inVideo) {
          const m = line.match(/\[(\d+)\]\s+(.+)/);
          if (m && Number(m[1]) === idx) {
            name = m[2].trim();
            break;
          }
        }
      }
      res.json({ device: currentDevice, name });
    });
  } catch (e) {
    res
      .status(500)
      .json({ device: currentDevice, name: null, error: e.message });
  }
});

// ---- preview pipeline (only starts when /preview is requested)
let ff = null;
let buf = Buffer.alloc(0);
let latestFrame = null;
let currentDevice = DEVICE; // Track current device
const clients = new Set();
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// --- preview streaming robustness constants and state ---
const BOUNDARY = "frame";
let lastFrameAt = 0; // ms timestamp of last broadcasted frame
const clientMeta = new Map(); // res -> { fps, lastSent, heartbeat }
let watchdogTimer = null;

function removeClient(res, reason = "") {
  if (!clients.has(res)) return;
  clients.delete(res);
  const meta = clientMeta.get(res);
  if (meta && meta.heartbeat) {
    clearInterval(meta.heartbeat);
  }
  clientMeta.delete(res);
  try {
    if (!res.destroyed) res.end();
  } catch {}
  console.log(
    `[preview] Client removed (${reason}). Remaining: ${clients.size}`
  );
}

function broadcastFrame(frame) {
  latestFrame = frame;
  lastFrameAt = Date.now();
  for (const res of clients) {
    const meta = clientMeta.get(res) || { fps: 0, lastSent: 0 };
    // Throttle if client requested fps>0 (query param) or default to no throttle
    if (meta.fps > 0) {
      const minInterval = 1000 / meta.fps;
      if (Date.now() - meta.lastSent < minInterval) continue;
    }
    try {
      if (res.writableEnded || res.destroyed === true) {
        removeClient(res, "ended");
        continue;
      }
      res.write(
        `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
      );
      res.write(frame);
      res.write("\r\n");
      meta.lastSent = Date.now();
      clientMeta.set(res, meta);
    } catch (e) {
      console.warn("[preview] write error, dropping client:", e?.message || e);
      removeClient(res, "write-error");
    }
  }
}

function createPipeline(device) {
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
    device.split(":")[0],
    "-audio_device_index",
    "none",
    "-i",
    "",
    "-an",
    "-vf",
    "hflip",
    "-f",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];

  console.log(`[preview] ffmpeg ${device}:`, args.join(" "));
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let localBuf = Buffer.alloc(0);
  const onStdout = (chunk) => {
    localBuf = Buffer.concat([localBuf, chunk]);
    while (true) {
      const soi = localBuf.indexOf(SOI);
      if (soi < 0) {
        localBuf = Buffer.alloc(0);
        return;
      }
      const eoi = localBuf.indexOf(EOI, soi + 2);
      if (eoi < 0) {
        if (soi > 0) localBuf = localBuf.slice(soi);
        return;
      }
      const frame = localBuf.slice(soi, eoi + 2);
      localBuf = localBuf.slice(eoi + 2);
      broadcastFrame(frame);
    }
  };

  child.stdout.on("data", onStdout);
  child.stderr.on("data", (d) =>
    console.error("[ffmpeg]", d.toString().trim())
  );
  child.on("error", (e) => console.error("[ffmpeg spawn error]", e));
  child.on("exit", (code, sig) => {
    console.warn(`[preview] ffmpeg exited code=${code} sig=${sig}`);
    if (ff === child) {
      ff = null;
    }
  });

  return child;
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (clients.size === 0) return;
    const since = Date.now() - lastFrameAt;
    if (since > 5000) {
      // 5s without frames while clients are connected
      console.warn(
        `[watchdog] No frames for ${since}ms, restarting pipeline...`
      );
      try {
        stopPipeline();
      } catch {}
      try {
        startPipeline(currentDevice);
      } catch {}
    }
  }, 2000);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function startPipeline(device = currentDevice) {
  if (ff) return;
  currentDevice = device;
  startClientCleanup();
  ff = createPipeline(device);
  startWatchdog();
}

function stopPipeline() {
  if (ff) {
    try {
      ff.kill();
    } catch {}
    ff = null;
  }
  buf = Buffer.alloc(0);
  latestFrame = null;
  stopClientCleanup();
  stopWatchdog();
  console.log("[preview] pipeline stopped");
}

function hotSwapPipeline(newDevice) {
  // If there is no active pipeline, just start normally
  if (!ff) {
    currentDevice = newDevice;
    startPipeline(newDevice);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const temp = createPipeline(newDevice);
    let gotFirstFrame = false;

    const onTempData = (chunk) => {
      // We piggyback on createPipeline's broadcast; detect first frame by listening once to stdout
      if (!gotFirstFrame) {
        gotFirstFrame = true;
        // Swap currentDevice and replace ff
        const old = ff;
        ff = temp;
        currentDevice = newDevice;
        // Give the new stream a moment before tearing down old, to reduce flicker
        setTimeout(() => {
          try {
            old && old.kill();
          } catch {}
          resolve();
        }, 100);
        // Remove this one-time listener
        temp.stdout.off("data", onTempData);
      }
    };

    temp.stdout.on("data", onTempData);

    temp.once("error", (e) => {
      try {
        temp.kill();
      } catch {}
      reject(e);
    });
  });
}

app.get("/preview", (req, res) => {
  // Optional per-client fps throttle via ?fps=10
  const fps = Math.max(0, Math.min(60, Number(req.query.fps || 0) || 0));

  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Transfer-Encoding": "chunked",
  });

  clients.add(res);
  clientMeta.set(res, { fps, lastSent: 0, heartbeat: null });
  console.log(
    `[preview] Client connected. Total clients: ${clients.size} (fps=${
      fps || "unlimited"
    })`
  );

  // Heartbeat comment every 15s to keep proxies alive
  const hb = setInterval(() => {
    if (!latestFrame) return; // nothing to send yet
    try {
      res.write(
        `\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`
      );
      res.write(latestFrame);
      res.write("\r\n");
      const meta = clientMeta.get(res);
      if (meta) meta.lastSent = Date.now();
    } catch (e) {
      removeClient(res, "heartbeat-error");
    }
  }, 15000);
  clientMeta.get(res).heartbeat = hb;

  // Send the latest frame immediately if we have one
  if (latestFrame) {
    try {
      res.write(
        `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`
      );
      res.write(latestFrame);
      res.write("\r\n");
      const meta = clientMeta.get(res);
      if (meta) meta.lastSent = Date.now();
    } catch (e) {
      removeClient(res, "initial-write-error");
      return;
    }
  }

  const cleanup = () => removeClient(res, "disconnect");

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  req.on("error", () => cleanup());
  res.on("error", () => cleanup());

  // Start pipeline if not running
  startPipeline(currentDevice);
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

// Add this after your existing variables
let clientCleanupInterval = null;

function startClientCleanup() {
  if (clientCleanupInterval) return;

  clientCleanupInterval = setInterval(() => {
    const deadClients = [];

    for (const client of clients) {
      const sock = client.socket || client.req?.socket;
      const isDead =
        client.writableEnded === true ||
        client.writable === false ||
        client.destroyed === true ||
        (sock && sock.destroyed === true);
      if (isDead) {
        deadClients.push(client);
      }
    }

    if (deadClients.length > 0) {
      console.log(`[cleanup] Removing ${deadClients.length} dead clients`);
      deadClients.forEach((client) => removeClient(client, "dead-client"));
    }

    if (clients.size === 0) {
      console.log("[cleanup] No clients remaining, stopping pipeline");
      stopPipeline();
    }
  }, 10000); // Check every 10 seconds
}

function stopClientCleanup() {
  if (clientCleanupInterval) {
    clearInterval(clientCleanupInterval);
    clientCleanupInterval = null;
  }
}
