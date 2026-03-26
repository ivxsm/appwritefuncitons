const { Client, Storage, Permission, Role, ID } = require("node-appwrite");
const { InputFile } = require("node-appwrite/file");
const sharp = require("sharp");

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
  } catch {
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
  const bucketLogos = process.env.BUCKET_LOGOS;
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
  const width = Math.min(1280, Math.max(64, Math.round(Number(payload.width) || 1200)));
  const height = Math.min(1280, Math.max(64, Math.round(Number(payload.height) || 800)));
  const stylePath =
    typeof payload.stylePath === "string" && payload.stylePath.length > 0
      ? payload.stylePath
      : "mapbox/streets-v12";
  const logoFileId =
    typeof payload.logoFileId === "string" && payload.logoFileId.length > 0
      ? payload.logoFileId
      : null;

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.json({ ok: false, error: "Invalid coordinates", status: 400 });
  }

  if (!Number.isFinite(zoom)) zoom = 14;
  zoom = Math.min(22, Math.max(0, zoom));

  const staticPath = `${lng},${lat},${zoom},0,0/${width}x${height}@2x`;
  const mapUrl = `https://api.mapbox.com/styles/v1/${stylePath}/static/${staticPath}?access_token=${mapboxToken}`;

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

  let outBuffer = mapBuffer;

  if (logoFileId && bucketLogos) {
    try {
      const downloadUrl = `${endpoint}/storage/buckets/${bucketLogos}/files/${logoFileId}/download`;
      const logoRes = await fetch(downloadUrl, {
        headers: {
          "X-Appwrite-Project": projectId,
          "X-Appwrite-JWT": jwt,
        },
      });
      if (!logoRes.ok) {
        log(`Logo download failed ${logoRes.status}, exporting map without logo`);
      } else {
        const logoBuf = Buffer.from(await logoRes.arrayBuffer());
        const base = sharp(mapBuffer);
        const meta = await base.metadata();
        const w = meta.width || width * 2;
        const h = meta.height || height * 2;
        const targetLogoW = Math.round(w * 0.14);
        const logoPng = await sharp(logoBuf)
          .resize({ width: targetLogoW, height: targetLogoW, fit: "inside" })
          .png()
          .toBuffer();
        const lm = await sharp(logoPng).metadata();
        const lw = lm.width || targetLogoW;
        const lh = lm.height || targetLogoW;
        const margin = Math.round(w * 0.04);
        outBuffer = await base
          .composite([
            {
              input: logoPng,
              left: Math.max(0, w - lw - margin),
              top: Math.max(0, h - lh - margin),
            },
          ])
          .png()
          .toBuffer();
      }
    } catch (e) {
      logError(`Logo composite error: ${String(e)}`);
      outBuffer = mapBuffer;
    }
  }

  const client = new Client().setEndpoint(endpoint).setProject(projectId).setJWT(jwt);
  const storage = new Storage(client);

  const fileId = ID.unique();
  const fileName = `export-${Date.now()}.png`;

  try {
    const created = await storage.createFile(
      bucketExports,
      fileId,
      InputFile.fromBuffer(outBuffer, fileName),
      [Permission.read(Role.user(userId))],
    );
    return res.json({
      ok: true,
      fileId: created.$id,
      bucketId: bucketExports,
    });
  } catch (e) {
    logError(String(e && e.message ? e.message : e));
    return res.json({ ok: false, error: "Failed to save export", status: 500 });
  }
};
