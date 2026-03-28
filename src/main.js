const { Client, Storage, Permission, Role, ID } = require("node-appwrite");
const { InputFile } = require("node-appwrite/file");

function getHeader(req, name) {
  const h = req.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(h[key]) : "";
}

function parsePayload(req) {
  if (req.bodyJson && typeof req.bodyJson === "object") {
    return req.bodyJson;
  }
  try {
    return JSON.parse(req.bodyText || "{}");
  } catch (_parseErr) {
    return null;
  }
}

module.exports = async ({ req, res, log, error: logError }) => {
  if (req.method === "GET") {
    return res.json({ ok: true, name: "generate-map" });
  }

  if (req.method !== "POST") {
    return res.json({ ok: false, error: "Method not allowed", status: 405 });
  }

  const jwt = getHeader(req, "x-appwrite-user-jwt");
  const userId = getHeader(req, "x-appwrite-user-id");

  if (!jwt || !userId) {
    return res.json({ ok: false, error: "Unauthorized", status: 401 });
  }

  const endpoint = process.env.APPWRITE_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const mapboxToken = process.env.MAPBOX_SECRET_TOKEN;
  const bucketExports = process.env.BUCKET_EXPORTS;

  if (!endpoint || !projectId || !mapboxToken || !bucketExports) {
    logError("Missing env: APPWRITE_ENDPOINT, project, MAPBOX_SECRET_TOKEN, or BUCKET_EXPORTS");
    return res.json({ ok: false, error: "Server misconfiguration", status: 500 });
  }

  const payload = parsePayload(req);
  if (!payload) {
    return res.json({ ok: false, error: "Invalid JSON body", status: 400 });
  }

  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  let zoom = Number(payload.zoom);
  let width = Math.min(1280, Math.max(64, Math.round(Number(payload.width) || 1200)));
  let height = Math.min(1280, Math.max(64, Math.round(Number(payload.height) || 800)));
  const maximizeStaticSize = payload.maximizeStaticSize !== false;
  if (maximizeStaticSize) {
    const m = Math.max(width, height);
    if (m > 0 && m < 1280) {
      const s = 1280 / m;
      width = Math.min(1280, Math.max(64, Math.round(width * s)));
      height = Math.min(1280, Math.max(64, Math.round(height * s)));
    }
  }
  const stylePath =
    typeof payload.stylePath === "string" && payload.stylePath.length > 0
      ? payload.stylePath
      : "mapbox/streets-v12";
  const pinLat = Number(payload.pinLat);
  const pinLng = Number(payload.pinLng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.json({ ok: false, error: "Invalid coordinates", status: 400 });
  }

  if (!Number.isFinite(zoom)) zoom = 14;
  zoom = Math.min(22, Math.max(0, zoom));
  const z = Math.round(zoom * 100) / 100;
  const hasPin =
    Number.isFinite(pinLat) &&
    Number.isFinite(pinLng) &&
    Math.abs(pinLat) <= 90 &&
    Math.abs(pinLng) <= 180;

  // Center + zoom + dimensions (Mapbox may round zoom to 2 decimals). No bbox — bbox mode recomputes zoom to fit the box.
  const overlay = hasPin ? `pin-s+047857(${pinLng},${pinLat})/` : "";
  const staticSegment = `${overlay}${lng},${lat},${z},0,0/${width}x${height}@2x`;
  const mapUrl =
    "https://api.mapbox.com/styles/v1/" +
    stylePath +
    "/static/" +
    staticSegment +
    "?addlayerlabels=true&access_token=" +
    encodeURIComponent(mapboxToken);

  let mapBuffer;
  try {
    const mapRes = await fetch(mapUrl);
    if (!mapRes.ok) {
      const t = await mapRes.text();
      logError(`Mapbox error ${mapRes.status}: ${t.slice(0, 300)}`);
      return res.json({ ok: false, error: "Map image request failed", status: 502 });
    }
    mapBuffer = Buffer.from(await mapRes.arrayBuffer());
  } catch (e) {
    logError(String(e));
    return res.json({ ok: false, error: "Map fetch failed", status: 502 });
  }

  const client = new Client().setEndpoint(endpoint).setProject(projectId).setJWT(jwt);
  const storage = new Storage(client);

  const fileId = ID.unique();
  const fileName = `export-${Date.now()}.png`;

  try {
    // Storage files only allow read | update | delete | write | null — not "create".
    // `write` is the role that covers creating/updating/deleting the file for this user.
    const created = await storage.createFile(
      bucketExports,
      fileId,
      InputFile.fromBuffer(mapBuffer, fileName),
      [Permission.write(Role.user(userId))],
    );
    return res.json({
      ok: true,
      fileId: created.$id,
      bucketId: bucketExports,
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const code = e && typeof e.code === "number" ? e.code : undefined;
    const type = e && e.type ? String(e.type) : undefined;
    logError(`createFile: ${msg} code=${code} type=${type}`);
    return res.json({
      ok: false,
      error: "Failed to save export",
      detail: msg,
      code,
      type,
      hint:
        "Usually: exports bucket missing Create for Users, file size over bucket limit, or PNG not in allowed extensions. Check Appwrite → Storage → exports → Settings.",
    });
  }
};
