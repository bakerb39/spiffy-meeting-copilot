const $ = (selector) => document.querySelector(selector);
const socket = io();
let code = new URLSearchParams(location.search).get("code")?.toUpperCase() || "";
let peer = null;
let mediaStream = null;
let wakeLock = null;
const liveText = new Map();

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
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    peer = new RTCPeerConnection();
    mediaStream.getTracks().forEach((track) => peer.addTrack(track, mediaStream));
    const channel = peer.createDataChannel("oai-events");
    channel.addEventListener("message", handleRealtimeEvent);
    channel.addEventListener("open", () => {
      $("#listener-status").textContent = "Listening now";
      $("#listening-orb").classList.add("active");
    });
    peer.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(peer?.connectionState)) setMessage("The transcription connection was interrupted.", true);
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/sdp", "X-Session-Code": code },
      body: offer.sdp
    });
    if (!response.ok) throw new Error(await response.text());
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    $("#start-listening").classList.add("hidden");
    $("#stop-listening").classList.remove("hidden");
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen").catch(() => null);
  } catch (error) {
    stopListening();
    setMessage(error.message || "Could not start the microphone.", true);
    $("#listener-status").textContent = "Not listening";
    $("#start-listening").disabled = false;
  }
}

function handleRealtimeEvent(message) {
  let event;
  try { event = JSON.parse(message.data); } catch { return; }
  if (event.type === "input_audio_buffer.speech_started") $("#listener-status").textContent = "Hearing speech…";
  if (event.type === "input_audio_buffer.speech_stopped") $("#listener-status").textContent = "Transcribing…";
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    const text = `${liveText.get(event.item_id) || ""}${event.delta || ""}`;
    liveText.set(event.item_id, text);
    $("#phone-transcript").textContent = text;
    socket.emit("transcript:partial", { itemId: event.item_id, text });
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const text = String(event.transcript || liveText.get(event.item_id) || "").trim();
    liveText.delete(event.item_id);
    if (text) {
      $("#phone-transcript").textContent = text;
      socket.emit("transcript:final", { itemId: event.item_id, text });
    }
    $("#listener-status").textContent = "Listening now";
  }
  if (event.type === "conversation.item.input_audio_transcription.failed" || event.type === "error") {
    setMessage(event.error?.message || "A transcription error occurred.", true);
  }
}

function stopListening() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  peer?.close();
  wakeLock?.release().catch(() => {});
  peer = null;
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
