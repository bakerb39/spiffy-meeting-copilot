const $ = (selector) => document.querySelector(selector);
const socket = io();
let session = null;
let finalLines = [];
const partials = new Map();

function setMessage(text, error = false) {
  const el = $("#app-message");
  el.textContent = text;
  el.classList.toggle("error", error);
}

function renderTranscript() {
  const box = $("#transcript");
  if (!finalLines.length) {
    box.innerHTML = '<p class="placeholder">Completed speech will appear here after the phone starts listening.</p>';
  } else {
    box.replaceChildren(...finalLines.map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }));
    box.scrollTop = box.scrollHeight;
  }
  $("#partial-transcript").textContent = [...partials.values()].join(" ");
}

async function createSession() {
  try {
    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) throw new Error("Could not create a meeting session.");
    session = await response.json();
    $("#qr-code").src = session.qrDataUrl;
    $("#session-code").textContent = session.code;
    $("#copy-link").disabled = false;
    socket.emit("session:join", { code: session.code, role: "desktop" }, (result) => {
      if (!result?.ok) return setMessage(result?.error || "Could not join the session.", true);
      finalLines = result.transcript || [];
      renderTranscript();
    });
  } catch (error) {
    setMessage(error.message, true);
  }
}

socket.on("session:presence", ({ listenerConnected }) => {
  const status = $("#pair-status");
  status.className = `status ${listenerConnected ? "connected" : "waiting"}`;
  status.innerHTML = `<span></span>${listenerConnected ? "Phone connected" : "Waiting for phone"}`;
});

socket.on("transcript:partial", ({ itemId, text }) => {
  partials.set(itemId, text);
  renderTranscript();
});

socket.on("transcript:final", ({ itemId, text }) => {
  partials.delete(itemId);
  finalLines.push(text);
  renderTranscript();
});

$("#copy-link").addEventListener("click", async () => {
  if (!session) return;
  await navigator.clipboard.writeText(session.listenerUrl);
  setMessage("Phone link copied.");
});

$("#clear-transcript").addEventListener("click", () => {
  finalLines = [];
  partials.clear();
  renderTranscript();
  setMessage("The transcript was cleared from this screen. New speech will continue to arrive.");
});

$("#context-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 500_000) return setMessage("Please choose a text file smaller than 500 KB.", true);
  const text = await file.text();
  const textarea = $("#meeting-context");
  textarea.value = `${textarea.value}${textarea.value ? "\n\n" : ""}${text}`.slice(0, 30_000);
  $("#file-name").textContent = file.name;
  setMessage("Context added from the file.");
});

$("#suggest").addEventListener("click", async () => {
  if (!session) return setMessage("The meeting session is still starting.", true);
  const button = $("#suggest");
  button.disabled = true;
  button.textContent = "Thinking…";
  setMessage("");
  try {
    const response = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: session.code,
        context: $("#meeting-context").value,
        style: $("#response-style").value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not generate a response.");
    $("#suggestion").textContent = data.suggestion;
    $("#copy-suggestion").disabled = false;
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Suggest what to say";
  }
});

$("#copy-suggestion").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#suggestion").textContent);
  setMessage("Suggested response copied.");
});

createSession();
