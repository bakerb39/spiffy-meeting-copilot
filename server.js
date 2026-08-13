import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import OpenAI from "openai";
import QRCode from "qrcode";
import { Server as SocketServer } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 80_000;
const sessions = new Map();

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function cleanCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
}

function getSession(code) {
  const session = sessions.get(cleanCode(code));
  if (!session || Date.now() - session.createdAt > SESSION_LIFETIME_MS) return null;
  return session;
}

function publicOrigin(req) {
  const forwarded = req.get("x-forwarded-proto");
  return `${forwarded || req.protocol}://${req.get("host")}`;
}

export function createApplication() {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, { maxHttpBufferSize: 100_000 });

  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'", "ws:", "wss:", "https://api.openai.com"],
        "media-src": ["'self'", "blob:"],
        "style-src": ["'self'"],
        "script-src": ["'self'"]
      }
    }
  }));

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: "draft-8" });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.post(
    "/api/transcribe",
    apiLimiter,
    express.raw({ type: ["audio/webm", "audio/mp4", "audio/mpeg", "application/octet-stream"], limit: "12mb" }),
    async (req, res) => {
      const session = getSession(req.get("x-session-code"));
      if (!session) return res.status(404).json({ error: "Meeting session not found or expired." });
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY is not configured." });
      if (!Buffer.isBuffer(req.body) || req.body.length < 500) return res.status(400).json({ error: "The audio segment was empty." });

      const contentType = req.get("content-type")?.split(";")[0] || "audio/mp4";
      const extension = contentType.includes("webm") ? "webm" : contentType.includes("mpeg") ? "mp3" : "mp4";
      try {
        const form = new FormData();
        form.set("model", process.env.OPENAI_FILE_TRANSCRIBE_MODEL || "gpt-transcribe");
        form.set("response_format", "json");
        form.set("file", new Blob([req.body], { type: contentType }), `meeting-segment.${extension}`);
        const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: form
        });
        const body = await upstream.text();
        if (!upstream.ok) {
          console.error("Audio transcription failed:", upstream.status, body.slice(0, 500));
          let message = "OpenAI rejected the audio segment.";
          try { message = JSON.parse(body)?.error?.message || message; } catch { /* keep safe message */ }
          return res.status(502).json({ error: `OpenAI error ${upstream.status}: ${message}` });
        }
        const data = JSON.parse(body);
        res.json({ text: String(data.text || "").trim() });
      } catch (error) {
        console.error("Audio transcription error:", error);
        res.status(502).json({ error: "Could not transcribe the audio segment." });
      }
    }
  );

  app.get(
    "/api/realtime/token",
    apiLimiter,
    async (req, res) => {
      const session = getSession(req.get("x-session-code"));
      if (!session) return res.status(404).send("Meeting session not found or expired.");
      if (!process.env.OPENAI_API_KEY) return res.status(503).send("OPENAI_API_KEY is not configured.");

      const sessionConfig = {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-live-transcribe",
              delay: "low"
            },
            turn_detection: null
          }
        }
      };

      try {
        const upstreamController = new AbortController();
        const upstreamTimeout = setTimeout(() => upstreamController.abort(), 15_000);
        const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": crypto.createHash("sha256").update(session.code).digest("hex")
          },
          body: JSON.stringify({ session: sessionConfig }),
          signal: upstreamController.signal
        });
        clearTimeout(upstreamTimeout);
        const body = await upstream.text();
        if (!upstream.ok) {
          console.error("Realtime setup failed:", upstream.status, body.slice(0, 500));
          let upstreamMessage = "OpenAI rejected the transcription request.";
          try {
            const parsed = JSON.parse(body);
            upstreamMessage = parsed?.error?.message || parsed?.message || upstreamMessage;
          } catch {
            if (body && body.length < 400) upstreamMessage = body;
          }
          return res.status(502).send(`OpenAI error ${upstream.status}: ${upstreamMessage}`);
        }
        const tokenData = JSON.parse(body);
        if (!tokenData?.value) return res.status(502).send("OpenAI did not return a temporary connection token.");
        res.json({ value: tokenData.value });
      } catch (error) {
        console.error("Realtime setup error:", error);
        const message = error?.name === "AbortError"
          ? "OpenAI did not respond within 15 seconds. Please try Start listening again."
          : "Could not connect to the transcription service.";
        res.status(502).send(message);
      }
    }
  );

  app.use(express.json({ limit: "1mb" }));

  app.post("/api/sessions", apiLimiter, async (req, res) => {
    let code;
    do code = newCode(); while (sessions.has(code));
    sessions.set(code, { code, createdAt: Date.now(), transcript: [], context: "" });
    const listenerUrl = `${publicOrigin(req)}/listen.html?code=${code}`;
    const qrDataUrl = await QRCode.toDataURL(listenerUrl, { width: 360, margin: 1, color: { dark: "#07111f", light: "#ffffff" } });
    res.status(201).json({ code, listenerUrl, qrDataUrl, expiresInMinutes: SESSION_LIFETIME_MS / 60_000 });
  });

  app.get("/api/sessions/:code", apiLimiter, (req, res) => {
    const session = getSession(req.params.code);
    if (!session) return res.status(404).json({ error: "Session not found or expired." });
    res.json({ code: session.code, active: true });
  });

  app.post("/api/suggest", apiLimiter, async (req, res) => {
    const session = getSession(req.body?.code);
    if (!session) return res.status(404).json({ error: "Session not found or expired." });
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY is not configured." });

    const context = String(req.body?.context || "").trim().slice(0, 30_000);
    const style = ["concise", "warm", "direct"].includes(req.body?.style) ? req.body.style : "concise";
    const transcript = session.transcript.join("\n").slice(-MAX_TRANSCRIPT_CHARS).trim();
    if (!transcript) return res.status(400).json({ error: "No completed transcript is available yet." });
    session.context = context;

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.responses.create({
        model: process.env.OPENAI_RESPONSE_MODEL || "gpt-5-mini",
        instructions: [
          "You are a discreet meeting copilot.",
          `Draft a ${style}, natural response that the presenter can say aloud now.`,
          "Use the meeting transcript and supplied context only.",
          "Do not claim facts that are not supported. If essential information is missing, say so plainly.",
          "Return only the suggested spoken response, normally 2-5 sentences."
        ].join(" "),
        input: `MEETING CONTEXT\n${context || "No extra context supplied."}\n\nLIVE TRANSCRIPT\n${transcript}`
      });
      res.json({ suggestion: response.output_text?.trim() || "No suggestion was generated." });
    } catch (error) {
      console.error("Suggestion error:", error);
      res.status(502).json({ error: "Could not generate a suggestion. Check the server logs and model setting." });
    }
  });

  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  io.on("connection", (socket) => {
    socket.on("session:join", ({ code, role } = {}, acknowledge = () => {}) => {
      const session = getSession(code);
      if (!session || !["desktop", "listener"].includes(role)) return acknowledge({ ok: false, error: "Session not found or expired." });
      socket.data.code = session.code;
      socket.data.role = role;
      socket.join(session.code);
      acknowledge({ ok: true, transcript: session.transcript });
      io.to(session.code).emit("session:presence", { listenerConnected: roomHasRole(io, session.code, "listener") });
    });

    socket.on("transcript:partial", ({ itemId, text } = {}) => {
      if (socket.data.role !== "listener" || !socket.data.code) return;
      io.to(socket.data.code).emit("transcript:partial", {
        itemId: String(itemId || "").slice(0, 100),
        text: String(text || "").slice(0, 4_000)
      });
    });

    socket.on("transcript:final", ({ itemId, text } = {}) => {
      if (socket.data.role !== "listener" || !socket.data.code) return;
      const session = getSession(socket.data.code);
      const cleaned = String(text || "").replace(/\s+/g, " ").trim().slice(0, 8_000);
      if (!session || !cleaned) return;
      session.transcript.push(cleaned);
      while (session.transcript.join("\n").length > MAX_TRANSCRIPT_CHARS) session.transcript.shift();
      io.to(socket.data.code).emit("transcript:final", { itemId: String(itemId || "").slice(0, 100), text: cleaned });
    });

    socket.on("disconnect", () => {
      if (socket.data.code) {
        setTimeout(() => io.to(socket.data.code).emit("session:presence", {
          listenerConnected: roomHasRole(io, socket.data.code, "listener")
        }), 50);
      }
    });
  });

  return { app, server, io, sessions };
}

function roomHasRole(io, room, role) {
  const members = io.sockets.adapter.rooms.get(room) || new Set();
  return [...members].some((id) => io.sockets.sockets.get(id)?.data.role === role);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createApplication();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Spiffy Meeting Copilot listening on port ${port}`));
  const cleanup = setInterval(() => {
    for (const [code, session] of sessions) {
      if (Date.now() - session.createdAt > SESSION_LIFETIME_MS) sessions.delete(code);
    }
  }, 15 * 60_000);
  cleanup.unref();
}
