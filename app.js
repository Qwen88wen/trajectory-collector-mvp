(function () {
  "use strict";

  const DB_NAME = "trajectory-collector-mvp";
  const DB_VERSION = 1;
  const TRACK_STORE = "tracks";
  const SAMPLE_INTERVAL_MS = 3000;
  const DEFAULT_UPLOAD_URL = "/api/tracks";
  const GEO_OPTIONS = {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  };

  const els = {
    networkStatus: document.querySelector("#networkStatus"),
    recordingStatus: document.querySelector("#recordingStatus"),
    syncStatus: document.querySelector("#syncStatus"),
    startButton: document.querySelector("#startButton"),
    stopButton: document.querySelector("#stopButton"),
    syncButton: document.querySelector("#syncButton"),
    exportGeojsonButton: document.querySelector("#exportGeojsonButton"),
    exportJsonButton: document.querySelector("#exportJsonButton"),
    uploadUrl: document.querySelector("#uploadUrl"),
    pointCount: document.querySelector("#pointCount"),
    accuracyValue: document.querySelector("#accuracyValue"),
    distanceValue: document.querySelector("#distanceValue"),
    durationValue: document.querySelector("#durationValue"),
    mapMeta: document.querySelector("#mapMeta"),
    routeList: document.querySelector("#routeList"),
    canvas: document.querySelector("#trackCanvas"),
  };

  const state = {
    db: null,
    currentTrack: null,
    selectedTrack: null,
    watchId: null,
    sampleTimer: null,
    lastSavedAt: 0,
    durationTimer: null,
    syncing: false,
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      state.db = await openDatabase();
      bindEvents();
      loadUploadUrl();
      updateNetworkStatus();
      await registerServiceWorker();
      await renderRoutes();
      drawTrack(null);
      updateMetrics(null);

      if (!window.isSecureContext) {
        els.recordingStatus.textContent = "GPS requires HTTPS or localhost";
        els.startButton.disabled = true;
      }

      if (navigator.onLine) {
        syncPendingTracks({ silent: true });
      }
    } catch (error) {
      els.recordingStatus.textContent = "Startup failed";
      els.syncStatus.textContent = error.message || String(error);
    }
  }

  function bindEvents() {
    els.startButton.addEventListener("click", startRecording);
    els.stopButton.addEventListener("click", stopRecording);
    els.syncButton.addEventListener("click", () => syncPendingTracks({ silent: false }));
    els.exportGeojsonButton.addEventListener("click", exportGeojsonTracks);
    els.exportJsonButton.addEventListener("click", exportBackupJson);
    els.uploadUrl.addEventListener("change", saveUploadUrl);
    els.uploadUrl.addEventListener("blur", saveUploadUrl);
    window.addEventListener("online", () => {
      updateNetworkStatus();
      syncPendingTracks({ silent: false });
    });
    window.addEventListener("offline", updateNetworkStatus);
    window.addEventListener("resize", () => drawTrack(state.selectedTrack || state.currentTrack));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        renderRoutes();
        syncPendingTracks({ silent: true });
      }
    });
  }

  function loadUploadUrl() {
    els.uploadUrl.value = localStorage.getItem("trackUploadUrl") || DEFAULT_UPLOAD_URL;
  }

  function saveUploadUrl() {
    const value = els.uploadUrl.value.trim() || DEFAULT_UPLOAD_URL;
    els.uploadUrl.value = value;
    localStorage.setItem("trackUploadUrl", value);
    els.syncStatus.textContent = "Upload URL saved";
  }

  async function startRecording() {
    if (state.currentTrack) {
      return;
    }

    if (!navigator.geolocation) {
      els.recordingStatus.textContent = "Geolocation is not available";
      return;
    }

    const now = new Date().toISOString();
    const track = {
      id: createId(),
      status: "recording",
      startedAt: now,
      stoppedAt: null,
      updatedAt: now,
      syncedAt: null,
      uploadAttempts: 0,
      lastUploadError: null,
      points: [],
    };

    await putTrack(track);
    state.currentTrack = track;
    state.selectedTrack = track;
    state.lastSavedAt = 0;
    setRecordingMode(true);
    els.recordingStatus.textContent = "Acquiring GPS";
    els.syncStatus.textContent = "Recording is saved locally";
    startDurationTimer();
    updateMetrics(track);
    drawTrack(track);
    await renderRoutes();

    state.watchId = navigator.geolocation.watchPosition(
      (position) => handlePosition(position),
      (error) => handleGeoError(error),
      GEO_OPTIONS,
    );
    requestCurrentPosition();
    state.sampleTimer = window.setInterval(requestCurrentPosition, SAMPLE_INTERVAL_MS);
  }

  async function stopRecording() {
    if (!state.currentTrack) {
      return;
    }

    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    stopSampleTimer();

    const stoppedTrack = {
      ...state.currentTrack,
      status: "pending",
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await putTrack(stoppedTrack);
    state.currentTrack = null;
    state.selectedTrack = stoppedTrack;
    setRecordingMode(false);
    stopDurationTimer();
    updateMetrics(stoppedTrack);
    drawTrack(stoppedTrack);
    await renderRoutes();
    els.recordingStatus.textContent = `Stopped with ${stoppedTrack.points.length} points`;

    if (navigator.onLine) {
      await syncPendingTracks({ silent: false });
    } else {
      els.syncStatus.textContent = "Offline. Track saved locally";
    }
  }

  function requestCurrentPosition() {
    if (!state.currentTrack || !navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => handlePosition(position),
      (error) => handleGeoError(error),
      GEO_OPTIONS,
    );
  }

  function stopSampleTimer() {
    if (state.sampleTimer) {
      window.clearInterval(state.sampleTimer);
      state.sampleTimer = null;
    }
  }

  async function handlePosition(position) {
    if (!state.currentTrack) {
      return;
    }

    const positionTime = position.timestamp || Date.now();
    if (
      state.currentTrack.points.length > 0 &&
      positionTime - state.lastSavedAt < SAMPLE_INTERVAL_MS
    ) {
      return;
    }

    state.lastSavedAt = positionTime;
    const point = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: new Date(positionTime).toISOString(),
    };

    const updatedTrack = {
      ...state.currentTrack,
      updatedAt: new Date().toISOString(),
      points: [...state.currentTrack.points, point],
    };

    state.currentTrack = updatedTrack;
    state.selectedTrack = updatedTrack;
    await putTrack(updatedTrack);
    updateMetrics(updatedTrack);
    drawTrack(updatedTrack);
    await renderRoutes();
    els.recordingStatus.textContent = `Recording every ${SAMPLE_INTERVAL_MS / 1000}s`;
  }

  function handleGeoError(error) {
    const messages = {
      1: "Location permission denied",
      2: "Location unavailable",
      3: "GPS request timed out",
    };
    els.recordingStatus.textContent = messages[error.code] || "GPS error";
  }

  function setRecordingMode(isRecording) {
    els.startButton.disabled = isRecording || !window.isSecureContext;
    els.stopButton.disabled = !isRecording;
  }

  function startDurationTimer() {
    stopDurationTimer();
    state.durationTimer = window.setInterval(() => {
      updateMetrics(state.currentTrack || state.selectedTrack);
    }, 1000);
  }

  function stopDurationTimer() {
    if (state.durationTimer) {
      window.clearInterval(state.durationTimer);
      state.durationTimer = null;
    }
  }

  async function syncPendingTracks({ silent }) {
    if (state.syncing) {
      return;
    }

    if (!navigator.onLine) {
      if (!silent) {
        els.syncStatus.textContent = "Offline. Pending tracks stay local";
      }
      return;
    }

    const tracks = await getAllTracks();
    const pendingTracks = tracks.filter(
      (track) => track.status !== "synced" && track.status !== "recording" && track.points.length > 0,
    );

    if (pendingTracks.length === 0) {
      if (!silent) {
        els.syncStatus.textContent = "No pending tracks";
      }
      return;
    }

    state.syncing = true;
    els.syncButton.disabled = true;
    els.syncStatus.textContent = `Syncing ${pendingTracks.length} track(s)`;

    let synced = 0;
    let failed = 0;

    for (const track of pendingTracks) {
      const attemptTrack = {
        ...track,
        uploadAttempts: (track.uploadAttempts || 0) + 1,
      };

      try {
        await uploadTrack(attemptTrack);
        const syncedTrack = {
          ...attemptTrack,
          status: "synced",
          syncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUploadError: null,
        };
        await putTrack(syncedTrack);
        if (state.selectedTrack && state.selectedTrack.id === syncedTrack.id) {
          state.selectedTrack = syncedTrack;
        }
        synced += 1;
      } catch (error) {
        const failedTrack = {
          ...attemptTrack,
          status: "failed",
          updatedAt: new Date().toISOString(),
          lastUploadError: error.message || String(error),
        };
        await putTrack(failedTrack);
        if (state.selectedTrack && state.selectedTrack.id === failedTrack.id) {
          state.selectedTrack = failedTrack;
        }
        failed += 1;
      }
    }

    state.syncing = false;
    els.syncButton.disabled = false;
    els.syncStatus.textContent =
      failed > 0 ? `Synced ${synced}, ${failed} still pending` : `Synced ${synced} track(s)`;
    await renderRoutes();
  }

  async function uploadTrack(track) {
    const uploadUrl = els.uploadUrl.value.trim() || DEFAULT_UPLOAD_URL;
    const payload = {
      id: track.id,
      startedAt: track.startedAt,
      stoppedAt: track.stoppedAt,
      pointCount: track.points.length,
      distanceMeters: Math.round(calculateDistance(track.points)),
      points: track.points,
      client: {
        userAgent: navigator.userAgent,
        uploadedAt: new Date().toISOString(),
      },
    };

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Upload failed: HTTP ${response.status}`);
    }
  }

  async function renderRoutes() {
    const tracks = await getAllTracks();
    tracks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    els.routeList.replaceChildren();

    if (tracks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No saved tracks";
      els.routeList.append(empty);
      return;
    }

    for (const track of tracks) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "route-item";
      if (state.selectedTrack && state.selectedTrack.id === track.id) {
        item.classList.add("active");
      }

      const summary = document.createElement("span");
      const title = document.createElement("span");
      const subtitle = document.createElement("span");
      const badge = document.createElement("span");

      summary.className = "route-summary";
      title.className = "route-title";
      subtitle.className = "route-subtitle";
      badge.className = `route-badge ${track.status}`;

      title.textContent = formatTrackTitle(track);
      subtitle.textContent = `${track.points.length} points · ${formatDistance(calculateDistance(track.points))}`;
      badge.textContent = track.status;

      summary.append(title, subtitle);
      item.append(summary, badge);
      item.addEventListener("click", () => {
        state.selectedTrack = track;
        updateMetrics(track);
        drawTrack(track);
        renderRoutes();
      });
      els.routeList.append(item);
    }
  }

  async function exportGeojsonTracks() {
    const tracks = await getAllTracks();
    const geojson = tracksToGeojson(tracks);

    if (geojson.features.length === 0) {
      els.syncStatus.textContent = "No GPS points to export";
      return;
    }

    downloadJson(
      geojson,
      `tracks-${new Date().toISOString().slice(0, 10)}.geojson`,
      "application/geo+json",
    );
    els.syncStatus.textContent = `Exported ${geojson.features.length} GeoJSON feature(s)`;
  }

  async function exportBackupJson() {
    const tracks = await getAllTracks();
    if (tracks.length === 0) {
      els.syncStatus.textContent = "No tracks to backup";
      return;
    }

    downloadJson(
      { exportedAt: new Date().toISOString(), format: "trajectory-collector-backup", tracks },
      `tracks-backup-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json",
    );
    els.syncStatus.textContent = `Backed up ${tracks.length} track(s)`;
  }

  function downloadJson(data, filename, type) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function tracksToGeojson(tracks) {
    const features = tracks
      .filter((track) => Array.isArray(track.points) && track.points.length > 0)
      .map((track) => {
        const coordinates = track.points.map((point) => [point.longitude, point.latitude]);
        const geometry =
          coordinates.length === 1
            ? { type: "Point", coordinates: coordinates[0] }
            : { type: "LineString", coordinates };

        return {
          type: "Feature",
          geometry,
          properties: {
            id: track.id,
            status: track.status,
            startedAt: track.startedAt,
            stoppedAt: track.stoppedAt,
            syncedAt: track.syncedAt,
            pointCount: track.points.length,
            distanceMeters: Math.round(calculateDistance(track.points)),
            firstTimestamp: track.points[0]?.timestamp || null,
            lastTimestamp: track.points[track.points.length - 1]?.timestamp || null,
          },
        };
      });

    return {
      type: "FeatureCollection",
      name: "trajectory-collector-tracks",
      generatedAt: new Date().toISOString(),
      features,
    };
  }

  function updateNetworkStatus() {
    const online = navigator.onLine;
    els.networkStatus.textContent = online ? "Online" : "Offline";
    els.networkStatus.classList.toggle("online", online);
    els.networkStatus.classList.toggle("offline", !online);
  }

  function updateMetrics(track) {
    if (!track) {
      els.pointCount.textContent = "0";
      els.accuracyValue.textContent = "--";
      els.distanceValue.textContent = "0 m";
      els.durationValue.textContent = "00:00";
      els.mapMeta.textContent = "No route";
      return;
    }

    const lastPoint = track.points[track.points.length - 1];
    els.pointCount.textContent = String(track.points.length);
    els.accuracyValue.textContent = lastPoint ? `±${Math.round(lastPoint.accuracy)} m` : "--";
    els.distanceValue.textContent = formatDistance(calculateDistance(track.points));
    els.durationValue.textContent = formatDuration(track);
    els.mapMeta.textContent = `${track.status} · ${formatTrackTitle(track)}`;
  }

  function drawTrack(track) {
    const canvas = els.canvas;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMapBackground(ctx, width, height);

    if (!track || track.points.length === 0) {
      drawCanvasLabel(ctx, width, height, "Waiting for GPS");
      return;
    }

    const points = track.points;
    const projector = createProjector(points, width, height);
    const screenPoints = points.map(projector.toScreen);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
    ctx.lineWidth = 8;
    drawPolyline(ctx, screenPoints);

    ctx.strokeStyle = "#00d2b8";
    ctx.lineWidth = 4;
    drawPolyline(ctx, screenPoints);

    const start = screenPoints[0];
    const last = screenPoints[screenPoints.length - 1];
    drawPoint(ctx, start.x, start.y, "#ffffff", "#00d2b8", 5);

    const lastPoint = points[points.length - 1];
    if (lastPoint.accuracy) {
      const radius = clamp(lastPoint.accuracy * projector.scale, 9, 92);
      ctx.beginPath();
      ctx.arc(last.x, last.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 210, 184, 0.13)";
      ctx.strokeStyle = "rgba(0, 210, 184, 0.38)";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }

    drawPoint(ctx, last.x, last.y, "#101820", "#ffffff", 7);
  }

  function drawMapBackground(ctx, width, height) {
    ctx.fillStyle = "#101820";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x <= width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  function drawCanvasLabel(ctx, width, height, text) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, height / 2);
  }

  function drawPolyline(ctx, points) {
    if (points.length === 1) {
      drawPoint(ctx, points[0].x, points[0].y, "#101820", "#ffffff", 7);
      return;
    }

    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.stroke();
  }

  function drawPoint(ctx, x, y, fill, stroke, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();
  }

  function createProjector(points, width, height) {
    const meanLat =
      points.reduce((total, point) => total + point.latitude, 0) / Math.max(1, points.length);
    const metersPerLon = 111320 * Math.cos((meanLat * Math.PI) / 180);
    const metersPerLat = 110540;
    const projected = points.map((point) => ({
      x: point.longitude * metersPerLon,
      y: point.latitude * metersPerLat,
    }));

    let minX = Math.min(...projected.map((point) => point.x));
    let maxX = Math.max(...projected.map((point) => point.x));
    let minY = Math.min(...projected.map((point) => point.y));
    let maxY = Math.max(...projected.map((point) => point.y));

    if (maxX - minX < 20) {
      const mid = (minX + maxX) / 2;
      minX = mid - 10;
      maxX = mid + 10;
    }

    if (maxY - minY < 20) {
      const mid = (minY + maxY) / 2;
      minY = mid - 10;
      maxY = mid + 10;
    }

    const padding = Math.min(42, Math.max(22, Math.min(width, height) * 0.08));
    const innerWidth = Math.max(1, width - padding * 2);
    const innerHeight = Math.max(1, height - padding * 2);
    const scale = Math.min(innerWidth / (maxX - minX), innerHeight / (maxY - minY));
    const mapWidth = (maxX - minX) * scale;
    const mapHeight = (maxY - minY) * scale;
    const left = (width - mapWidth) / 2;
    const top = (height - mapHeight) / 2;

    return {
      scale,
      toScreen(point) {
        const x = point.longitude * metersPerLon;
        const y = point.latitude * metersPerLat;
        return {
          x: left + (x - minX) * scale,
          y: top + mapHeight - (y - minY) * scale,
        };
      },
    };
  }

  function calculateDistance(points) {
    if (!points || points.length < 2) {
      return 0;
    }

    let meters = 0;
    for (let index = 1; index < points.length; index += 1) {
      meters += haversine(points[index - 1], points[index]);
    }
    return meters;
  }

  function haversine(a, b) {
    const earthRadius = 6371000;
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const lat1 = toRadians(a.latitude);
    const lat2 = toRadians(b.latitude);
    const value =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function toRadians(value) {
    return (value * Math.PI) / 180;
  }

  function formatDistance(meters) {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  }

  function formatDuration(track) {
    if (!track) {
      return "00:00";
    }

    const start = new Date(track.startedAt).getTime();
    const end = track.stoppedAt ? new Date(track.stoppedAt).getTime() : Date.now();
    const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
        seconds,
      ).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function formatTrackTitle(track) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(track.startedAt));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `track-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(TRACK_STORE, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function putTrack(track) {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(TRACK_STORE, "readwrite");
      transaction.objectStore(TRACK_STORE).put(track);
      transaction.oncomplete = () => resolve(track);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function getAllTracks() {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(TRACK_STORE, "readonly");
      const request = transaction.objectStore(TRACK_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      return;
    }

    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (error) {
      els.syncStatus.textContent = `Offline cache unavailable: ${error.message}`;
    }
  }
})();
