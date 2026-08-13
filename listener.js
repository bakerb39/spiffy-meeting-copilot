const $ = (selector) => document.querySelector(selector);
const socket = io();
let code = new URLSearchParams(location.search).get("code")?.toUpperCase() || "";
let mediaStream = null;
let wakeLock = null;
let recorder = null;
let chunkTimer = null;
let listening = false;
let segmentNumber = 0;

function withTimeout(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]);
}

function setMessage(text, error = false) {
  const el = $("#listener-message");
  el.textContent = text;
  el.classList.toggle("error", error);
}

function showListener() {
  $("#join-panel").classList.add("hidden");
  $("#listen-panel").classList.remove("hidden");
  $("#listener-code").textContent = code;
}

function connectSession(candidate) {
  code = String(candidate || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
  if (code.length !== 8) return Promise.reject(new Error("Enter the complete 8-character code."));
  return new Promise((resolve, reject) => {
    socket.emit("session:join", { code, role: "listener" }, (result) => {
      if (!result?.ok) return reject(new Error(result?.error || "Could not connect."));
      history.replaceState({}, "", `/listen.html?code=${code}`);
      showListener();
      resolve();
    });
  });
}

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#join-message");
  try {
    await connectSession($("#code-input").value);
    message.textContent = "";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#consent").addEventListener("change", (event) => {
  $("#start-listening").disabled = !event.target.checked;
});

async function startListening() {
  setMessage("");
  $("#start-listening").disabled = true;
  $("#listener-status").textContent = "Requesting microphone…";
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access the microphone. Open this page directly in Safari.");
    }
    mediaStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: true }),
      15000,
      "The iPhone did not finish opening the microphone. Close this tab, reopen the QR link directly in Safari, and try again."
    );
    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState !== "live") {
      throw new Error("Safari granted permission but did not provide an active microphone.");
    }
    $("#listener-status").textContent = "Microphone active — starting…";
    $("#listening-orb").classList.add("active");
    if (typeof MediaRecorder === "undefined") throw new Error("This version of Safari cannot create audio segments.");
    listening = true;
    segmentNumber = 0;
    startAudioSegment();
    $("#start-listening").classList.add("hidden");
    $("#stop-listening").classList.remove("hidden");
    $("#listener-status").textContent = "Listening now";
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen").catch(() => null);
  } catch (error) {
    stopListening();
    setMessage(error.message || "Could not start the microphone.", true);
    $("#listener-status").textContent = "Not listening";
    $("#start-listening").disabled = false;
  }
}

function preferredAudioType() {
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function startAudioSegment() {
  if (!listening || !mediaStream?.active) return;
  const chunks = [];
  const mimeType = preferredAudioType();
  recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener("error", (event) => {
    setMessage(`iPhone recording error: ${event.error?.message || "unknown recording error"}`, true);
  });
  recorder.addEventListener("stop", async () => {
    const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/mp4" });
    segmentNumber += 1;
    if (blob.size > 500) {
      await transcribeSegment(blob, segmentNumber);
    } else {
      setMessage(`Audio segment ${segmentNumber} was empty (${blob.size} bytes). Safari is not recording microphone data.`, true);
    }
    if (listening) startAudioSegment();
  }, { once: true });
  recorder.start();
  chunkTimer = setTimeout(() => {
    if (recorder?.state === "recording") recorder.stop();
  }, 7000);
}

async function transcribeSegment(blob, number) {
  const kilobytes = Math.max(1, Math.round(blob.size / 1024));
  $("#listener-status").textContent = `Uploading segment ${number} (${kilobytes} KB)…`;
  setMessage(`Recorded segment ${number}: ${kilobytes} KB. Sending for transcription…`);
  try {
    const response = await withTimeout(fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/mp4", "X-Session-Code": code },
      body: blob
    }), 30000, "The transcription request took too long.");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Transcription failed (${response.status}).`);
    if (data.text) {
      $("#phone-transcript").textContent = data.text;
      socket.emit("transcript:final", { itemId: `${Date.now()}`, text: data.text });
      setMessage(`Segment ${number} transcribed successfully.`);
    } else {
      setMessage(`Segment ${number} uploaded successfully, but OpenAI detected no speech. Speak directly toward the bottom edge of the iPhone for the next segment.`, true);
    }
  } catch (error) {
    setMessage(error.message || "Could not transcribe this audio segment.", true);
  } finally {
    if (listening) $("#listener-status").textContent = "Listening now";
  }
}

function stopListening() {
  listening = false;
  if (chunkTimer) clearTimeout(chunkTimer);
  chunkTimer = null;
  if (recorder?.state === "recording") recorder.stop();
  mediaStream?.getTracks().forEach((track) => track.stop());
  wakeLock?.release().catch(() => {});
  recorder = null;
  mediaStream = null;
  wakeLock = null;
  $("#listening-orb").classList.remove("active");
  $("#listener-status").textContent = "Not listening";
  $("#stop-listening").classList.add("hidden");
  $("#start-listening").classList.remove("hidden");
  $("#start-listening").disabled = !$("#consent").checked;
}

$("#start-listening").addEventListener("click", startListening);
$("#stop-listening").addEventListener("click", stopListening);
window.addEventListener("pagehide", stopListening);

if (code) connectSession(code).catch((error) => {
  $("#code-input").value = code;
  $("#join-message").textContent = error.message;
  $("#join-message").classList.add("error");
});
