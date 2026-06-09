(function () {
  "use strict";

  const DB_NAME = "trajectory-collector-mvp";
  const DB_VERSION = 1;
  const TRACK_STORE = "tracks";
  const SAMPLE_INTERVAL_MS = 1000;
  const MIN_DISTANCE_DELTA_METERS = 3;
  const DISPLAY_MAX_ACCURACY_METERS = 30;
  const DISPLAY_MAX_SPEED_METERS_PER_SECOND = 33.33;
  const DISPLAY_MAX_JUMP_METERS = 200;
  const DISPLAY_JUMP_WINDOW_SECONDS = 10;
  const MOVING_SPEED_THRESHOLD_METERS_PER_SECOND = 1 / 3.6;
  const STALE_POSITION_TOLERANCE_MS = 1000;
  const MAX_POSITION_AGE_MS = 10000;
  const STATIONARY_DRIFT_DISTANCE_METERS = 5;
  const STATIONARY_DRIFT_MAX_ACCURACY_METERS = 25;
  const LOW_SPEED_DRIFT_MAX_METERS_PER_SECOND = 2 / 3.6;
  const WALKING_START_SPEED_METERS_PER_SECOND = 2 / 3.6;
  const LOW_SPEED_CONFIRMATION_MIN_DISTANCE_METERS = 6;
  const LOW_SPEED_CONFIRMATION_MAX_DISTANCE_METERS = 12;
  const LOW_SPEED_CONFIRMATION_MAX_RADIUS_METERS = 35;
  const LOW_SPEED_CONFIRMATION_MIN_STEP_METERS = 2;
  const LOW_SPEED_CONFIRMATION_PROGRESS_METERS = 2;
  const LOW_SPEED_CONFIRMATION_BEARING_DEGREES = 70;
  const LOW_SPEED_CONFIRMATION_MAX_AGE_MS = 20000;
  const LOW_SPEED_CONFIRMATION_BACKTRACK_METERS = 3;
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
    displayPointCount: document.querySelector("#displayPointCount"),
    filteredPointCount: document.querySelector("#filteredPointCount"),
    accuracyValue: document.querySelector("#accuracyValue"),
    gpsQualityMetric: document.querySelector("#gpsQualityMetric"),
    gpsQualityValue: document.querySelector("#gpsQualityValue"),
    distanceValue: document.querySelector("#distanceValue"),
    displayDistanceValue: document.querySelector("#displayDistanceValue"),
    durationValue: document.querySelector("#durationValue"),
    movingTimeValue: document.querySelector("#movingTimeValue"),
    stoppedTimeValue: document.querySelector("#stoppedTimeValue"),
    averageSpeedValue: document.querySelector("#averageSpeedValue"),
    movingAverageSpeedValue: document.querySelector("#movingAverageSpeedValue"),
    maxSpeedValue: document.querySelector("#maxSpeedValue"),
    currentSpeedValue: document.querySelector("#currentSpeedValue"),
    currentDirectionValue: document.querySelector("#currentDirectionValue"),
    speedSourceValue: document.querySelector("#speedSourceValue"),
    headingSourceValue: document.querySelector("#headingSourceValue"),
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
    pendingMovementPoint: null,
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
    state.lastSavedAt = Date.parse(now);
    state.pendingMovementPoint = null;
    setRecordingMode(true);
    els.recordingStatus.textContent = `${formatTrackStatus(track.status)} - acquiring GPS`;
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
    state.pendingMovementPoint = null;
    setRecordingMode(false);
    stopDurationTimer();
    updateMetrics(stoppedTrack);
    drawTrack(stoppedTrack);
    await renderRoutes();
    els.recordingStatus.textContent = `${formatTrackStatus(stoppedTrack.status)} - stopped with ${stoppedTrack.points.length} points`;

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

  function createPointFromPosition(position, positionTime) {
    return normalizeTrackPoint({
      lng: position.coords.longitude,
      lat: position.coords.latitude,
      timestamp: new Date(positionTime).toISOString(),
      accuracy: position.coords.accuracy,
      speed: position.coords.speed,
      heading: position.coords.heading,
      altitude: position.coords.altitude,
    });
  }

  async function handlePosition(position) {
    if (!state.currentTrack) {
      return;
    }

    const positionTime = position.timestamp || Date.now();
    if (isStalePosition(positionTime, state.currentTrack)) {
      els.recordingStatus.textContent = `${formatTrackStatus(state.currentTrack.status)} - ignoring stale GPS fix`;
      return;
    }

    const lastPoint = state.currentTrack.points[state.currentTrack.points.length - 1];
    const point = addComputedPointValues(createPointFromPosition(position, positionTime), lastPoint);
    if (!point) {
      els.recordingStatus.textContent = "Invalid GPS coordinate";
      return;
    }

    if (lastPoint) {
      const elapsedMs = positionTime - state.lastSavedAt;
      const movedMeters = point.distanceFromPrevious || 0;

      if (isStationaryDriftPoint(point, lastPoint)) {
        state.pendingMovementPoint = null;
        els.recordingStatus.textContent = `${formatTrackStatus(state.currentTrack.status)} - stationary GPS drift ignored`;
        return;
      }

      if (needsLowSpeedMovementConfirmation(point, lastPoint)) {
        if (!confirmsLowSpeedMovement(point, lastPoint)) {
          if (shouldReplacePendingMovementPoint(point, lastPoint)) {
            state.pendingMovementPoint = point;
          }
          els.recordingStatus.textContent = `${formatTrackStatus(state.currentTrack.status)} - confirming low-speed movement`;
          return;
        }
      }

      if (elapsedMs < SAMPLE_INTERVAL_MS && movedMeters < MIN_DISTANCE_DELTA_METERS) {
        return;
      }
    }

    state.lastSavedAt = positionTime;
    state.pendingMovementPoint = null;

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
    els.recordingStatus.textContent = `${formatTrackStatus(updatedTrack.status)} - saving movement every ${
      SAMPLE_INTERVAL_MS / 1000
    }s or ${MIN_DISTANCE_DELTA_METERS}m`;
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
        els.syncStatus.textContent = "No Pending Upload tracks";
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
      failed > 0
        ? `Synced ${synced} track(s), ${failed} Failed`
        : `Synced ${synced} track(s)`;
    await renderRoutes();
  }

  async function uploadTrack(track) {
    const uploadUrl = els.uploadUrl.value.trim() || DEFAULT_UPLOAD_URL;
    const points = normalizeTrackPoints(track.points);
    const payload = {
      id: track.id,
      startedAt: track.startedAt,
      stoppedAt: track.stoppedAt,
      pointCount: points.length,
      distanceMeters: Math.round(calculateDistance(points)),
      points,
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
      badge.textContent = formatTrackStatus(track.status);

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
        const points = normalizeTrackPoints(track.points);
        const coordinates = points.map(point => [point.lng, point.lat]);
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
            pointCount: points.length,
            distanceMeters: Math.round(calculateDistance(points)),
            firstTimestamp: points[0]?.timestamp || null,
            lastTimestamp: points[points.length - 1]?.timestamp || null,
          },
        };
      })
      .filter((feature) => feature.geometry.coordinates.length > 0);

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
      els.displayPointCount.textContent = "0";
      els.filteredPointCount.textContent = "0";
      els.accuracyValue.textContent = "--";
      setGpsQuality(null);
      els.distanceValue.textContent = "0 m";
      els.displayDistanceValue.textContent = "0 m";
      els.durationValue.textContent = "00:00";
      els.movingTimeValue.textContent = "00:00";
      els.stoppedTimeValue.textContent = "00:00";
      els.averageSpeedValue.textContent = "--";
      els.movingAverageSpeedValue.textContent = "--";
      els.maxSpeedValue.textContent = "--";
      els.currentSpeedValue.textContent = "--";
      els.currentDirectionValue.textContent = "--";
      els.speedSourceValue.textContent = "--";
      els.headingSourceValue.textContent = "--";
      els.mapMeta.textContent = "No route";
      return;
    }

    const points = normalizeTrackPoints(track.points);
    const lastPoint = points[points.length - 1];
    const displayPoints = getDisplayTrackPoints(points);
    const hiddenPointCount = Math.max(0, points.length - displayPoints.length);
    const filteredRatio = points.length > 0 ? hiddenPointCount / points.length : 0;
    const movementStats = calculateMovementStats(track, displayPoints);
    const speed = getDisplaySpeed(lastPoint);
    const heading = getDisplayHeading(lastPoint);

    els.pointCount.textContent = String(points.length);
    els.displayPointCount.textContent = String(displayPoints.length);
    els.filteredPointCount.textContent = String(hiddenPointCount);
    els.accuracyValue.textContent =
      lastPoint && Number.isFinite(getPointAccuracy(lastPoint))
        ? `±${Math.round(getPointAccuracy(lastPoint))} m`
        : "--";
    setGpsQuality(getGpsQuality(getPointAccuracy(lastPoint), filteredRatio, points.length));
    els.distanceValue.textContent = formatDistance(calculateDistance(points));
    els.displayDistanceValue.textContent = formatDistance(movementStats.distanceMeters);
    els.durationValue.textContent = formatDuration(track);
    els.movingTimeValue.textContent = formatDurationSeconds(movementStats.movingSeconds);
    els.stoppedTimeValue.textContent = formatDurationSeconds(movementStats.stoppedSeconds);
    els.averageSpeedValue.textContent = formatSpeed(movementStats.averageSpeed);
    els.movingAverageSpeedValue.textContent = formatSpeed(movementStats.movingAverageSpeed);
    els.maxSpeedValue.textContent = formatSpeed(movementStats.maxSpeed);
    els.currentSpeedValue.textContent = formatSpeed(speed.value);
    els.currentDirectionValue.textContent = formatHeading(heading.value);
    els.speedSourceValue.textContent = formatValueSource(speed.source);
    els.headingSourceValue.textContent = formatValueSource(heading.source);
    const statusLabel = formatTrackStatus(track.status);
    els.mapMeta.textContent =
      hiddenPointCount > 0
        ? `${statusLabel} · ${formatTrackTitle(track)} · ${hiddenPointCount} filtered`
        : `${statusLabel} · ${formatTrackTitle(track)}`;
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

    const points = getDisplayTrackPoints(track.points);
    if (points.length === 0) {
      drawCanvasLabel(ctx, width, height, "No reliable GPS points");
      return;
    }

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

    const last = screenPoints[screenPoints.length - 1];
    const lastPoint = points[points.length - 1];
    const lastAccuracy = getPointAccuracy(lastPoint);
    if (Number.isFinite(lastAccuracy)) {
      const radius = clamp(lastAccuracy * projector.scale, 9, 92);
      ctx.beginPath();
      ctx.arc(last.x, last.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 210, 184, 0.13)";
      ctx.strokeStyle = "rgba(0, 210, 184, 0.38)";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }

    drawRouteMarkers(ctx, screenPoints, points, track.status === "recording");
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

  function drawRouteMarkers(ctx, screenPoints, trackPoints, isRecording) {
    if (screenPoints.length === 0) {
      return;
    }

    const start = screenPoints[0];
    const last = screenPoints[screenPoints.length - 1];
    const lastTrackPoint = trackPoints[trackPoints.length - 1];
    drawRouteMarker(ctx, start, "start");
    drawRouteMarker(ctx, last, isRecording ? "current" : "end");

    if (isRecording) {
      drawHeadingArrow(ctx, last, getDisplayHeading(lastTrackPoint).value);
    }
  }

  function drawRouteMarker(ctx, point, type) {
    const config = {
      start: {
        fill: "#00d2b8",
        stroke: "#ffffff",
        text: "#101820",
        label: "S",
      },
      current: {
        fill: "#ffffff",
        stroke: "#00d2b8",
        text: "#006f64",
        label: "C",
      },
      end: {
        fill: "#c83f49",
        stroke: "#ffffff",
        text: "#ffffff",
        label: "E",
      },
    }[type];

    if (!config) {
      return;
    }

    ctx.beginPath();
    ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(16, 24, 32, 0.28)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = config.fill;
    ctx.strokeStyle = config.stroke;
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = config.text;
    ctx.font = "800 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(config.label, point.x, point.y + 0.5);
  }

  function drawHeadingArrow(ctx, point, heading) {
    if (heading === null || !Number.isFinite(heading)) {
      return;
    }

    const radians = toRadians(heading);
    const direction = {
      x: Math.sin(radians),
      y: -Math.cos(radians),
    };
    const start = {
      x: point.x + direction.x * 16,
      y: point.y + direction.y * 16,
    };
    const tip = {
      x: point.x + direction.x * 34,
      y: point.y + direction.y * 34,
    };
    const wingLength = 8;
    const wingAngle = Math.PI * 0.78;
    const leftWing = {
      x: tip.x + Math.sin(radians + wingAngle) * wingLength,
      y: tip.y - Math.cos(radians + wingAngle) * wingLength,
    };
    const rightWing = {
      x: tip.x + Math.sin(radians - wingAngle) * wingLength,
      y: tip.y - Math.cos(radians - wingAngle) * wingLength,
    };

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(16, 24, 32, 0.44)";
    ctx.lineWidth = 7;
    drawArrowPath(ctx, start, tip, leftWing, rightWing);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    drawArrowPath(ctx, start, tip, leftWing, rightWing);
    ctx.strokeStyle = "#006f64";
    ctx.lineWidth = 2;
    drawArrowPath(ctx, start, tip, leftWing, rightWing);
    ctx.restore();
  }

  function drawArrowPath(ctx, start, tip, leftWing, rightWing) {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.moveTo(leftWing.x, leftWing.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(rightWing.x, rightWing.y);
    ctx.stroke();
  }

  function createProjector(points, width, height) {
    const validPoints = normalizeTrackPoints(points);
    const meanLat =
      validPoints.reduce((total, point) => total + point.lat, 0) /
      Math.max(1, validPoints.length);
    const metersPerLon = 111320 * Math.cos((meanLat * Math.PI) / 180);
    const metersPerLat = 110540;
    const projected = validPoints.map((point) => ({
      x: point.lng * metersPerLon,
      y: point.lat * metersPerLat,
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
        const x = point.lng * metersPerLon;
        const y = point.lat * metersPerLat;
        return {
          x: left + (x - minX) * scale,
          y: top + mapHeight - (y - minY) * scale,
        };
      },
    };
  }

  function calculateDistance(points) {
    const validPoints = normalizeTrackPoints(points);
    if (validPoints.length < 2) {
      return 0;
    }

    let meters = 0;
    for (let index = 1; index < validPoints.length; index += 1) {
      meters += haversine(validPoints[index - 1], validPoints[index]);
    }
    return meters;
  }

  function calculateMovementStats(track, points) {
    const displayPoints = normalizeTrackPoints(points);
    const totalSeconds = getTrackDurationSeconds(track);
    const distanceMeters = calculateDistance(displayPoints);
    let movingSeconds = 0;

    for (let index = 1; index < displayPoints.length; index += 1) {
      const previousPoint = displayPoints[index - 1];
      const point = displayPoints[index];
      const elapsedSeconds = getElapsedSeconds(previousPoint, point);

      if (elapsedSeconds <= 0) {
        continue;
      }

      const segmentSpeed = haversine(previousPoint, point) / elapsedSeconds;
      if (segmentSpeed > MOVING_SPEED_THRESHOLD_METERS_PER_SECOND) {
        movingSeconds += elapsedSeconds;
      }
    }

    return {
      distanceMeters,
      movingSeconds,
      stoppedSeconds: Math.max(0, totalSeconds - movingSeconds),
      averageSpeed: totalSeconds > 0 ? distanceMeters / totalSeconds : null,
      movingAverageSpeed: movingSeconds > 0 ? distanceMeters / movingSeconds : null,
      maxSpeed: calculateMaxSpeed(displayPoints),
    };
  }

  function calculateMaxSpeed(points) {
    const speeds = normalizeTrackPoints(points)
      .map((point) => getDisplaySpeed(point).value)
      .filter((value) => Number.isFinite(value) && value >= 0);

    return speeds.length > 0 ? Math.max(...speeds) : null;
  }

  function haversine(a, b) {
    if (!hasValidCoordinates(a) || !hasValidCoordinates(b)) {
      return 0;
    }

    const earthRadius = 6371000;
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const value =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function calculateBearing(a, b) {
    if (!hasValidCoordinates(a) || !hasValidCoordinates(b)) {
      return null;
    }

    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const dLon = toRadians(b.lng - a.lng);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDegrees(Math.atan2(y, x)) + 360) % 360;
  }

  function toRadians(value) {
    return (value * Math.PI) / 180;
  }

  function toDegrees(value) {
    return (value * 180) / Math.PI;
  }

  function hasValidCoordinates(point) {
    return isValidLng(point?.lng) && isValidLat(point?.lat);
  }

  function getPointAccuracy(point) {
    return Number(point?.accuracy);
  }

  function isStalePosition(positionTime, track) {
    const startedAt = Date.parse(track.startedAt);
    const ageMs = Date.now() - positionTime;
    return (
      positionTime < startedAt - STALE_POSITION_TOLERANCE_MS ||
      ageMs > MAX_POSITION_AGE_MS
    );
  }

  function isStationaryDriftPoint(point, previousPoint) {
    const movedMeters = point.distanceFromPrevious || haversine(previousPoint, point);
    const uncertaintyMeters = getPointUncertaintyMeters(point, previousPoint);

    if (movedMeters === 0) {
      return true;
    }

    if (hasWalkingSpeedSignal(point) && movedMeters >= MIN_DISTANCE_DELTA_METERS) {
      return false;
    }

    if (movedMeters <= uncertaintyMeters) {
      return true;
    }

    const speed = getDisplaySpeed(point).value;
    return speed !== null && speed <= MOVING_SPEED_THRESHOLD_METERS_PER_SECOND && movedMeters < MIN_DISTANCE_DELTA_METERS;
  }

  function getPointUncertaintyMeters(point, previousPoint) {
    const accuracies = [getPointAccuracy(point), getPointAccuracy(previousPoint)].filter(Number.isFinite);
    if (accuracies.length === 0) {
      return STATIONARY_DRIFT_DISTANCE_METERS;
    }

    return clamp(
      Math.max(STATIONARY_DRIFT_DISTANCE_METERS, Math.max(...accuracies)),
      STATIONARY_DRIFT_DISTANCE_METERS,
      STATIONARY_DRIFT_MAX_ACCURACY_METERS,
    );
  }

  function getLowSpeedConfirmationDistanceMeters(point, previousPoint) {
    return clamp(
      getPointUncertaintyMeters(point, previousPoint),
      LOW_SPEED_CONFIRMATION_MIN_DISTANCE_METERS,
      LOW_SPEED_CONFIRMATION_MAX_DISTANCE_METERS,
    );
  }

  function hasLowSpeedSignal(point) {
    const speeds = [point?.speed, point?.computedSpeed].filter(Number.isFinite);
    if (speeds.length === 0) {
      return true;
    }

    return speeds.some((speed) => speed <= LOW_SPEED_DRIFT_MAX_METERS_PER_SECOND);
  }

  function hasWalkingSpeedSignal(point) {
    const speeds = [point?.speed, point?.computedSpeed].filter(Number.isFinite);
    return speeds.some((speed) => speed >= WALKING_START_SPEED_METERS_PER_SECOND);
  }

  function needsLowSpeedMovementConfirmation(point, previousPoint) {
    if (hasWalkingSpeedSignal(point)) {
      return false;
    }

    if (!hasLowSpeedSignal(point)) {
      return false;
    }

    const movedMeters = point.distanceFromPrevious || haversine(previousPoint, point);
    return movedMeters <= LOW_SPEED_CONFIRMATION_MAX_RADIUS_METERS;
  }

  function confirmsLowSpeedMovement(point, previousPoint) {
    const pendingPoint = state.pendingMovementPoint;
    if (!pendingPoint) {
      return false;
    }

    const minimumDistance = getLowSpeedConfirmationDistanceMeters(point, previousPoint);
    const pendingDistance = haversine(previousPoint, pendingPoint);
    const currentDistance = haversine(previousPoint, point);
    const candidateStepDistance = haversine(pendingPoint, point);

    if (
      currentDistance < minimumDistance ||
      currentDistance < pendingDistance + LOW_SPEED_CONFIRMATION_PROGRESS_METERS ||
      candidateStepDistance < LOW_SPEED_CONFIRMATION_MIN_STEP_METERS
    ) {
      return false;
    }

    const pendingBearing = calculateBearing(previousPoint, pendingPoint);
    const currentBearing = calculateBearing(previousPoint, point);
    return getHeadingDeltaDegrees(pendingBearing, currentBearing) <= LOW_SPEED_CONFIRMATION_BEARING_DEGREES;
  }

  function shouldReplacePendingMovementPoint(point, previousPoint) {
    const pendingPoint = state.pendingMovementPoint;
    if (!pendingPoint) {
      return true;
    }

    const pendingTime = new Date(pendingPoint.timestamp).getTime();
    const currentTime = new Date(point.timestamp).getTime();
    if (currentTime - pendingTime > LOW_SPEED_CONFIRMATION_MAX_AGE_MS) {
      return true;
    }

    const pendingDistance = haversine(previousPoint, pendingPoint);
    const currentDistance = haversine(previousPoint, point);
    return currentDistance + LOW_SPEED_CONFIRMATION_BACKTRACK_METERS < pendingDistance;
  }

  function getHeadingDeltaDegrees(a, b) {
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) {
      return 0;
    }

    const delta = Math.abs(((a - b + 540) % 360) - 180);
    return delta;
  }

  function getGpsQuality(accuracy, filteredRatio, rawPointCount) {
    if (rawPointCount === 0 || !Number.isFinite(accuracy)) {
      return { label: "--", level: "unknown" };
    }

    if (accuracy <= 10 && filteredRatio <= 0.1) {
      return { label: "Good", level: "good" };
    }

    if (accuracy <= 30 && filteredRatio <= 0.3) {
      return { label: "Fair", level: "fair" };
    }

    return { label: "Poor", level: "poor" };
  }

  function setGpsQuality(quality) {
    const nextQuality = quality || { label: "--", level: "unknown" };
    els.gpsQualityValue.textContent = nextQuality.label;
    els.gpsQualityMetric.classList.remove(
      "quality-good",
      "quality-fair",
      "quality-poor",
      "quality-unknown",
    );
    els.gpsQualityMetric.classList.add(`quality-${nextQuality.level}`);
  }

  function getDisplayTrackPoints(points) {
    const validPoints = normalizeTrackPoints(points);
    const displayPoints = [];

    for (const point of validPoints) {
      const previousDisplayPoint = displayPoints[displayPoints.length - 1];
      if (isReliableDisplayPoint(point, previousDisplayPoint)) {
        displayPoints.push(point);
      }
    }

    return displayPoints;
  }

  function isReliableDisplayPoint(point, previousDisplayPoint) {
    const accuracy = getPointAccuracy(point);
    if (Number.isFinite(accuracy) && accuracy > DISPLAY_MAX_ACCURACY_METERS) {
      return false;
    }

    if (!previousDisplayPoint) {
      return true;
    }

    const distanceMeters = haversine(previousDisplayPoint, point);
    const elapsedSeconds = getElapsedSeconds(previousDisplayPoint, point);

    if (elapsedSeconds <= 0) {
      return true;
    }

    if (
      hasLowSpeedSignal(point) &&
      distanceMeters < MIN_DISTANCE_DELTA_METERS
    ) {
      return false;
    }

    const speedMetersPerSecond = distanceMeters / elapsedSeconds;
    if (speedMetersPerSecond > DISPLAY_MAX_SPEED_METERS_PER_SECOND) {
      return false;
    }

    return !(
      elapsedSeconds <= DISPLAY_JUMP_WINDOW_SECONDS &&
      distanceMeters > DISPLAY_MAX_JUMP_METERS
    );
  }

  function getElapsedSeconds(a, b) {
    return Math.max(0, (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) / 1000);
  }

  function normalizeTrack(track) {
    return {
      ...track,
      points: normalizeTrackPoints(track.points),
    };
  }

  function normalizeTrackPoints(points) {
    if (!Array.isArray(points)) {
      return [];
    }

    return points.map(normalizeTrackPoint).filter(Boolean);
  }

  function normalizeTrackPoint(point) {
    if (!point || typeof point !== "object") {
      return null;
    }

    const lng = Number(point.lng ?? point.longitude);
    const lat = Number(point.lat ?? point.latitude);
    const timestamp = normalizeTimestamp(point.timestamp);

    if (!isValidLng(lng) || !isValidLat(lat) || !timestamp) {
      return null;
    }

    const speed = toNullableNumber(point.speed);
    const heading = toNullableHeading(point.heading);
    const computedSpeed = toNullableNumber(point.computedSpeed);
    const computedHeading = toNullableHeading(point.computedHeading);

    return {
      lng,
      lat,
      timestamp,
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

  function addComputedPointValues(point, previousPoint) {
    if (!point) {
      return null;
    }

    const previous = normalizeTrackPoint(previousPoint);
    if (!previous) {
      return {
        ...point,
        computedSpeed: null,
        computedHeading: null,
        distanceFromPrevious: 0,
        timeFromPrevious: 0,
        speedSource: normalizeValueSource(point.speedSource, point.speed, null),
        headingSource: normalizeValueSource(point.headingSource, point.heading, null),
      };
    }

    const distanceFromPrevious = haversine(previous, point);
    const timeFromPrevious = Math.max(
      0,
      (new Date(point.timestamp).getTime() - new Date(previous.timestamp).getTime()) / 1000,
    );
    const computedSpeed =
      timeFromPrevious > 0 ? distanceFromPrevious / timeFromPrevious : null;
    const computedHeading =
      timeFromPrevious > 0 && distanceFromPrevious > 0 ? calculateBearing(previous, point) : null;

    return {
      ...point,
      computedSpeed,
      computedHeading,
      distanceFromPrevious,
      timeFromPrevious,
      speedSource: normalizeValueSource(point.speedSource, point.speed, computedSpeed),
      headingSource: normalizeValueSource(point.headingSource, point.heading, computedHeading),
    };
  }

  function isValidLng(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= -180 && number <= 180;
  }

  function isValidLat(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= -90 && number <= 90;
  }

  function normalizeTimestamp(value) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      return null;
    }

    return value;
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

  function getDisplaySpeed(point) {
    if (!point) {
      return { value: null, source: "none" };
    }

    if (point.speed !== null) {
      return { value: point.speed, source: "device" };
    }

    if (point.computedSpeed !== null) {
      return { value: point.computedSpeed, source: "computed" };
    }

    return { value: null, source: "none" };
  }

  function getDisplayHeading(point) {
    if (!point) {
      return { value: null, source: "none" };
    }

    if (point.heading !== null) {
      return { value: point.heading, source: "device" };
    }

    if (point.computedHeading !== null) {
      return { value: point.computedHeading, source: "computed" };
    }

    return { value: null, source: "none" };
  }

  function toNullableHeading(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 360) {
      return null;
    }

    return number;
  }

  function formatSpeed(value) {
    if (value === null || !Number.isFinite(value)) {
      return "--";
    }

    return `${(value * 3.6).toFixed(1)} km/h`;
  }

  function formatHeading(value) {
    if (value === null || !Number.isFinite(value)) {
      return "--";
    }

    const normalized = ((value % 360) + 360) % 360;
    return `${toCompassLabel(normalized)} / ${Math.round(normalized)}°`;
  }

  function toCompassLabel(degrees) {
    const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(degrees / 45) % labels.length;
    return labels[index];
  }

  function formatValueSource(value) {
    const labels = {
      device: "Device",
      computed: "Computed",
      none: "--",
    };
    return labels[value] || "--";
  }

  function formatTrackStatus(status) {
    const labels = {
      recording: "Recording",
      pending: "Pending Upload",
      synced: "Synced",
      failed: "Failed",
    };
    return labels[status] || "Unknown";
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

    return formatDurationSeconds(getTrackDurationSeconds(track));
  }

  function getTrackDurationSeconds(track) {
    const start = new Date(track.startedAt).getTime();
    const end = track.stoppedAt ? new Date(track.stoppedAt).getTime() : Date.now();
    return Math.max(0, Math.floor((end - start) / 1000));
  }

  function formatDurationSeconds(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
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
      const normalizedTrack = normalizeTrack(track);
      const transaction = state.db.transaction(TRACK_STORE, "readwrite");
      transaction.objectStore(TRACK_STORE).put(normalizedTrack);
      transaction.oncomplete = () => resolve(normalizedTrack);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function getAllTracks() {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(TRACK_STORE, "readonly");
      const request = transaction.objectStore(TRACK_STORE).getAll();
      request.onsuccess = () => resolve((request.result || []).map(normalizeTrack));
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
