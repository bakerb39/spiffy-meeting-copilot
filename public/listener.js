const $ = (selector) => document.querySelector(selector);
const socket = io();
let code = new URLSearchParams(location.search).get("code")?.toUpperCase() || "";
let peer = null;
let mediaStream = null;
let wakeLock = null;
let dataChannel = null;
let commitTimer = null;
const liveText = new Map();

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
    $("#listener-status").textContent = "Microphone active — connecting…";
    $("#listening-orb").classList.add("active");
    peer = new RTCPeerConnection();
    mediaStream.getTracks().forEach((track) => peer.addTrack(track, mediaStream));
    dataChannel = peer.createDataChannel("oai-events");
    dataChannel.addEventListener("message", handleRealtimeEvent);
    dataChannel.addEventListener("open", () => {
      $("#listener-status").textContent = "Listening now";
      $("#listening-orb").classList.add("active");
      commitTimer = setInterval(commitAudioTurn, 5000);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(peer?.connectionState)) setMessage("The transcription connection was interrupted.", true);
    });

    const tokenResponse = await withTimeout(
      fetch("/api/realtime/token", { headers: { "X-Session-Code": code } }),
      20000,
      "The microphone opened, but the server did not return a connection token."
    );
    if (!tokenResponse.ok) throw new Error(await tokenResponse.text());
    const tokenData = await tokenResponse.json();
    if (!tokenData.value) throw new Error("The server returned an invalid connection token.");

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await withTimeout(
      fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.value}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      }),
      25000,
      "The iPhone could not establish a direct transcription connection with OpenAI."
    );
    if (!response.ok) throw new Error(`OpenAI connection error ${response.status}: ${await response.text()}`);
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
  if (event.type === "conversation.item.input_audio_transcription.failed") {
    setMessage(event.error?.message || "A transcription error occurred.", true);
  }
  if (event.type === "error" && !String(event.error?.message || "").toLowerCase().includes("buffer too small")) {
    setMessage(event.error?.message || "A transcription error occurred.", true);
  }
}

function commitAudioTurn() {
  if (dataChannel?.readyState === "open" && mediaStream?.active) {
    dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    $("#listener-status").textContent = "Transcribing…";
  }
}

function stopListening() {
  if (commitTimer) clearInterval(commitTimer);
  commitTimer = null;
  commitAudioTurn();
  mediaStream?.getTracks().forEach((track) => track.stop());
  peer?.close();
  wakeLock?.release().catch(() => {});
  peer = null;
  dataChannel = null;
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
