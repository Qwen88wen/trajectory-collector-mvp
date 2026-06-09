const MAX_POINTS_PER_TRACK = 50000;

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const supabaseUrl = trimTrailingSlash(process.env.SUPABASE_URL || "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: "Supabase environment variables are missing" });
    return;
  }

  try {
    const body = parseBody(req.body);
    const payload = normalizeTrack(body);
    const response = await fetch(`${supabaseUrl}/rest/v1/tracks?on_conflict=id`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.status(502).json({ error: "Supabase insert failed", detail: errorText });
      return;
    }

    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error.message || "Invalid track payload" });
  }
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseBody(body) {
  if (!body) {
    throw new Error("Request body is required");
  }

  if (typeof body === "string") {
    return JSON.parse(body);
  }

  return body;
}

function normalizeTrack(track) {
  if (!track || typeof track !== "object") {
    throw new Error("Track payload must be an object");
  }

  if (!track.id || typeof track.id !== "string" || track.id.length > 128) {
    throw new Error("Track id is required");
  }

  if (!isIsoDate(track.startedAt)) {
    throw new Error("startedAt must be an ISO date string");
  }

  if (track.stoppedAt && !isIsoDate(track.stoppedAt)) {
    throw new Error("stoppedAt must be an ISO date string");
  }

  if (!Array.isArray(track.points) || track.points.length === 0) {
    throw new Error("points must be a non-empty array");
  }

  if (track.points.length > MAX_POINTS_PER_TRACK) {
    throw new Error(`points cannot exceed ${MAX_POINTS_PER_TRACK}`);
  }

  const points = track.points.map(normalizePoint);

  return {
    id: track.id,
    started_at: track.startedAt,
    stopped_at: track.stoppedAt || null,
    point_count: Number.isFinite(track.pointCount) ? track.pointCount : points.length,
    distance_meters: Number.isFinite(track.distanceMeters) ? track.distanceMeters : null,
    points,
    client: sanitizeJsonObject(track.client),
  };
}

function normalizePoint(point) {
  if (!point || typeof point !== "object") {
    throw new Error("Each point must be an object");
  }

  const lng = Number(point.lng ?? point.longitude);
  const lat = Number(point.lat ?? point.latitude);

  if (!isValidLng(lng)) {
    throw new Error("Point lng is invalid");
  }

  if (!isValidLat(lat)) {
    throw new Error("Point lat is invalid");
  }

  if (!isIsoDate(point.timestamp)) {
    throw new Error("Point timestamp must be an ISO date string");
  }

  const speed = toNullableNumber(point.speed);
  const heading = toNullableHeading(point.heading);
  const computedSpeed = toNullableNumber(point.computedSpeed);
  const computedHeading = toNullableHeading(point.computedHeading);

  return {
    lng,
    lat,
    timestamp: point.timestamp,
    accuracy: toNullableNumber(point.accuracy),
    speed,
    heading,
    altitude: toNullableNumber(point.altitude),
    computedSpeed,
    computedHeading,
    distanceFromPrevious: toNullableNumber(point.distanceFromPrevious),
    timeFromPrevious: toNullableNumber(point.timeFromPrevious),
    speedSource: normalizeValueSource(point.speedSource, speed, computedSpeed),
    headingSource: normalizeValueSource(point.headingSource, heading, computedHeading),
  };
}

function isValidLng(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function isValidLat(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeValueSource(value, deviceValue, computedValue) {
  if (value === "device" && deviceValue !== null) {
    return "device";
  }

  if (value === "computed" && computedValue !== null) {
    return "computed";
  }

  if (value === "none") {
    return "none";
  }

  if (deviceValue !== null) {
    return "device";
  }

  if (computedValue !== null) {
    return "computed";
  }

  return "none";
}

function toNullableHeading(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  if (number < 0 || number > 360) {
    return null;
  }

  return number;
}

function sanitizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
