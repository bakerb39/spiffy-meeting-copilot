import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApplication } from "../server.js";

let server;
let origin;

before(async () => {
  ({ server } = createApplication());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));

test("health endpoint reports ready", async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("creates a pairing session with a QR code", async () => {
  const response = await fetch(`${origin}/api/sessions`, { method: "POST" });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.match(data.code, /^[A-Z2-9]{8}$/);
  assert.match(data.listenerUrl, /listen\.html\?code=/);
  assert.match(data.qrDataUrl, /^data:image\/png;base64,/);
});

test("rejects suggestion requests for unknown sessions", async () => {
  const response = await fetch(`${origin}/api/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "AAAAAAAA" })
  });
  assert.equal(response.status, 404);
});
