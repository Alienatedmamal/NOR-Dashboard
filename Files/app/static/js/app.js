// NOR Dashboard frontend logic

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---- Loading screen ----
// Shown while the dashboard tries to confirm it can reach the Rust
// server's RCON - retries /api/status for up to 15 seconds rather than
// giving up on the very first attempt, since a slow-to-respond server (see
// rcon_client.py's own bounded-but-not-instant timeout handling) shouldn't
// look identical to a genuinely unreachable or misconfigured one. Either
// way - success or timeout - the page is revealed once the bar hits 100%;
// a failure surfaces as a toast (with a suggested fix) on the real page
// instead of trapping the user behind a blocking screen, since every tab
// already has its own "Not connected" badge and auto-retrying polling -
// there's nothing a dedicated Refresh button here would do that the rest
// of the page doesn't already do on its own.
const LOADING_TIMEOUT_MS = 15000;
const LOADING_RETRY_INTERVAL_MS = 1500;

function setLoadingProgress(pct) {
  const bar = $("#loading-progress-bar");
  if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + "%";
}

function revealPage() {
  const overlay = $("#loading-screen");
  if (overlay) overlay.hidden = true;
}

function setLoadingStatus(text) {
  const el = $("#loading-screen-status");
  if (el) el.textContent = text;
}

// /api/status's own RCON call can legitimately take much longer than this
// gate's whole 15s budget against a genuinely bad host (rcon_client.py's
// retry loop: up to ~8s connect + 8s send + 8s response-wait, x2 attempts).
// Without its own timeout, a single slow fetch() here would block the loop
// below from ever rechecking its deadline - this is what makes a bad RCON
// IP look like an indefinite hang instead of a 15s timeout. Aborting
// client-side after a few seconds doesn't cancel the backend's own RCON
// attempt, but it does let THIS loop keep its promise to move on regardless.
const STATUS_POLL_TIMEOUT_MS = 4000;

async function checkServerReachable() {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), STATUS_POLL_TIMEOUT_MS);
  try {
    const data = await fetch("/api/status", { signal: controller.signal }).then((res) => res.json());
    return !!data.connected;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(abortTimer);
  }
}

// Run after the RCON gate resolves (success or timeout) and before the
// page reveals - one more thing for the loading screen's progress bar/
// status line to report on, same UI as the RCON wait above. A module
// failing its check doesn't block startup; it's a heads-up, not a gate -
// the AMAP tab (etc.) will keep showing the same problem on its own if
// the admin tries to use it anyway.
async function runModulePreflightChecks() {
  let modules = [];
  try {
    const data = await fetch("/api/modules").then((res) => res.json());
    modules = (data.loaded || []).filter((m) => m.has_preflight);
  } catch (err) {
    return; // /api/modules itself failing isn't worth blocking startup over
  }
  for (const mod of modules) {
    setLoadingStatus(`Checking module: ${mod.label}...`);
    let result;
    try {
      result = await fetch(`/api/modules/${mod.key}/preflight`).then((res) => res.json());
    } catch (err) {
      result = { ok: false, message: "Preflight check failed to run." };
    }
    if (!result.ok) {
      await showConfirmModal({
        title: `${mod.label} module`,
        message: result.message || `${mod.label} couldn't confirm its requirements are met.`,
        confirmLabel: "Continue anyway",
      });
    }
  }
}

async function runLoadingGate() {
  const startedAt = Date.now();
  const deadline = startedAt + LOADING_TIMEOUT_MS;
  setLoadingStatus("Connecting to your Rust server...");
  const progressTimer = setInterval(() => {
    setLoadingProgress(Math.round(((Date.now() - startedAt) / LOADING_TIMEOUT_MS) * 90));
  }, 200);

  let reachable = false;
  while (Date.now() < deadline) {
    if (await checkServerReachable()) {
      reachable = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, LOADING_RETRY_INTERVAL_MS));
  }
  if (!reachable) {
    reachable = await checkServerReachable(); // one last try right at the deadline
  }
  clearInterval(progressTimer);
  setLoadingProgress(90);

  await runModulePreflightChecks();

  setLoadingProgress(100);
  revealPage();

  if (!reachable) {
    showToast({
      title: "Couldn't reach your Rust server",
      message: "RCON didn't respond within 15 seconds.",
      fix: "Check rcon_host/rcon_port/rcon_password in Settings > RCON, and that your Rust server is actually running.",
      variant: "error",
    });
  }
}
runLoadingGate();

// ---- Unexpected-error safety net ----
// Now that the dashboard runs windowless (see run.bat), there's no console
// to glance at if something breaks - this is the generic catch-all for
// errors nothing else already handles. Deliberately separate from the ~15
// existing alert("Error: ...") calls elsewhere in this file, which are
// already-handled cases, not unexpected ones.
window.addEventListener("error", (event) => {
  showToast({
    title: "Unexpected error",
    message: event.message || "Something went wrong.",
    fix: "Try refreshing the page. If this keeps happening, check dashboard.log.",
    variant: "error",
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
  showToast({
    title: "Unexpected error",
    message: reason,
    fix: "Try refreshing the page. If this keeps happening, check dashboard.log.",
    variant: "error",
  });
});

// ---- Tabs ----
$all(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});
$("#settings-gear-btn").addEventListener("click", () => activateTab("settings"));

// Lets a module react to its own tab becoming active without core needing
// to know that module exists (e.g. Terminal's xterm.js instance needs a
// fit() call once its container is actually visible and sized) - core
// just calls whatever's registered for the activated tab, if anything.
const tabActivationHooks = {};
function onTabActivated(tab, fn) {
  (tabActivationHooks[tab] = tabActivationHooks[tab] || []).push(fn);
}

function activateTab(tab) {
  $all(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#settings-gear-btn").classList.toggle("active", tab === "settings");
  $all(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
  if (tab === "map") startMapPolling(); else stopMapPolling();
  (tabActivationHooks[tab] || []).forEach((fn) => fn());
}

// ---- Settings sub-nav (RCON / Theme / Wipe Schedule) ----
$all(".settings-subnav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".settings-subnav-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $all(".settings-section").forEach((s) => s.classList.toggle("active", s.id === "settings-section-" + btn.dataset.settingsSection));
  });
});

// ---- Wipe countdown: configurable frequency/time/timezone ----
// A timezone's UTC offset isn't fixed (DST), so this can't just hardcode an
// offset without being wrong for chunks of the year. Instead it asks the
// browser's Intl API what wall-clock time a given instant actually is in
// the target zone and self-corrects from there, which handles DST
// correctly without a lookup table - same trick regardless of which zone
// or schedule (daily/biweekly/monthly) is configured.
let wipeConfig = { frequency: "monthly", time: "14:00", timezone: "America/Chicago", anchorDate: "" };

function tzPartsFor(utcDate, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  dtf.formatToParts(utcDate).forEach((p) => {
    if (p.type !== "literal") parts[p.type] = parseInt(p.value, 10);
  });
  return parts;
}

function tzWallClockToUtc(year, month, day, hour, minute, timezone) {
  // month is 1-indexed. Guess assumes offset 0, then checks what that guess
  // actually lands on in the target zone and corrects by the difference -
  // works for any zone/offset without needing to know it in advance.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const got = tzPartsFor(guess, timezone);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const gotAsUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
  return new Date(guess.getTime() + (wanted - gotAsUtc));
}

function firstThursdayOfMonth(year, month) {
  // month is 1-indexed; returns the day-of-month (1-7) for the first Thursday.
  for (let day = 1; day <= 7; day++) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 4) return day;
  }
  return 1; // unreachable - every week has a Thursday in days 1-7
}

function getNextWipeTarget() {
  const { frequency, time, timezone, anchorDate } = wipeConfig;
  const [hour, minute] = (time || "14:00").split(":").map((n) => parseInt(n, 10));
  const nowUtc = new Date();

  if (frequency === "daily") {
    let parts = tzPartsFor(nowUtc, timezone);
    let target = tzWallClockToUtc(parts.year, parts.month, parts.day, hour, minute, timezone);
    if (target.getTime() <= nowUtc.getTime()) {
      parts = tzPartsFor(new Date(target.getTime() + 86400000), timezone);
      target = tzWallClockToUtc(parts.year, parts.month, parts.day, hour, minute, timezone);
    }
    return target;
  }

  if (frequency === "biweekly" && anchorDate) {
    const [ay, am, ad] = anchorDate.split("-").map((n) => parseInt(n, 10));
    let target = tzWallClockToUtc(ay, am, ad, hour, minute, timezone);
    while (target.getTime() <= nowUtc.getTime()) {
      const parts = tzPartsFor(new Date(target.getTime() + 14 * 86400000), timezone);
      target = tzWallClockToUtc(parts.year, parts.month, parts.day, hour, minute, timezone);
    }
    return target;
  }

  // monthly (default/fallback) - first Thursday of the month
  const nowParts = tzPartsFor(nowUtc, timezone);
  let year = nowParts.year;
  let month = nowParts.month;
  for (let i = 0; i < 13; i++) {
    const day = firstThursdayOfMonth(year, month);
    const target = tzWallClockToUtc(year, month, day, hour, minute, timezone);
    if (target.getTime() > nowUtc.getTime()) return target;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return null;
}

let wipeTargetUtc = null;

function updateWipeCountdown() {
  const el = $("#wipe-countdown-time");
  if (!el) return;
  const now = new Date();
  if (!wipeTargetUtc || now.getTime() >= wipeTargetUtc.getTime()) {
    wipeTargetUtc = getNextWipeTarget();
  }
  if (!wipeTargetUtc) {
    el.textContent = "-";
    return;
  }
  const totalSeconds = Math.floor((wipeTargetUtc.getTime() - now.getTime()) / 1000);
  if (totalSeconds <= 0) {
    el.textContent = "Wiping now...";
    wipeTargetUtc = null; // forces a fresh search next tick, which naturally rolls to the next occurrence
    return;
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  el.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
}
updateWipeCountdown();
setInterval(updateWipeCountdown, 1000);

async function loadWipeConfig() {
  try {
    const data = await fetch("/api/settings/wipe").then((res) => res.json());
    if (data.error) return;
    wipeConfig = {
      frequency: data.wipe_frequency || "monthly",
      time: data.wipe_time || "14:00",
      timezone: data.wipe_timezone || "America/Chicago",
      anchorDate: data.wipe_anchor_date || "",
    };
    wipeTargetUtc = null; // recompute against the real config instead of the built-in default
    updateWipeCountdown();
  } catch (err) {
    // keep the built-in default (monthly/first Thursday/2pm Central) until the next load attempt
  }
}
loadWipeConfig();

// ---- Toast notifications ----
// Bottom-right pop-ups - the in-page replacement for the console window
// that used to show errors before the dashboard ran windowless. Persist
// until manually closed (no auto-dismiss) and stack rather than replace
// each other, since e.g. an RCON-lost toast and an unrelated JS error toast
// could plausibly both fire around the same time.
function showToast({ title, message, fix, variant, onClick }) {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${variant === "error" ? "error" : "info"}`;
  if (onClick) el.classList.add("toast-clickable");
  el.innerHTML = `
    <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
    ${fix ? `<div class="toast-fix">Suggested fix: ${escapeHtml(fix)}</div>` : ""}
  `;
  el.querySelector(".toast-close").addEventListener("click", (e) => {
    e.stopPropagation();
    el.remove();
  });
  // Optional - lets a caller (e.g. the join-alert toast) make the whole
  // toast clickable to jump elsewhere, without every other showToast()
  // call site needing to know or care that this exists.
  if (onClick) el.addEventListener("click", onClick);
  container.appendChild(el);

  if (variant === "error") {
    // A brief 3-cycle/1.5s pulse to grab attention, then settle into the
    // steady toast-error look - not a continuous flash, which would be an
    // accessibility/photosensitivity problem in a tool meant to stay open
    // for long admin sessions.
    el.classList.add("toast-flash");
    setTimeout(() => el.classList.remove("toast-flash"), 1500);
  }
}

// ---- Heartbeat ----
// Tells app.py's watchdog the browser is still open - see /api/heartbeat
// and _heartbeat_watchdog_loop in app.py. Must stay well under that
// function's HEARTBEAT_TIMEOUT_SECONDS (90s - deliberately generous to
// tolerate background-tab timer throttling, see app.py's comment) so a
// couple of missed/slow pings don't trigger a false shutdown.
const HEARTBEAT_INTERVAL_MS = 5000;
let heartbeatFailing = false;
async function sendHeartbeat() {
  try {
    await fetch("/api/heartbeat", { method: "POST" });
    heartbeatFailing = false;
  } catch (err) {
    if (!heartbeatFailing) {
      heartbeatFailing = true;
      showToast({
        title: "Connection issue",
        message: "Couldn't reach the dashboard server.",
        fix: "Check that the dashboard process is still running, then refresh this page.",
        variant: "error",
      });
    }
  }
}
sendHeartbeat();
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

// ---- Connection status ----
let wasConnected = null; // null = not yet known - avoids a false "lost connection" toast on the very first poll
async function refreshStatus() {
  const badge = $("#connection-status");
  const text = $("#connection-text");
  let connectedNow;
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    connectedNow = !!data.connected;
  } catch (err) {
    connectedNow = false;
  }

  if (connectedNow) {
    badge.className = "status-badge status-online";
    text.textContent = "Connected";
  } else {
    badge.className = "status-badge status-offline";
    text.textContent = "Not connected";
  }
  if (wasConnected === true && !connectedNow) {
    showToast({
      title: "RCON connection lost",
      message: "The dashboard can no longer reach your Rust server's RCON.",
      fix: "Check that the server is running and that rcon_host/rcon_port/rcon_password in config.json are correct.",
      variant: "error",
    });
  }
  wasConnected = connectedNow;
  $("#last-checked").textContent = "Last checked: " + nowTimestamp();

  try {
    const res = await fetch("/api/server/info");
    const data = await res.json();
    if (!data.error && data.raw === undefined) {
      const players = data.Players !== undefined ? data.Players : "-";
      const max = data.MaxPlayers !== undefined ? data.MaxPlayers : "-";
      $("#player-count").textContent = `Players: ${players}/${max}`;

      $("#overview-players").textContent = `${players}/${max}`;
      $("#overview-queued").textContent = data.Queued !== undefined ? data.Queued : "-";
      $("#overview-fps").textContent = data.Framerate !== undefined ? data.Framerate : "-";
      $("#overview-gametime").textContent = data.GameTime !== undefined ? data.GameTime : "-";
      $("#overview-uptime").textContent = data.Uptime !== undefined ? formatSeconds(data.Uptime) : "-";
      $("#overview-map").textContent = data.Map !== undefined ? data.Map : "-";
      $("#overview-entities").textContent = data.EntityCount !== undefined ? data.EntityCount : "-";
      $("#overview-hostname").textContent = data.Hostname || "NOR Dashboard";
    }
  } catch (err) {
    // leave the last known count showing rather than blank it on a hiccup
  }

  checkJoinAlerts();
  checkSystemAlerts();
}
refreshStatus();
setInterval(refreshStatus, 15000);

// Two-tone alert beep via the Web Audio API - no audio file/asset needed.
// Chrome suspends new AudioContexts until a user gesture has occurred and
// won't allow resume() from inside a fetch/timer callback — only from a
// synchronous gesture handler. So we create and unlock the context on the
// first click anywhere on the page; by the time an alert fires from a poll,
// the context is already running and playAlertTone() can schedule notes
// without needing to resume.
let audioCtx = null;
function _unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch (err) {}
}
document.addEventListener("click", _unlockAudio);

function playAlertTone() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const schedule = () => {
      const now = audioCtx.currentTime;
      [880, 660].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, now + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.14);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + i * 0.15);
        osc.stop(now + i * 0.15 + 0.15);
      });
    };
    if (audioCtx.state === "suspended") {
      audioCtx.resume().then(schedule).catch(() => {});
    } else {
      schedule();
    }
  } catch (err) {
    // Web Audio unavailable/blocked - the toast itself still shows.
  }
}

// Deduplication guard for alert toasts — prevents the same title+message
// from showing more than once within a 60-second window, which can happen
// when an alert is queued twice in quick succession (e.g. a threshold right
// on the boundary between two consecutive samples).
const _recentToasts = new Map();
function _isDupeToast(title, message) {
  const key = `${title}|${message}`;
  const last = _recentToasts.get(key) || 0;
  if (Date.now() - last < 60_000) return true;
  _recentToasts.set(key, Date.now());
  return false;
}

// Piggybacked on refreshStatus()'s existing 15s poll rather than its own
// faster one - this is sourced from a 60s-interval background tick (see
// _player_tracker_loop in app.py), so polling more often than that
// wouldn't surface anything sooner.
async function checkJoinAlerts() {
  try {
    const data = await fetch("/api/players/join-alerts").then((res) => res.json());
    const alerts = data.alerts || [];
    if (alerts.length === 0) return;
    alerts.forEach((a) => {
      const title = "Noted player reconnected";
      const message = `${a.name || a.steamid} has ${a.note_count} note${a.note_count === 1 ? "" : "s"} on file. Click to view.`;
      if (_isDupeToast(title, message)) return;
      showToast({
        title,
        message,
        variant: "info",
        onClick: () => {
          activateTab("players");
          $("#notes-steamid").value = a.steamid;
          loadNotes(a.steamid);
          $("#notes-list").scrollIntoView({ behavior: "smooth", block: "center" });
        },
      });
    });
    if (notificationSettings.sound_alerts_enabled !== false) playAlertTone();
  } catch (err) {
    // next poll will catch up
  }
}

// ---- Console ----
const consoleOutput = $("#console-output");
let _consoleAutoscroll = true;

function _setAutoscroll(enabled) {
  _consoleAutoscroll = enabled;
  const btn = $("#console-autoscroll-btn");
  if (!btn) return;
  btn.textContent = enabled ? "Pause" : "Resume";
  btn.dataset.tooltip = enabled ? "Pause autoscroll so you can scroll up to read" : "Resume autoscroll";
  btn.classList.toggle("btn-primary", !enabled);
  btn.classList.toggle("btn-outline", enabled);
}

$("#console-autoscroll-btn").addEventListener("click", () => _setAutoscroll(!_consoleAutoscroll));

// Resume autoscroll automatically when the user scrolls back to the bottom.
consoleOutput.addEventListener("scroll", () => {
  const atBottom = consoleOutput.scrollHeight - consoleOutput.scrollTop - consoleOutput.clientHeight < 8;
  if (atBottom && !_consoleAutoscroll) _setAutoscroll(true);
});

function logToConsole(line, cls, timestamp) {
  const row = document.createElement("div");
  row.className = "console-line " + (cls || "");
  if (timestamp) {
    const ts = document.createElement("span");
    ts.className = "console-ts";
    ts.textContent = "[" + timestamp + "] ";
    row.appendChild(ts);
    row.appendChild(document.createTextNode(line));
  } else {
    row.textContent = line;
  }
  consoleOutput.appendChild(row);
  if (_consoleAutoscroll) consoleOutput.scrollTop = consoleOutput.scrollHeight;
}
function nowTimestamp() {
  return new Date().toTimeString().slice(0, 8);
}

$("#console-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#console-input");
  const command = input.value.trim();
  if (!command) return;
  logToConsole("> " + command, "console-cmd", nowTimestamp());
  input.value = "";
  try {
    const data = await postJson("/api/command", { command });
    // The actual response (and everything else the server logs) arrives
    // through the live console feed below, not here - this just reports
    // outright failures to send.
    if (data.error) logToConsole("Error: " + data.error, "console-error");
  } catch (err) {
    logToConsole("Error: " + err.message, "console-error");
  }
});

$("#broadcast-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#broadcast-message");
  const message = input.value.trim();
  if (!message) return;
  logToConsole("> say " + message, "console-cmd", nowTimestamp());
  input.value = "";
  try {
    const data = await postJson("/api/console/broadcast", { message });
    if (data.error) logToConsole("Error: " + data.error, "console-error");
  } catch (err) {
    logToConsole("Error: " + err.message, "console-error");
  }
});

// ---- Give Item ----
let onlinePlayersForGiveItem = [];

function populateGiveItemPlayerSelect(players) {
  onlinePlayersForGiveItem = players;
  const select = $("#give-item-player");
  select.innerHTML = players.length
    ? players.map((p) => `<option value="${escapeHtml(p.steamid)}">${escapeHtml(p.name)}</option>`).join("")
    : '<option value="">(no players online)</option>';
  select._syncCustomSelectTrigger && select._syncCustomSelectTrigger();
}

let itemCatalog = [];

async function loadItemCatalog() {
  try {
    const data = await fetch("/api/items/catalog").then((res) => res.json());
    itemCatalog = data.items || [];
  } catch {}
  initGiveItemCombo();
}
loadItemCatalog();

function initGiveItemCombo() {
  const searchInput = $("#give-item-search");
  const hiddenInput = $("#give-item-shortname");
  if (!searchInput) return;

  const wrap = document.createElement("div");
  wrap.className = "combo-wrap";
  searchInput.parentNode.insertBefore(wrap, searchInput);
  wrap.appendChild(searchInput);
  wrap.appendChild(hiddenInput);

  const list = document.createElement("div");
  list.className = "combo-list";
  list.hidden = true;
  wrap.appendChild(list);

  function renderOptions() {
    const q = searchInput.value.trim().toLowerCase();
    const matches = q
      ? itemCatalog.filter(
          (i) =>
            i.name.toLowerCase().includes(q) ||
            i.shortname.toLowerCase().includes(q) ||
            i.category.toLowerCase().includes(q)
        )
      : itemCatalog;
    list.innerHTML = matches.length
      ? matches
          .slice(0, 80)
          .map(
            (i) =>
              `<div class="combo-option" data-value="${escapeHtml(i.shortname)}">` +
              `<img class="combo-option-icon" src="/static/img/items/${escapeHtml(i.shortname)}.png" alt="">` +
              `${escapeHtml(i.category)} - ${escapeHtml(i.name)}</div>`
          )
          .join("")
      : '<div class="combo-option combo-empty muted">No items found</div>';
    list.hidden = false;
  }

  searchInput.addEventListener("focus", renderOptions);
  searchInput.addEventListener("input", () => {
    hiddenInput.value = "";
    renderOptions();
  });
  searchInput.addEventListener("blur", () => {
    setTimeout(() => { list.hidden = true; }, 150);
  });
  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt || !opt.dataset.value) return;
    const shortname = opt.dataset.value;
    hiddenInput.value = shortname;
    const item = itemCatalog.find((i) => i.shortname === shortname);
    searchInput.value = item ? `${item.category} - ${item.name}` : shortname;
    list.hidden = true;
  });
}

$("#give-item-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const steamid = $("#give-item-player").value;
  const shortname = $("#give-item-shortname").value;
  const amount = $("#give-item-amount").value;
  if (!steamid) {
    alert("No player selected - make sure someone's actually connected.");
    return;
  }
  if (!shortname) {
    alert("Please pick an item.");
    return;
  }
  const data = await postJson("/api/console/give-item", { steamid, shortname, amount });
  alert(data.error ? "Error: " + data.error : (data.response || "Given."));
});

// Live console feed - polls for everything the server has logged since the
// last poll (your own command responses, plugin loads, chat, warnings...),
// same idea as RustAdmin's console tab. consoleLastSeq starts as null so
// the very first poll fetches the last 20 lines of history instead of
// dumping the entire buffer (which can hold up to 1000 lines).
let consoleLastSeq = null;

async function pollConsoleLog() {
  try {
    const url = consoleLastSeq === null
      ? "/api/console/log?tail=20"
      : `/api/console/log?after=${consoleLastSeq}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) return; // stay quiet here - the status badge already shows disconnects
    if (consoleLastSeq !== null && data.latest !== undefined && data.latest < consoleLastSeq) {
      // The dashboard process itself restarted, so its sequence counter
      // reset to 0 - resync with a fresh tail load next poll instead of
      // waiting forever for sequence numbers it will never reach again.
      consoleLastSeq = null;
      return;
    }
    (data.lines || []).forEach((line) => logToConsole(line.message, "", line.timestamp));
    if (data.latest !== undefined) consoleLastSeq = data.latest;
  } catch (err) {
    // network hiccup - next poll will catch up
  }
}
pollConsoleLog();
setInterval(pollConsoleLog, 1500);

// Custom dropdown for the various "SteamID" fields - a single box you can
// either type into freely or click to browse online players. Built by hand
// instead of using <datalist> (which most browsers won't reopen once the
// field already has a value) or a <select> (whose open dropdown list is
// largely browser/OS-styled, which is why the previous version was hard to
// read) - this version is a plain styled <div> list, so it stays readable
// and reliably reopens every time you click back into the field.
let onlinePlayersCache = [];

function updateOnlinePlayersDatalist(players) {
  onlinePlayersCache = players || [];
}

function initPlayerCombo(input) {
  const wrap = document.createElement("div");
  wrap.className = "combo-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement("div");
  list.className = "combo-list";
  list.hidden = true;
  wrap.appendChild(list);

  function renderOptions() {
    const filter = input.value.trim().toLowerCase();
    const matches = onlinePlayersCache.filter(
      (p) => !filter || p.name.toLowerCase().includes(filter) || p.steamid.includes(filter)
    );
    list.innerHTML = matches.length
      ? matches
          .map((p) => `<div class="combo-option" data-value="${escapeHtml(p.steamid)}">${escapeHtml(p.name)} <span class="muted">(${escapeHtml(p.steamid)})</span></div>`)
          .join("")
      : '<div class="combo-option combo-empty muted">No online players match</div>';
    list.hidden = false;
  }

  input.addEventListener("focus", renderOptions);
  input.addEventListener("input", renderOptions);
  input.addEventListener("blur", () => {
    // Delay so a click on an option (which blurs the input first) still
    // has a chance to register before the list disappears.
    setTimeout(() => { list.hidden = true; }, 150);
  });
  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt || !opt.dataset.value) return;
    input.value = opt.dataset.value;
    list.hidden = true;
  });
}

$all(".player-combo").forEach(initPlayerCombo);

// Custom styled replacement for plain <select> elements (e.g. the
// Player/Group type pickers) - same combo-list look as the player fields
// above, instead of the browser/OS-native dropdown rendering that's hard
// to read. The real <select> stays in the DOM (just hidden) as the source
// of truth, so anything elsewhere that reads its .value keeps working
// completely unchanged.
function initCustomSelect(select) {
  const wrap = document.createElement("div");
  wrap.className = "combo-wrap";
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("custom-select-hidden");

  const trigger = document.createElement("div");
  trigger.className = "custom-select-trigger";
  wrap.appendChild(trigger);

  const list = document.createElement("div");
  list.className = "combo-list";
  list.hidden = true;
  wrap.appendChild(list);

  function dotHtml(color) {
    return color ? `<span class="combo-option-dot" style="--dot-color:${escapeHtml(color)}"></span>` : "";
  }

  // Optional, opt-in via a data-icon attribute on the <option> (e.g. the
  // Give Item picker's item images) - generic to any custom-select, same
  // idea as the color dot above.
  function iconHtml(src) {
    return src ? `<img class="combo-option-icon" src="${escapeHtml(src)}" alt="">` : "";
  }

  function syncTrigger() {
    const opt = select.options[select.selectedIndex];
    trigger.innerHTML = opt ? `${dotHtml(opt.dataset.color)}${iconHtml(opt.dataset.icon)}${escapeHtml(opt.textContent)}` : "";
  }

  function closeList() {
    list.hidden = true;
    document.removeEventListener("mousedown", onDocMouseDown);
  }

  function onDocMouseDown(e) {
    if (!wrap.contains(e.target)) closeList();
  }

  trigger.addEventListener("click", () => {
    if (!list.hidden) {
      closeList();
      return;
    }
    list.innerHTML = Array.from(select.options)
      .map((opt) => `<div class="combo-option" data-value="${escapeHtml(opt.value)}">${dotHtml(opt.dataset.color)}${iconHtml(opt.dataset.icon)}${escapeHtml(opt.textContent)}</div>`)
      .join("");
    list.hidden = false;
    document.addEventListener("mousedown", onDocMouseDown);
  });

  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt) return;
    select.value = opt.dataset.value;
    syncTrigger();
    closeList();
    select.dispatchEvent(new Event("change"));
  });

  syncTrigger();
  // Exposed so code that sets select.value/options directly (loading saved
  // settings, repopulating options from a fetch, etc.) can refresh the
  // visible trigger label without firing a real "change" event - several
  // .custom-select elements already have their own "change" listener tied
  // to real user-driven side effects (applying a theme, saving settings),
  // and dispatching one here would wrongly re-trigger those.
  select._syncCustomSelectTrigger = syncTrigger;
}
// Auto-init for every .custom-select happens at the very end of this file,
// not here - the Theme preset dropdown's <option>s are populated
// dynamically further down, and need to exist before this runs.

// Shared renderer for the two places that show the same "who's online"
// list (avatar, name, session time) - the Console tab's sidebar and the
// Overview tab. Takes a container element directly rather than a
// selector, so the same player data can be rendered into both at once.
// showActions adds a Kick button per row - only used for the Console
// sidebar, not the Overview tab's plainer summary list.
function renderPlayerList(box, players, errorMessage, showActions) {
  if (errorMessage) {
    box.innerHTML = `<p class="muted">Error: ${escapeHtml(errorMessage)}</p>`;
    return;
  }
  if (players.length === 0) {
    box.innerHTML = '<p class="muted">No players online.</p>';
    return;
  }
  box.innerHTML = "";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "console-player-row";
    const avatarHtml = p.avatar
      ? `<img class="console-player-avatar" src="${escapeHtml(p.avatar)}" alt="">`
      : '<div class="console-player-avatar console-player-avatar-blank"></div>';
    const timeText = p.connected_seconds != null ? formatSeconds(p.connected_seconds) + " this session" : "-";
    const actionsHtml = showActions
      ? `<button type="button" class="btn btn-outline btn-small" data-kick-steamid="${escapeHtml(p.steamid)}" data-kick-name="${escapeHtml(p.name)}">Kick</button>`
      : "";
    row.innerHTML = `
      ${avatarHtml}
      <div class="console-player-meta">
        <div class="console-player-name">${escapeHtml(p.name)}</div>
        <div class="console-player-time muted">${escapeHtml(timeText)}</div>
      </div>
      ${actionsHtml}
    `;
    box.appendChild(row);
  });
  if (showActions) {
    $all("[data-kick-steamid]", box).forEach((btn) => {
      btn.addEventListener("click", () => kickPlayer(btn.dataset.kickSteamid, btn.dataset.kickName));
    });
  }
}

// Shared by the Console sidebar's Kick button and the Players tab's table -
// reason is optional (unlike Ban's, which is required and logged), since a
// kick is just a temporary removal, not a permanent moderation record.
async function kickPlayer(steamid, name) {
  const reason = prompt(`Kick ${name} (${steamid})? Optionally give a reason:`, "");
  if (reason === null) return; // cancelled
  const data = await postJson("/api/players/kick", { steamid, reason: reason.trim() });
  if (data.error) {
    alert("Error: " + data.error);
  } else if (data.note_warning) {
    alert(`${data.response || "Kicked."}\n\nWarning: ${data.note_warning}`);
  } else {
    alert(data.response || "Kicked.");
  }
}

// Compact player list next to the console - name, avatar, session time.
// Also doubles as the data source for the Permissions tab's player
// dropdown suggestions, the Overview tab's connected-players panel, and
// the Give Item form's player picker, since it's already fetching this
// every 20s.
async function refreshConsolePlayerList() {
  const consoleBox = $("#console-player-list");
  const overviewBox = $("#overview-player-list");
  try {
    const res = await fetch("/api/players/online");
    const data = await res.json();
    if (data.error) {
      renderPlayerList(consoleBox, [], data.error, true);
      renderPlayerList(overviewBox, [], data.error);
      updateOnlinePlayersDatalist([]);
      populateGiveItemPlayerSelect([]);
      return;
    }
    const players = data.players || [];
    updateOnlinePlayersDatalist(players);
    renderPlayerList(consoleBox, players, null, true);
    renderPlayerList(overviewBox, players);
    populateGiveItemPlayerSelect(players);
  } catch (err) {
    renderPlayerList(consoleBox, [], err.message, true);
    renderPlayerList(overviewBox, [], err.message);
    populateGiveItemPlayerSelect([]);
  }
}
refreshConsolePlayerList();
setInterval(refreshConsolePlayerList, 20000);

// ---- Overview tab extras: BattleMetrics rank ----
// Polled separately from the RCON-backed stats above since this comes from
// an external API and doesn't need to refresh as often - BattleMetrics'
// own crawler only updates a server's data every minute or so regardless
// of how often this asks.
async function loadOverviewExtras() {
  try {
    const bm = await fetch("/api/battlemetrics/stats").then((res) => res.json());
    $("#overview-rank").textContent = !bm.error && bm.rank != null ? `#${bm.rank}` : "-";
  } catch (err) {
    $("#overview-rank").textContent = "-";
  }
}
loadOverviewExtras();
setInterval(loadOverviewExtras, 30000);

// ---- Overview tab: performance history charts ----
// Dependency-free canvas line charts. One fetch every 5 minutes drives all
// three charts (entity count, player count, framerate) from the same
// /api/server/entity-history response - no extra polling overhead.

function _drawPerfChart(canvas, history, field, color, rangeLabelId, valueFormatter) {
  const rangeLabel = $("#" + rangeLabelId);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(Math.round(rect.width), 1);
  canvas.height = Math.max(Math.round(rect.height), 1);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const muted = (getComputedStyle(document.documentElement).getPropertyValue("--text-muted") || "#a6b0a3").trim();

  const points = (history || []).filter((p) => p[field] != null);
  if (points.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = "13px sans-serif";
    ctx.fillText("Not enough data yet — check back after the next sample (5 min).", 12, h / 2);
    if (rangeLabel) rangeLabel.textContent = "";
    return;
  }

  const fmt = valueFormatter || ((v) => String(v));
  const values = points.map((p) => p[field]);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = Math.max(maxVal - minVal, 1);
  const padX = 12, padTop = 20, padBottom = 20;

  ctx.beginPath();
  points.forEach((point, i) => {
    const x = padX + (i / (points.length - 1)) * (w - padX * 2);
    const y = padTop + (1 - (point[field] - minVal) / range) * (h - padTop - padBottom);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`Max: ${fmt(maxVal)}`, padX, 14);
  ctx.textAlign = "right";
  ctx.fillText(`Now: ${fmt(values[values.length - 1])}`, w - padX, 14);
  ctx.textAlign = "left";
  ctx.fillText(`Min: ${fmt(minVal)}`, padX, h - 6);

  if (rangeLabel) {
    const start = new Date(points[0].timestamp);
    const end = new Date(points[points.length - 1].timestamp);
    rangeLabel.textContent = isNaN(start.getTime()) || isNaN(end.getTime())
      ? ""
      : `${start.toLocaleString()} → ${end.toLocaleString()}`;
  }
}

async function loadPerformanceHistory() {
  try {
    const data = await fetch("/api/server/entity-history").then((r) => r.json());
    const history = data.history || [];
    const accent = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#39ff14").trim();
    const entityCanvas = $("#entity-history-chart");
    const playerCanvas = $("#player-history-chart");
    const fpsCanvas    = $("#fps-history-chart");
    if (entityCanvas) _drawPerfChart(entityCanvas, history, "entity_count", accent,       "entity-history-range");
    if (playerCanvas) _drawPerfChart(playerCanvas, history, "player_count", "#33aaff",    "player-history-range");
    if (fpsCanvas)    _drawPerfChart(fpsCanvas,    history, "framerate",    "#ffaa00",     "fps-history-range", (v) => `${v} FPS`);
  } catch (_) {
    // leave whatever was last drawn on a transient fetch error
  }
}
loadPerformanceHistory();
setInterval(loadPerformanceHistory, 300000);
window.addEventListener("resize", loadPerformanceHistory);

// ---- Overview tab extras: description + header image, straight from RCON ----
// Reuses /api/server/settings (same endpoint the Server Info tab edits
// through) rather than a separate call - description and headerimage are
// the same server.* convars either way. The description convar's RCON
// echo has literal "\n" text instead of real line breaks, hence the
// replace below; CSS already has white-space: pre-wrap to render the real
// ones once they're there.
const OVERVIEW_HERO_GRADIENT = "linear-gradient(180deg, rgba(10, 13, 10, .72) 0%, rgba(10, 13, 10, .9) 70%, rgba(10, 13, 10, 1) 100%)";
async function loadOverviewServerSettings() {
  try {
    const data = await fetch("/api/server/settings").then((res) => res.json());
    if (data.error) return;
    if (data.description) {
      $("#overview-description").textContent = data.description.replace(/\\n/g, "\n");
    }
    if (data.headerimage && data.headerimage !== "CHANGE_ME") {
      $("#overview-hero").style.backgroundImage = `${OVERVIEW_HERO_GRADIENT}, url(${data.headerimage})`;
    }
  } catch (err) {
    // next poll will catch up
  }
}
loadOverviewServerSettings();
setInterval(loadOverviewServerSettings, 30000);

// Permission dropdown suggestions - built from the plugins actually
// installed on the server (see permissions_catalog.py). Re-fetched after a
// successful plugin upload too, so newly-declared permissions show up
// without needing a page reload.
async function loadPermissionsCatalog() {
  try {
    const data = await fetch("/api/permissions/catalog").then((res) => res.json());
    const datalist = $("#permission-list");
    datalist.innerHTML = (data.permissions || [])
      .map((p) => `<option value="${escapeHtml(p)}"></option>`)
      .join("");
  } catch (err) {
    // no big deal - the field still works as a plain text input
  }
}
loadPermissionsCatalog();

// ---- Players ----
$("#refresh-players").addEventListener("click", loadPlayers);
loadPlayers();
onTabActivated("players", refreshAllPlayerTables);

function formatSeconds(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatLastConnected(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString();
}

// Bans column - only shows a badge when there's something to flag, since
// the overwhelming majority of players are clean and a "Clean" tag on
// every single row would just be noise.
function formatBanBadge(p) {
  if (p.vac_banned) return '<span class="tag tag-danger has-tooltip" data-tooltip="VAC banned">VAC</span>';
  if (p.number_of_game_bans > 0) return '<span class="tag tag-danger has-tooltip" data-tooltip="Game-banned on at least one other server">Game Ban</span>';
  return '<span class="muted">-</span>';
}

// Last-fetched rows per table, kept around so the filter boxes (below)
// can re-render from already-fetched data instead of re-fetching on
// every keystroke. Selection Sets persist across a table's own re-renders
// (e.g. after filtering) but get cleared on a fresh Refresh/load.
let lastOnlinePlayers = [];
let lastOfflinePlayers = [];
let lastBannedPlayers = [];
const selectedOnlineSteamids = new Set();
const selectedBannedSteamids = new Set();

function updateBulkBar(prefix, selectedSet) {
  const bar = $(`#${prefix}-bulk-bar`);
  const count = $(`#${prefix}-bulk-count`);
  bar.classList.toggle("hidden", selectedSet.size === 0);
  count.textContent = `${selectedSet.size} selected`;
}

async function loadPlayers() {
  const body = $("#players-body");
  body.innerHTML = '<tr><td colspan="11" class="muted">Loading...</td></tr>';
  try {
    const res = await fetch("/api/players");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<tr><td colspan="11" class="muted">Error: ${escapeHtml(data.error)}</td></tr>`;
      return;
    }
    if (data.players && data.players.length === 0 && data.ok === false) {
      body.innerHTML = `<tr><td colspan="11" class="muted">Response wasn't in the expected format.<br>Raw response: ${escapeHtml(data.raw || "(empty)")}</td></tr>`;
      return;
    }
    selectedOnlineSteamids.clear();
    updateBulkBar("players", selectedOnlineSteamids);
    lastOnlinePlayers = data.players || [];
    renderPlayersTable(lastOnlinePlayers);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="11" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderPlayersTable(players) {
  const body = $("#players-body");
  if (players.length === 0) {
    body.innerHTML = '<tr><td colspan="11" class="muted">No players currently online.</td></tr>';
    return;
  }
  body.innerHTML = "";
  players.forEach((p) => {
    const steamid = p.SteamID || p.steamid || "";
    const name = p.DisplayName || p.Name || p.name || "Unknown";
    const ip = p.Address || p.address || "-";
    const ping = p.Ping !== undefined ? p.Ping : (p.ping !== undefined ? p.ping : "-");
    const session = p.ConnectedSeconds !== undefined ? formatSeconds(p.ConnectedSeconds) : "-";
    const total = p.total_seconds_on_server != null ? formatSeconds(p.total_seconds_on_server) : "-";
    const lastConnected = formatLastConnected(p.last_connected);
    const rustHours = p.rust_hours != null ? p.rust_hours : "-";

    const banLabel = p.banned ? "Unban" : "Ban";
    const banClass = p.banned ? "btn-outline" : "btn-danger";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="row-select-checkbox" data-select-steamid="${escapeHtml(steamid)}" ${selectedOnlineSteamids.has(steamid) ? "checked" : ""}></td>
      <td>${escapeHtml(name)}</td>
      <td class="mono">${escapeHtml(steamid)}</td>
      <td class="mono">${escapeHtml(String(ip))}</td>
      <td>${escapeHtml(String(ping))}</td>
      <td>${escapeHtml(session)}</td>
      <td>${escapeHtml(total)}</td>
      <td>${escapeHtml(lastConnected)}</td>
      <td>${escapeHtml(String(rustHours))}</td>
      <td>${formatBanBadge(p)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-outline btn-small" data-steamid="${escapeHtml(steamid)}">Look up</button>
          <button class="btn btn-outline btn-small" data-notes-steamid="${escapeHtml(steamid)}">Notes</button>
          <button class="btn btn-outline btn-small" data-kick-steamid="${escapeHtml(steamid)}" data-kick-name="${escapeHtml(name)}">Kick</button>
          <button class="btn ${banClass} btn-small" data-ban-steamid="${escapeHtml(steamid)}" data-banned="${p.banned ? "true" : "false"}" data-name="${escapeHtml(name)}">${banLabel}</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });
  $all("[data-select-steamid]", body).forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedOnlineSteamids.add(cb.dataset.selectSteamid);
      else selectedOnlineSteamids.delete(cb.dataset.selectSteamid);
      $("#players-select-all").checked = selectedOnlineSteamids.size > 0 && selectedOnlineSteamids.size === players.length;
      updateBulkBar("players", selectedOnlineSteamids);
    });
  });
  $all("[data-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      activateTab("lookup");
      $("#lookup-steamid").value = btn.dataset.steamid;
      $("#lookup-form").dispatchEvent(new Event("submit"));
    });
  });
  $all("[data-kick-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", () => kickPlayer(btn.dataset.kickSteamid, btn.dataset.kickName));
  });
  $all("[data-notes-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#notes-steamid").value = btn.dataset.notesSteamid;
      loadNotes(btn.dataset.notesSteamid);
      $("#notes-list").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  $all("[data-ban-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const steamid = btn.dataset.banSteamid;
      const isBanned = btn.dataset.banned === "true";
      if (isBanned) {
        const data = await postJson("/api/players/unban", { steamid });
        if (data.error) alert("Error: " + data.error);
      } else {
        const reason = prompt(`Why are you banning ${btn.dataset.name} (${steamid})?`, "");
        if (reason === null) return; // cancelled
        if (!reason.trim()) {
          alert("A ban reason is required.");
          return;
        }
        const data = await postJson("/api/players/ban", { steamid, reason: reason.trim() });
        if (data.error) alert("Error: " + data.error);
        else if (data.note_warning) alert("Warning: " + data.note_warning);
      }
      refreshAllPlayerTables();
    });
  });
}

// Shared by every filterable table - checks against whichever
// name/steamid keys that table's rows actually use (RCON's raw
// DisplayName/SteamID for the online table, this app's own normalized
// name/steamid for offline/banned).
function applyTableFilter(players, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return players;
  return players.filter((p) => {
    const name = (p.DisplayName || p.Name || p.name || "").toLowerCase();
    const steamid = (p.SteamID || p.steamid || "").toLowerCase();
    return name.includes(q) || steamid.includes(q);
  });
}

$("#players-filter").addEventListener("input", () => {
  renderPlayersTable(applyTableFilter(lastOnlinePlayers, $("#players-filter").value));
});

$("#players-select-all").addEventListener("change", (e) => {
  const visible = applyTableFilter(lastOnlinePlayers, $("#players-filter").value);
  visible.forEach((p) => {
    const steamid = p.SteamID || p.steamid || "";
    if (e.target.checked) selectedOnlineSteamids.add(steamid);
    else selectedOnlineSteamids.delete(steamid);
  });
  renderPlayersTable(visible);
  updateBulkBar("players", selectedOnlineSteamids);
});

async function bulkKickPlayers(steamids) {
  if (steamids.length === 0) return;
  const confirmed = await showConfirmModal({
    title: "Bulk Kick",
    message: `Kick ${steamids.length} selected player(s)?`,
    confirmLabel: "Kick Selected",
    confirmClass: "btn-danger",
  });
  if (!confirmed) return;
  let success = 0, failed = 0;
  for (const steamid of steamids) {
    const data = await postJson("/api/players/kick", { steamid, reason: "" });
    if (data.error) failed++; else success++;
  }
  showToast({
    title: "Bulk Kick complete",
    message: `${success} kicked${failed ? `, ${failed} failed` : ""}.`,
    variant: failed ? "error" : "info",
  });
  refreshAllPlayerTables();
}

async function bulkBanPlayers(steamids) {
  if (steamids.length === 0) return;
  const reason = prompt(`Reason for banning ${steamids.length} selected player(s)? (applied to all of them)`, "");
  if (reason === null) return; // cancelled
  if (!reason.trim()) {
    alert("A ban reason is required.");
    return;
  }
  const confirmed = await showConfirmModal({
    title: "Bulk Ban",
    message: `Ban ${steamids.length} selected player(s) for "${reason.trim()}"?`,
    confirmLabel: "Ban Selected",
    confirmClass: "btn-danger",
  });
  if (!confirmed) return;
  let success = 0, failed = 0;
  for (const steamid of steamids) {
    const data = await postJson("/api/players/ban", { steamid, reason: reason.trim() });
    if (data.error) failed++; else success++;
  }
  showToast({
    title: "Bulk Ban complete",
    message: `${success} banned${failed ? `, ${failed} failed` : ""}.`,
    variant: failed ? "error" : "info",
  });
  refreshAllPlayerTables();
}
$("#players-bulk-kick").addEventListener("click", () => bulkKickPlayers(Array.from(selectedOnlineSteamids)));
$("#players-bulk-ban").addEventListener("click", () => bulkBanPlayers(Array.from(selectedOnlineSteamids)));

function refreshAllPlayerTables() {
  loadPlayers();
  loadOfflinePlayers();
  loadBannedPlayers();
}

// ---- Offline Players ----
$("#refresh-offline").addEventListener("click", loadOfflinePlayers);
$("#offline-filter").addEventListener("input", () => {
  renderOfflineTable(applyTableFilter(lastOfflinePlayers, $("#offline-filter").value));
});

async function loadOfflinePlayers() {
  const body = $("#offline-body");
  body.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
  try {
    const res = await fetch("/api/players/offline");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<tr><td colspan="7" class="muted">Error: ${escapeHtml(data.error)}</td></tr>`;
      return;
    }
    lastOfflinePlayers = data.players || [];
    renderOfflineTable(lastOfflinePlayers);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderOfflineTable(players) {
  const body = $("#offline-body");
  if (players.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="muted">No recently-seen offline players yet.</td></tr>';
    return;
  }
  body.innerHTML = "";
  players.forEach((p) => {
    const total = p.total_seconds_on_server != null ? formatSeconds(p.total_seconds_on_server) : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.name || "Unknown")}</td>
      <td class="mono">${escapeHtml(p.steamid)}</td>
      <td>${escapeHtml(p.ip || "-")}</td>
      <td>${escapeHtml(total)}</td>
      <td>${escapeHtml(formatLastConnected(p.last_connected))}</td>
      <td>${formatBanBadge(p)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-outline btn-small" data-steamid="${escapeHtml(p.steamid)}">Look up</button>
          <button class="btn btn-outline btn-small" data-notes-steamid="${escapeHtml(p.steamid)}">Notes</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });
  $all("[data-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      activateTab("lookup");
      $("#lookup-steamid").value = btn.dataset.steamid;
      $("#lookup-form").dispatchEvent(new Event("submit"));
    });
  });
  $all("[data-notes-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#notes-steamid").value = btn.dataset.notesSteamid;
      loadNotes(btn.dataset.notesSteamid);
      $("#notes-list").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

// ---- Banned Players ----
$("#refresh-banned").addEventListener("click", loadBannedPlayers);
$("#banned-filter").addEventListener("input", () => {
  renderBannedTable(applyTableFilter(lastBannedPlayers, $("#banned-filter").value));
});
$("#banned-select-all").addEventListener("change", (e) => {
  const visible = applyTableFilter(lastBannedPlayers, $("#banned-filter").value);
  visible.forEach((p) => {
    if (e.target.checked) selectedBannedSteamids.add(p.steamid);
    else selectedBannedSteamids.delete(p.steamid);
  });
  renderBannedTable(visible);
  updateBulkBar("banned", selectedBannedSteamids);
});
$("#banned-bulk-unban").addEventListener("click", async () => {
  const steamids = Array.from(selectedBannedSteamids);
  if (steamids.length === 0) return;
  const confirmed = await showConfirmModal({
    title: "Bulk Unban",
    message: `Unban ${steamids.length} selected player(s)?`,
    confirmLabel: "Unban Selected",
  });
  if (!confirmed) return;
  let success = 0, failed = 0;
  for (const steamid of steamids) {
    const data = await postJson("/api/players/unban", { steamid });
    if (data.error) failed++; else success++;
  }
  showToast({
    title: "Bulk Unban complete",
    message: `${success} unbanned${failed ? `, ${failed} failed` : ""}.`,
    variant: failed ? "error" : "info",
  });
  refreshAllPlayerTables();
});

async function loadBannedPlayers() {
  const body = $("#banned-body");
  body.innerHTML = '<tr><td colspan="4" class="muted">Loading...</td></tr>';
  try {
    const res = await fetch("/api/players/banned");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<tr><td colspan="4" class="muted">Error: ${escapeHtml(data.error)}</td></tr>`;
      return;
    }
    selectedBannedSteamids.clear();
    updateBulkBar("banned", selectedBannedSteamids);
    lastBannedPlayers = data.players || [];
    renderBannedTable(lastBannedPlayers);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderBannedTable(players) {
  const body = $("#banned-body");
  if (players.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="muted">No players currently banned.</td></tr>';
    return;
  }
  body.innerHTML = "";
  players.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="row-select-checkbox" data-select-steamid="${escapeHtml(p.steamid)}" ${selectedBannedSteamids.has(p.steamid) ? "checked" : ""}></td>
      <td>${escapeHtml(p.name || "Unknown")}</td>
      <td class="mono">${escapeHtml(p.steamid)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-outline btn-small" data-unban-steamid="${escapeHtml(p.steamid)}">Unban</button>
          <button class="btn btn-outline btn-small" data-notes-steamid="${escapeHtml(p.steamid)}">Notes</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });
  $all("[data-select-steamid]", body).forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedBannedSteamids.add(cb.dataset.selectSteamid);
      else selectedBannedSteamids.delete(cb.dataset.selectSteamid);
      $("#banned-select-all").checked = selectedBannedSteamids.size > 0 && selectedBannedSteamids.size === players.length;
      updateBulkBar("banned", selectedBannedSteamids);
    });
  });
  $all("[data-unban-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const data = await postJson("/api/players/unban", { steamid: btn.dataset.unbanSteamid });
      if (data.error) alert("Error: " + data.error);
      refreshAllPlayerTables();
    });
  });
  $all("[data-notes-steamid]", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#notes-steamid").value = btn.dataset.notesSteamid;
      loadNotes(btn.dataset.notesSteamid);
      $("#notes-list").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

// ---- Player Notes ----
function formatNoteTimestamp(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

async function searchAllNotes(query) {
  const box = $("#notes-search-results");
  if (!query) {
    box.innerHTML = '<p class="muted">Enter a search term first.</p>';
    return;
  }
  box.innerHTML = '<p class="muted">Searching...</p>';
  try {
    const data = await fetch(`/api/players/notes/search?q=${encodeURIComponent(query)}`).then((res) => res.json());
    if (data.error) {
      box.innerHTML = `<p class="muted">Error: ${escapeHtml(data.error)}</p>`;
      return;
    }
    const matches = data.matches || [];
    const warningHtml = data.sync_warning ? `<p class="muted sync-warning">Warning: ${escapeHtml(data.sync_warning)}</p>` : "";
    if (matches.length === 0) {
      box.innerHTML = warningHtml + '<p class="muted">No notes matched.</p>';
      return;
    }
    box.innerHTML = warningHtml + matches
      .map((m) => `
        <div class="console-line note-row">
          <span>[${escapeHtml(formatNoteTimestamp(m.timestamp))}] (${escapeHtml(m.type)}) <strong>${escapeHtml(m.steamid)}</strong>: ${escapeHtml(m.text)}</span>
          <button class="btn btn-outline btn-small" data-jump-steamid="${escapeHtml(m.steamid)}">Notes</button>
        </div>
      `)
      .join("");
    $all("[data-jump-steamid]", box).forEach((btn) => {
      btn.addEventListener("click", () => {
        $("#notes-steamid").value = btn.dataset.jumpSteamid;
        loadNotes(btn.dataset.jumpSteamid);
      });
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadNotes(steamid) {
  const box = $("#notes-list");
  if (!steamid) {
    box.innerHTML = '<p class="muted">Enter a SteamID first.</p>';
    return;
  }
  box.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const res = await fetch(`/api/players/notes?steamid=${encodeURIComponent(steamid)}`);
    const data = await res.json();
    if (data.error) {
      box.innerHTML = `<p class="muted">Error: ${escapeHtml(data.error)}</p>`;
      return;
    }
    const notes = data.notes || [];
    const warningHtml = data.sync_warning ? `<p class="muted sync-warning">Warning: ${escapeHtml(data.sync_warning)}</p>` : "";
    if (notes.length === 0) {
      box.innerHTML = warningHtml + '<p class="muted">No notes for this player yet.</p>';
      return;
    }
    box.innerHTML = warningHtml + notes
      .map((n, i) => ({ n, i }))
      .reverse()
      .map(({ n, i }) => `
        <div class="console-line note-row">
          <span>[${escapeHtml(formatNoteTimestamp(n.timestamp))}] (${escapeHtml(n.type)}) ${escapeHtml(n.text)}</span>
          <button class="btn btn-danger btn-small" data-delete-note-index="${i}" data-delete-note-steamid="${escapeHtml(steamid)}">Delete</button>
        </div>
      `)
      .join("");
    $all("[data-delete-note-index]", box).forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this note?")) return;
        const delRes = await fetch("/api/players/notes", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ steamid: btn.dataset.deleteNoteSteamid, index: btn.dataset.deleteNoteIndex }),
        });
        const delData = await delRes.json();
        if (delData.error) alert("Error: " + delData.error);
        else if (delData.sync_warning) alert("Warning: " + delData.sync_warning);
        loadNotes(btn.dataset.deleteNoteSteamid);
      });
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">Error: ${escapeHtml(err.message)}</p>`;
  }
}

$("#notes-search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  searchAllNotes($("#notes-search-query").value.trim());
});

$("#notes-load").addEventListener("click", () => loadNotes($("#notes-steamid").value.trim()));

// Force Sync - on-demand pull+merge+push of notes and stats with the Rust
// server, for when an admin doesn't want to wait for the automatic sync.
// Gated server-side by a 10s cooldown (see app.py's /api/players/sync-now)
// so mashing the button can't hammer the SSH connection; this bubble is
// just the UI's reflection of that, not the enforcement itself.
let syncBubbleTimer = null;
function showSyncBubble(message, isError) {
  const bubble = $("#notes-sync-bubble");
  clearTimeout(syncBubbleTimer);
  bubble.textContent = message;
  bubble.classList.remove("hidden", "sync-bubble-error", "sync-bubble-info");
  bubble.classList.add(isError ? "sync-bubble-error" : "sync-bubble-info");
  syncBubbleTimer = setTimeout(() => bubble.classList.add("hidden"), 5000);
}

$("#notes-force-sync").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/players/sync-now", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      showSyncBubble("Have to wait 10 seconds between syncs.", true);
      return;
    }
    if (data.errors && data.errors.length) {
      showSyncBubble(data.errors.join(" / "), true);
    } else {
      showSyncBubble("Synced notes and stats with the server.", false);
    }
    const steamid = $("#notes-steamid").value.trim();
    if (steamid) loadNotes(steamid);
  } catch (err) {
    showSyncBubble("Couldn't reach the dashboard to sync.", true);
  }
});

$("#notes-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const steamid = $("#notes-steamid").value.trim();
  const text = $("#notes-text").value.trim();
  if (!steamid || !text) {
    alert("Enter both a SteamID and a note.");
    return;
  }
  const data = await postJson("/api/players/notes", { steamid, text });
  if (data.error) {
    alert("Error: " + data.error);
    return;
  }
  if (data.sync_warning) alert("Warning: " + data.sync_warning);
  $("#notes-text").value = "";
  loadNotes(steamid);
});

// ---- Permissions ----
function syncPermTargetFields() {
  const isGroup = $("#perm-target-type").value === "group";
  $("#perm-target-user-wrap").hidden = isGroup;
  $("#perm-target-group-wrap").hidden = !isGroup;
  if (!isGroup) setTimeout(() => $("#perm-target").focus(), 0);
}
$("#perm-target-type").addEventListener("change", syncPermTargetFields);

function syncShowTargetFields() {
  const isGroup = $("#show-target-type").value === "group";
  $("#show-target-user-wrap").hidden = isGroup;
  $("#show-target-group-wrap").hidden = !isGroup;
  if (!isGroup) setTimeout(() => $("#show-target").focus(), 0);
}
$("#show-target-type").addEventListener("change", syncShowTargetFields);

$("#perm-grant").addEventListener("click", () => doPermAction("/api/permissions/grant"));
$("#perm-revoke").addEventListener("click", () => doPermAction("/api/permissions/revoke"));

async function doPermAction(url) {
  const target_type = $("#perm-target-type").value;
  const target = target_type === "group"
    ? $("#perm-target-group").value
    : $("#perm-target").value.trim();
  const permission = $("#perm-permission").value.trim();
  if (!target || !permission) {
    alert("Please fill in both the target and permission fields.");
    return;
  }
  const data = await postJson(url, { target_type, target, permission });
  alert(data.error ? "Error: " + data.error : (data.response || "Done."));
}

$("#group-add").addEventListener("click", () => doGroupAction("/api/group/add-user"));
$("#group-remove").addEventListener("click", () => doGroupAction("/api/group/remove-user"));

async function doGroupAction(url) {
  const user = $("#group-user").value.trim();
  const group = $("#group-name").value.trim();
  if (!user || !group) {
    alert("Please fill in both the player and group fields.");
    return;
  }
  const data = await postJson(url, { user, group });
  alert(data.error ? "Error: " + data.error : (data.response || "Done."));
}

async function loadGroupNames() {
  const selects = $all(".group-select");
  let optionsHtml;
  try {
    const data = await fetch("/api/groups").then((res) => res.json());
    const names = data.names || [];
    optionsHtml = names.length
      ? names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
      : '<option value="">(none found)</option>';
  } catch (err) {
    optionsHtml = '<option value="">(could not load)</option>';
  }
  selects.forEach((select) => {
    select.innerHTML = optionsHtml;
    select._syncCustomSelectTrigger && select._syncCustomSelectTrigger();
  });
}
loadGroupNames();

$("#group-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const group = $("#group-create-name").value.trim();
  const title = $("#group-create-title").value.trim();
  if (!group) {
    alert("Please enter a group name.");
    return;
  }
  const data = await postJson("/api/group/create", { group, title });
  alert(data.error ? "Error: " + data.error : (data.response || "Done."));
  if (!data.error) {
    $("#group-create-name").value = "";
    $("#group-create-title").value = "";
    loadGroupNames();
  }
});

$("#group-remove-submit").addEventListener("click", async () => {
  const group = $("#group-remove-name").value.trim();
  if (!group) {
    alert("Please select a group to remove.");
    return;
  }
  if (!confirm(`Remove the group "${group}"? This cannot be undone.`)) return;
  const data = await postJson("/api/group/remove", { group });
  alert(data.error ? "Error: " + data.error : (data.response || "Done."));
  if (!data.error) loadGroupNames();
});

$("#show-submit").addEventListener("click", async () => {
  const type = $("#show-target-type").value;
  const target = type === "group"
    ? $("#show-target-group").value
    : $("#show-target").value.trim();
  const out = $("#show-output");
  if (!target) {
    out.textContent = "Enter a player or group name first.";
    return;
  }
  out.textContent = "Loading...";
  try {
    const res = await fetch(`/api/permissions/show?type=${encodeURIComponent(type)}&target=${encodeURIComponent(target)}`);
    const data = await res.json();
    out.textContent = data.error ? "Error: " + data.error : (data.response || "(no output)");
  } catch (err) {
    out.textContent = "Error: " + err.message;
  }
});

// ---- Player lookup ----
$("#lookup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const steamid = $("#lookup-steamid").value.trim();
  const resultBox = $("#lookup-result");
  if (!steamid) return;
  resultBox.innerHTML = '<p class="muted">Looking up...</p>';
  try {
    const res = await fetch(`/api/steam/lookup/${encodeURIComponent(steamid)}`);
    const data = await res.json();
    if (data.error) {
      resultBox.innerHTML = `<p class="muted">Error: ${escapeHtml(data.error)}</p>`;
      return;
    }
    renderLookupResult(data);
  } catch (err) {
    resultBox.innerHTML = `<p class="muted">Error: ${escapeHtml(err.message)}</p>`;
  }
});

function renderLookupResult(data) {
  const resultBox = $("#lookup-result");
  const vacClass = data.vac_banned ? "tag-danger" : "tag-ok";
  const gameBanClass = data.number_of_game_bans > 0 ? "tag-danger" : "tag-ok";
  const communityClass = data.community_banned ? "tag-danger" : "tag-ok";
  const economyClass = data.economy_ban && data.economy_ban !== "none" ? "tag-danger" : "tag-ok";

  resultBox.innerHTML = `
    <div class="lookup-card">
      ${data.avatar ? `<img class="lookup-avatar" src="${escapeHtml(data.avatar)}" alt="">` : ""}
      <div class="lookup-info">
        <h3>${escapeHtml(data.name || "Unknown")}</h3>
        <p class="mono muted">${escapeHtml(data.steamid)}</p>
        ${data.profile_url ? `<p><a href="${escapeHtml(data.profile_url)}" target="_blank" rel="noopener">View Steam Profile</a></p>` : ""}
        <p>Account age: ${data.account_age_days != null ? data.account_age_days + " days" : "unknown"}</p>
        <p>Profile visibility: ${data.visibility_public ? "Public" : "Private/Friends only"}</p>
        <div class="tag-row">
          <span class="tag ${vacClass}">VAC bans: ${data.number_of_vac_bans}</span>
          <span class="tag ${gameBanClass}">Game bans: ${data.number_of_game_bans}</span>
          <span class="tag ${communityClass}">${data.community_banned ? "Community banned" : "No community ban"}</span>
          <span class="tag ${economyClass}">Economy: ${escapeHtml(data.economy_ban || "none")}</span>
        </div>
        ${data.days_since_last_ban != null && data.number_of_vac_bans > 0 ? `<p class="muted">Last ban: ${data.days_since_last_ban} days ago</p>` : ""}
      </div>
    </div>
  `;
}

// ---- Server Info ----
const SETTING_FIELDS = ["hostname", "url", "description", "headerimage"];

async function loadServerSettings() {
  try {
    const res = await fetch("/api/server/settings");
    const data = await res.json();
    SETTING_FIELDS.forEach((field) => {
      const input = $("#setting-" + field);
      if (data.error) {
        input.placeholder = "Could not load";
      } else if (data[field]) {
        input.value = data[field];
      } else {
        input.placeholder = "(empty - type a value and Apply)";
      }
    });
  } catch (err) {
    SETTING_FIELDS.forEach((field) => { $("#setting-" + field).placeholder = "Could not load"; });
  }
}
loadServerSettings();

const SETTING_LABELS = { hostname: "hostname", url: "server URL", description: "description", headerimage: "header image" };

$all("[data-setting]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const field = btn.dataset.setting;
    const value = $("#setting-" + field).value.trim();
    if (!value) {
      alert("Enter a value before applying.");
      return;
    }
    const confirmed = await showConfirmModal({
      title: "Apply setting?",
      message: `Set the server's ${SETTING_LABELS[field] || field} to "${value}"?`,
      confirmLabel: "Apply",
    });
    if (!confirmed) return;
    const data = await postJson("/api/server/settings", { field, value });
    alert(data.error ? "Error: " + data.error : "Applied.");
  });
});

$("#refresh-serverinfo").addEventListener("click", loadServerInfo);
loadServerInfo();

// ---- Settings tab: RCON credentials ----
async function loadRconSettings() {
  try {
    const data = await fetch("/api/settings/rcon").then((res) => res.json());
    $("#rcon-setting-host").value = data.rcon_host || "";
    $("#rcon-setting-port").value = data.rcon_port || "";
    $("#rcon-setting-password").value = data.rcon_password || "";
  } catch (err) {
    // fields just stay blank - the form's own Save will surface any real problem
  }
}
loadRconSettings();

$("#rcon-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rcon_host = $("#rcon-setting-host").value.trim();
  const rcon_port = $("#rcon-setting-port").value.trim();
  const rcon_password = $("#rcon-setting-password").value;
  if (!rcon_host || !rcon_port || !rcon_password) {
    alert("Host, port, and password are all required.");
    return;
  }
  const confirmed = await showConfirmModal({
    title: "Save RCON settings?",
    message: `Reconnect to ${rcon_host}:${rcon_port} with the new credentials? This takes effect immediately.`,
    confirmLabel: "Save & Reconnect",
  });
  if (!confirmed) return;
  const data = await postJson("/api/settings/rcon", { rcon_host, rcon_port, rcon_password });
  alert(data.error ? "Error: " + data.error : "Saved - reconnecting now.");
  if (!data.error) refreshStatus();
});

// ---- Settings tab: Wipe Countdown ----
function syncWipeFormVisibility() {
  const frequency = $("#wipe-setting-frequency").value;
  $("#wipe-setting-anchor-wrap").hidden = frequency !== "biweekly";
}
$("#wipe-setting-frequency").addEventListener("change", syncWipeFormVisibility);
$("#wipe-setting-timezone").addEventListener("change", syncWipeFormVisibility);

async function loadWipeSettingsForm() {
  try {
    const data = await fetch("/api/settings/wipe").then((res) => res.json());
    if (data.error) return;
    $("#wipe-setting-frequency").value = data.wipe_frequency || "monthly";
    $("#wipe-setting-time").value = data.wipe_time || "14:00";
    const tz = data.wipe_timezone || "America/Chicago";
    const tzSelect = $("#wipe-setting-timezone");
    tzSelect.value = tz;
    $("#wipe-setting-anchor").value = data.wipe_anchor_date || "";
    syncWipeFormVisibility();
    $("#wipe-setting-frequency")._syncCustomSelectTrigger && $("#wipe-setting-frequency")._syncCustomSelectTrigger();
    tzSelect._syncCustomSelectTrigger && tzSelect._syncCustomSelectTrigger();
  } catch (err) {
    // form just keeps its defaults - Save will surface any real problem
  }
}
loadWipeSettingsForm();

$("#wipe-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const wipe_frequency = $("#wipe-setting-frequency").value;
  const wipe_time = $("#wipe-setting-time").value;
  const wipe_timezone = $("#wipe-setting-timezone").value;
  const wipe_anchor_date = $("#wipe-setting-anchor").value;

  if (!wipe_time || !wipe_timezone) {
    alert("Time and timezone are required.");
    return;
  }
  if (wipe_frequency === "biweekly" && !wipe_anchor_date) {
    alert("Bi-weekly needs an anchor date.");
    return;
  }
  const data = await postJson("/api/settings/wipe", { wipe_frequency, wipe_time, wipe_timezone, wipe_anchor_date });
  if (data.error) {
    alert("Error: " + data.error);
    return;
  }
  alert("Saved.");
  loadWipeConfig();
});

// ---- Settings tab: API Keys ----
// All three are optional, unlike the forms above - no required-field check
// before saving, since leaving one blank is the normal way to turn its
// feature off rather than a mistake to warn about.
async function loadApiKeysSettings() {
  try {
    const data = await fetch("/api/settings/api-keys").then((res) => res.json());
    $("#api-keys-setting-steam").value = data.steam_api_key || "";
    $("#api-keys-setting-rustmaps").value = data.rustmaps_api_key || "";
    $("#api-keys-setting-battlemetrics").value = data.battlemetrics_id || "";
  } catch (err) {
    // fields stay blank - Save will surface any real problem
  }
}
loadApiKeysSettings();

$("#api-keys-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const steam_api_key = $("#api-keys-setting-steam").value.trim();
  const rustmaps_api_key = $("#api-keys-setting-rustmaps").value.trim();
  const battlemetrics_id = $("#api-keys-setting-battlemetrics").value.trim();
  const data = await postJson("/api/settings/api-keys", { steam_api_key, rustmaps_api_key, battlemetrics_id });
  alert(data.error ? "Error: " + data.error : "Saved.");
});

// ---- Settings tab: Update ----
// Checking is an explicit button click, not auto-run on page load like the
// forms above - this is the one Settings page that reaches out to GitHub
// instead of just this PC, so it shouldn't fire every time someone opens
// the Settings tab without asking.
let updateLatestVersion = null;

$("#update-check-btn").addEventListener("click", async () => {
  $("#update-apply-btn").hidden = true;
  updateLatestVersion = null;
  $("#update-status").textContent = "Checking...";
  let data;
  try {
    data = await fetch("/api/settings/update-check").then((res) => res.json());
  } catch (err) {
    // Most likely cause: this page is still running old, already-loaded
    // code from before an update was applied (the update itself succeeded
    // and the files on disk are current, but this specific route didn't
    // exist yet in whatever process is still serving this page) - a
    // restart, not a retry, is what actually fixes that.
    $("#update-status").textContent = "Error: couldn't reach the dashboard - if you just updated, try restarting it.";
    return;
  }
  if (data.error) {
    $("#update-status").textContent = "Error: " + data.error;
    return;
  }
  if (data.update_available) {
    updateLatestVersion = data.latest_version;
    $("#update-status").textContent = `A new version is available: v${data.latest_version}`;
    $("#update-apply-btn").hidden = false;
  } else {
    $("#update-status").textContent = "You're up to date.";
  }
});

$("#update-apply-btn").addEventListener("click", async () => {
  $("#update-apply-btn").disabled = true;
  $("#update-status").textContent = "Downloading and installing the update - this can take a moment...";
  let data;
  try {
    data = await postJson("/api/settings/update-apply", {});
  } catch (err) {
    $("#update-status").textContent = "Error: couldn't reach the dashboard - if it's still running, try restarting it.";
    $("#update-apply-btn").disabled = false;
    return;
  }
  $("#update-apply-btn").disabled = false;
  if (data.error) {
    $("#update-status").textContent = "Error: " + data.error;
    return;
  }
  $("#update-apply-btn").hidden = true;
  const newVersion = data.new_version || updateLatestVersion;
  $("#update-status").textContent = `Updated to v${newVersion}.`;
  // The files on disk (and this label) are current immediately, but the
  // page you're looking at is still running the old code from before the
  // update - it can't swap itself out mid-request. Reflect the new
  // version here anyway so it doesn't look like the update did nothing.
  const versionLabel = $("#update-current-version");
  if (versionLabel) versionLabel.textContent = "v" + newVersion;
  alert('Update installed. Close this window and relaunch the dashboard (e.g. the "Launch NOR Dashboard" shortcut) to start using the new version.');
});

// ---- Settings tab: Module Settings ----
// Each loaded module's own settings form (if it has one) is already
// server-rendered into the page - this just shows what's installed and
// flags anything that was found but skipped (e.g. needs a newer core
// version), since that'd otherwise fail silently.
async function loadModuleStatusList() {
  const box = $("#module-status-list");
  if (!box) return;
  try {
    const data = await fetch("/api/modules").then((res) => res.json());
    const rows = [];
    (data.loaded || []).forEach((m) => {
      rows.push(`<div class="stat-row"><span class="stat-label">${escapeHtml(m.label)}</span><span class="stat-value">Loaded</span></div>`);
    });
    (data.skipped || []).forEach((s) => {
      rows.push(`<div class="stat-row"><span class="stat-label">${escapeHtml(s.key)}</span><span class="stat-value">Skipped - ${escapeHtml(s.reason)}</span></div>`);
    });
    box.innerHTML = rows.join("") || '<p class="muted">No modules found in the modules folder.</p>';
  } catch (err) {
    box.innerHTML = `<p class="muted">Error loading module status: ${escapeHtml(err.message)}</p>`;
  }
}
loadModuleStatusList();

// ---- Settings tab: Theme ----
// Themes only ever touch color custom properties (never --radius or the
// font variables), so picking one never changes the layout - only colors.
// The actual saved theme is applied immediately in a small inline script
// in index.html's <head>, before this file even loads, to avoid a flash
// of the default green theme on page load - everything here is just the
// Settings page's UI (swatch grid, color pickers) plus saving choices.
const THEME_VARS = ["--bg", "--bg-elevated", "--accent", "--accent-soft", "--accent-border", "--text", "--text-muted", "--danger"];

function hexToRgbParts(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}
function rgbaFromHex(hex, alpha) {
  const [r, g, b] = hexToRgbParts(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function shiftHexLightness(hex, amount, alpha) {
  const [r, g, b] = hexToRgbParts(hex);
  const clamp = (v) => Math.max(0, Math.min(255, v + amount));
  return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${alpha})`;
}

const THEME_PRESETS = {
  "neon-green": {
    name: "Neon Green", swatch: "#39ff14",
    "--bg": "#0a0d0a", "--bg-elevated": "rgba(18, 22, 16, .85)",
    "--accent": "#39ff14", "--accent-soft": "rgba(57, 255, 20, .14)", "--accent-border": "rgba(57, 255, 20, .35)",
    "--text": "#eef1ec", "--text-muted": "#a6b0a3", "--danger": "#ff4d4d",
  },
  "cyber-blue": {
    name: "Cyber Blue", swatch: "#00d9ff",
    "--bg": "#070d12", "--bg-elevated": "rgba(15, 26, 33, .85)",
    "--accent": "#00d9ff", "--accent-soft": "rgba(0, 217, 255, .14)", "--accent-border": "rgba(0, 217, 255, .35)",
    "--text": "#eaf6fb", "--text-muted": "#9bb2bb", "--danger": "#ff5d5d",
  },
  "crimson-red": {
    name: "Crimson Red", swatch: "#ff2d4d",
    "--bg": "#120808", "--bg-elevated": "rgba(33, 16, 16, .85)",
    "--accent": "#ff2d4d", "--accent-soft": "rgba(255, 45, 77, .14)", "--accent-border": "rgba(255, 45, 77, .35)",
    "--text": "#f8eaea", "--text-muted": "#bb9b9b", "--danger": "#ff8a3d",
  },
  "amber-gold": {
    name: "Amber Gold", swatch: "#ffb000",
    "--bg": "#120e06", "--bg-elevated": "rgba(33, 26, 14, .85)",
    "--accent": "#ffb000", "--accent-soft": "rgba(255, 176, 0, .14)", "--accent-border": "rgba(255, 176, 0, .35)",
    "--text": "#f8f1e6", "--text-muted": "#bbab8a", "--danger": "#ff4d4d",
  },
  "purple-haze": {
    name: "Purple Haze", swatch: "#b14eff",
    "--bg": "#0d0814", "--bg-elevated": "rgba(24, 16, 33, .85)",
    "--accent": "#b14eff", "--accent-soft": "rgba(177, 78, 255, .14)", "--accent-border": "rgba(177, 78, 255, .35)",
    "--text": "#f1eaf8", "--text-muted": "#a999bb", "--danger": "#ff4d6d",
  },
};

function extractThemeVars(source) {
  const vars = {};
  THEME_VARS.forEach((v) => { if (source[v]) vars[v] = source[v]; });
  return vars;
}
function applyThemeVars(vars) {
  const root = document.documentElement.style;
  THEME_VARS.forEach((v) => { if (vars[v]) root.setProperty(v, vars[v]); });
}
// Tracks whatever's currently previewed (applied live to the page) so the
// Save button has something to send - separate from actually persisting
// it, which now only happens when Save is clicked (see #theme-settings-form
// below), not on every preset click or color tweak.
let activeThemeState = { vars: extractThemeVars(THEME_PRESETS["neon-green"]), presetKey: "neon-green" };

function setActiveTheme(vars, presetKey) {
  activeThemeState = { vars: extractThemeVars(vars), presetKey: presetKey || null };
}
function deriveThemeFromCustom({ accent, bg, text, danger }) {
  return {
    "--bg": bg,
    "--bg-elevated": shiftHexLightness(bg, 10, .85),
    "--accent": accent,
    "--accent-soft": rgbaFromHex(accent, .14),
    "--accent-border": rgbaFromHex(accent, .35),
    "--text": text,
    "--text-muted": shiftHexLightness(text, -65, 1),
    "--danger": danger,
  };
}
function syncCustomColorInputs(vars) {
  if (vars["--accent"]) $("#theme-color-accent").value = vars["--accent"];
  if (vars["--bg"]) $("#theme-color-bg").value = vars["--bg"];
  if (vars["--text"]) $("#theme-color-text").value = vars["--text"];
  if (vars["--danger"]) $("#theme-color-danger").value = vars["--danger"];
}

function populateThemePresetSelect(activePresetKey) {
  const select = $("#theme-preset-select");
  select.innerHTML = Object.entries(THEME_PRESETS)
    .map(([key, preset]) => `<option value="${escapeHtml(key)}" data-color="${escapeHtml(preset.swatch)}">${escapeHtml(preset.name)}</option>`)
    .join("") + `<option value="" data-color="">Custom</option>`;
  select.value = activePresetKey || "";
  select._syncCustomSelectTrigger && select._syncCustomSelectTrigger();
}

$("#theme-preset-select").addEventListener("change", () => {
  const key = $("#theme-preset-select").value;
  const preset = THEME_PRESETS[key];
  if (!preset) return; // "Custom" - nothing to apply, the color pickers already reflect it
  applyThemeVars(preset);
  syncCustomColorInputs(preset);
  setActiveTheme(preset, key);
});

["accent", "bg", "text", "danger"].forEach((field) => {
  $("#theme-color-" + field).addEventListener("input", () => {
    const custom = deriveThemeFromCustom({
      accent: $("#theme-color-accent").value,
      bg: $("#theme-color-bg").value,
      text: $("#theme-color-text").value,
      danger: $("#theme-color-danger").value,
    });
    applyThemeVars(custom);
    setActiveTheme(custom, null);
    populateThemePresetSelect(null);
  });
});

$("#theme-reset").addEventListener("click", () => {
  THEME_VARS.forEach((v) => document.documentElement.style.removeProperty(v));
  syncCustomColorInputs(THEME_PRESETS["neon-green"]);
  populateThemePresetSelect("neon-green");
  setActiveTheme(THEME_PRESETS["neon-green"], "neon-green");
});

$("#theme-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = await postJson("/api/settings/theme", {
    theme_preset_key: activeThemeState.presetKey,
    theme_vars: activeThemeState.vars,
  });
  alert(data.error ? "Error: " + data.error : "Theme saved - it'll still be set next time you open the dashboard.");
});

async function loadThemeSettingsForm() {
  let saved = null;
  try {
    const data = await fetch("/api/settings/theme").then((res) => res.json());
    if (data.theme_vars && Object.keys(data.theme_vars).length) saved = data;
  } catch (err) {
    // the inline <head> script already applied whatever config.json had,
    // or the default stylesheet theme if nothing was ever saved - this
    // form just couldn't fetch a fresh copy to sync its own UI to.
  }
  const activeVars = (saved && saved.theme_vars) || THEME_PRESETS["neon-green"];
  const presetKey = saved ? saved.theme_preset_key : "neon-green";
  syncCustomColorInputs(activeVars);
  populateThemePresetSelect(presetKey || null);
  setActiveTheme(activeVars, presetKey);
}
loadThemeSettingsForm();

// ---- Alerts settings ----

let _alertsWatchlist = [];

function _renderWatchlist() {
  const container = $("#alert-watchlist-list");
  if (!container) return;
  container.innerHTML = "";
  if (_alertsWatchlist.length === 0) {
    container.innerHTML = '<p class="muted" style="font-size: 12px; margin: 0 0 6px;">No players on watchlist yet.</p>';
    return;
  }
  _alertsWatchlist.forEach((entry, idx) => {
    const row = document.createElement("div");
    row.className = "inline-form";
    row.style.cssText = "gap: 8px; margin-bottom: 4px; align-items: center;";
    row.innerHTML = `
      <span style="flex: 1; font-family: monospace; font-size: 13px;">${_esc(entry.steamid)}</span>
      <span style="flex: 1; font-size: 13px; color: var(--text-muted);">${_esc(entry.label || "")}</span>
      <button class="btn btn-outline btn-small" style="color: var(--danger); border-color: var(--danger);" data-wl-idx="${idx}">Remove</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      _alertsWatchlist.splice(idx, 1);
      _renderWatchlist();
    });
    container.appendChild(row);
  });
}

function _esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function loadAlertsSettings() {
  try {
    const [data, modules] = await Promise.all([
      fetch("/api/settings/alerts").then((r) => r.json()),
      fetch("/api/modules").then((r) => r.json()),
    ]);
    _alertsWatchlist = Array.isArray(data.watchlist) ? data.watchlist : [];
    $("#alert-fps-enabled").checked = !!data.fps_enabled;
    $("#alert-fps-threshold").value = data.fps_threshold ?? 15;
    $("#alert-fps-consecutive").value = data.fps_consecutive ?? 3;
    $("#alert-player-count-enabled").checked = !!data.player_count_enabled;
    $("#alert-player-count-threshold").value = data.player_count_threshold ?? 100;
    $("#alert-entity-spike-enabled").checked = !!data.entity_spike_enabled;
    $("#alert-entity-spike-pct").value = data.entity_spike_pct ?? 25;
    $("#alert-rcon-offline-enabled").checked = !!data.rcon_offline_enabled;
    $("#alert-rcon-offline-minutes").value = data.rcon_offline_minutes ?? 5;
    $("#alert-sound-enabled").checked = data.sound_enabled !== false;
    $("#alert-discord-webhook").value = data.discord_webhook || "";
    const devtoolsLoaded = (modules.loaded || []).some((m) => m.key === "devtools");
    const broadcastWrap = $("#alert-devtools-broadcast-wrap");
    broadcastWrap.hidden = !devtoolsLoaded;
    if (devtoolsLoaded) $("#alert-devtools-broadcast").checked = !!data.devtools_broadcast;
    _renderWatchlist();
  } catch (err) {
    // keep defaults
  }
}

async function saveAlertsSettings() {
  const payload = {
    watchlist: _alertsWatchlist,
    fps_enabled: $("#alert-fps-enabled").checked,
    fps_threshold: parseInt($("#alert-fps-threshold").value) || 15,
    fps_consecutive: parseInt($("#alert-fps-consecutive").value) || 3,
    player_count_enabled: $("#alert-player-count-enabled").checked,
    player_count_threshold: parseInt($("#alert-player-count-threshold").value) || 100,
    entity_spike_enabled: $("#alert-entity-spike-enabled").checked,
    entity_spike_pct: parseInt($("#alert-entity-spike-pct").value) || 25,
    rcon_offline_enabled: $("#alert-rcon-offline-enabled").checked,
    rcon_offline_minutes: parseInt($("#alert-rcon-offline-minutes").value) || 5,
    sound_enabled: $("#alert-sound-enabled").checked,
    discord_webhook: ($("#alert-discord-webhook").value || "").trim(),
    devtools_broadcast: !$("#alert-devtools-broadcast-wrap").hidden && $("#alert-devtools-broadcast").checked,
  };
  const result = await postJson("/api/settings/alerts", payload);
  if (result.error) {
    showToast({ title: "Save failed", message: result.error, variant: "error" });
  } else {
    showToast({ title: "Alerts saved", message: "Alert configuration updated.", variant: "info" });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const addBtn = document.getElementById("alert-watchlist-add");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const sidInput = $("#alert-watchlist-steamid");
      const labelInput = $("#alert-watchlist-label");
      const sid = (sidInput.value || "").trim();
      if (!sid) { sidInput.focus(); return; }
      if (!_alertsWatchlist.find((e) => e.steamid === sid)) {
        _alertsWatchlist.push({ steamid: sid, label: (labelInput.value || "").trim() });
        _renderWatchlist();
      }
      sidInput.value = "";
      labelInput.value = "";
    });
  }
  const saveBtn = document.getElementById("alert-settings-save");
  if (saveBtn) saveBtn.addEventListener("click", saveAlertsSettings);
});

async function checkSystemAlerts() {
  try {
    const data = await fetch("/api/alerts/pending").then((r) => r.json());
    const alerts = data.alerts || [];
    if (alerts.length === 0) return;
    let playSound = false;
    alerts.forEach((a) => {
      if (_isDupeToast(a.title, a.message)) return;
      showToast({ title: a.title, message: a.message, variant: a.variant || "error" });
      if (a.play_sound) playSound = true;
    });
    if (playSound) playAlertTone();
  } catch (err) {
    // next poll will catch up
  }
}

// Load alerts settings when the Alerts subnav is activated
(function () {
  let _alertsLoaded = false;
  document.addEventListener("click", (e) => {
    if (e.target.matches && e.target.matches('[data-settings-section="alerts"]') && !_alertsLoaded) {
      _alertsLoaded = true;
      loadAlertsSettings();
    }
  });
})();

// ---- Notifications settings (tour dismissal + sound alerts) ----
// Kept in one module-level object since both the guided tour and the
// join-alert toast (added separately) need to read sound_alerts_enabled/
// tour_dismissed without each re-fetching it themselves.
let notificationSettings = { tour_dismissed: false, sound_alerts_enabled: true };

async function loadNotificationSettings() {
  try {
    const data = await fetch("/api/settings/notifications").then((res) => res.json());
    notificationSettings = data;
  } catch (err) {
    // stick with the defaults above - worst case the tour shows up once
    // more than it should, or sound alerts default to on.
  }
  $("#notifications-setting-tour-dismissed").checked = !!notificationSettings.tour_dismissed;
  $("#notifications-setting-sound-alerts").checked = notificationSettings.sound_alerts_enabled !== false;
  if (!notificationSettings.tour_dismissed) startTour();
}
loadNotificationSettings();

$("#notifications-settings-form").addEventListener("submit", async () => {
  const tourDismissed = $("#notifications-setting-tour-dismissed").checked;
  const soundAlerts = $("#notifications-setting-sound-alerts").checked;
  const data = await postJson("/api/settings/notifications", { tour_dismissed: tourDismissed, sound_alerts_enabled: soundAlerts });
  if (data.error) {
    alert("Error: " + data.error);
    return;
  }
  notificationSettings = { tour_dismissed: tourDismissed, sound_alerts_enabled: soundAlerts };
  showToast({ title: "Settings saved", message: "Notification preferences updated.", variant: "info" });
});

$("#replay-tour-btn").addEventListener("click", startTour);

// ---- First-run guided tour ----
// Targets the tab buttons themselves (and the settings gear) rather than
// content inside each tab - the one set of elements guaranteed to exist
// and be visible regardless of which tab happens to be active when the
// tour starts.
const TOUR_STEPS = [
  { tab: "overview", selector: '[data-tab="overview"]', title: "Overview", text: "Your at-a-glance dashboard - player count, server stats, and entity-count history. This is what loads first every time." },
  { tab: "console", selector: '[data-tab="console"]', title: "Console", text: "A live feed of everything your server logs, a command box, broadcast messages, and quick kick/give-item actions for whoever's online." },
  { tab: "players", selector: '[data-tab="players"]', title: "Players", text: "Online, offline, and banned players - kick, ban, bulk actions on multiple players at once, notes, and a filter box to find someone fast." },
  { tab: "map", selector: '[data-tab="map"]', title: "Live Map", text: "Real-time player positions, world events, and the map's oil rigs, overlaid on your actual map image." },
  { tab: "amap", selector: '[data-tab="amap"]', title: "AMAP", text: "Run your server's backup, wipe, update, and log-cleaning scripts with one click - no SSH or memorized commands needed." },
  { tab: "settings", selector: "#settings-gear-btn", title: "Settings", text: "RCON, API keys, theme, wipe schedule, and notification preferences (including turning this tour off for good) all live here." },
];
let tourStepIndex = 0;

function positionTourHighlight(el) {
  const rect = el.getBoundingClientRect();
  const pad = 6;
  const highlight = $("#tour-highlight");
  highlight.style.top = (rect.top - pad) + "px";
  highlight.style.left = (rect.left - pad) + "px";
  highlight.style.width = (rect.width + pad * 2) + "px";
  highlight.style.height = (rect.height + pad * 2) + "px";

  const caption = $("#tour-caption");
  const captionWidth = 320;
  const fitsBelow = rect.bottom + 220 < window.innerHeight;
  if (fitsBelow) {
    caption.style.top = (rect.bottom + 16) + "px";
    caption.style.bottom = "";
  } else {
    caption.style.bottom = (window.innerHeight - rect.top + 16) + "px";
    caption.style.top = "";
  }
  caption.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - captionWidth - 16)) + "px";
}

function showTourStep(index) {
  const step = TOUR_STEPS[index];
  if (!step) {
    endTour($("#tour-dont-show-again").checked);
    return;
  }
  activateTab(step.tab);
  // Tab switching can change layout (e.g. content height) - wait a frame
  // so getBoundingClientRect() below reflects the post-switch layout.
  requestAnimationFrame(() => {
    const el = document.querySelector(step.selector);
    if (!el) {
      tourStepIndex++;
      showTourStep(tourStepIndex);
      return;
    }
    positionTourHighlight(el);
    $("#tour-caption-title").textContent = step.title;
    $("#tour-caption-text").textContent = step.text;
    $("#tour-step-counter").textContent = `Step ${index + 1} of ${TOUR_STEPS.length}`;
    $("#tour-next-btn").textContent = index === TOUR_STEPS.length - 1 ? "Finish" : "Next";
    $("#tour-back-btn").disabled = index === 0;
  });
}

function startTour() {
  tourStepIndex = 0;
  $("#tour-overlay").hidden = false;
  $("#tour-dont-show-again").checked = false;
  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
  showTourStep(0);
}

async function endTour(dismissPermanently) {
  $("#tour-overlay").hidden = true;
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
  if (dismissPermanently && !notificationSettings.tour_dismissed) {
    notificationSettings.tour_dismissed = true;
    $("#notifications-setting-tour-dismissed").checked = true;
    await postJson("/api/settings/notifications", notificationSettings);
  }
}

$("#tour-next-btn").addEventListener("click", () => {
  tourStepIndex++;
  showTourStep(tourStepIndex);
});
$("#tour-back-btn").addEventListener("click", () => {
  if (tourStepIndex > 0) {
    tourStepIndex--;
    showTourStep(tourStepIndex);
  }
});
$("#tour-skip-btn").addEventListener("click", () => endTour($("#tour-dont-show-again").checked));
window.addEventListener("resize", () => {
  if (!$("#tour-overlay").hidden) showTourStep(tourStepIndex);
});

const STAT_LABELS = {
  Hostname: "Hostname",
  Map: "Map",
  Players: "Players",
  MaxPlayers: "Max Players",
  Queued: "Queued",
  Joining: "Joining",
  EntityCount: "Entity Count",
  Framerate: "Framerate",
  Uptime: "Uptime",
  GameTime: "Game Time",
};

async function loadServerInfo() {
  const box = $("#serverinfo-stats");
  box.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const res = await fetch("/api/server/info");
    const data = await res.json();
    if (data.error) {
      box.innerHTML = `<p class="muted">Error: ${escapeHtml(data.error)}</p>`;
      return;
    }
    if (data.raw !== undefined) {
      box.innerHTML = `<p class="muted">Response wasn't in the expected format. Raw response: ${escapeHtml(data.raw)}</p>`;
      return;
    }
    box.innerHTML = "";
    Object.entries(STAT_LABELS).forEach(([key, label]) => {
      if (data[key] === undefined) return;
      const value = key === "Uptime" ? formatSeconds(data[key]) : String(data[key]);
      const row = document.createElement("div");
      row.className = "stat-row";
      row.innerHTML = `<span class="stat-label">${label}</span><span class="stat-value">${escapeHtml(value)}</span>`;
      box.appendChild(row);
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// ---- Live Map ----
// Background image comes from RustMaps.com, looked up by the server's own
// seed/world size so it follows wipes automatically. Markers (players +
// world events) are polled separately and positioned with plain percentage
// left/top, normalized from world coordinates against the world size - that
// works regardless of how large the image renders, no pixel math needed.
const EVENT_LABEL_SLUGS = {
  "Cargo Ship": "cargoship",
  "Patrol Helicopter": "patrolhelicopter",
  "Bradley APC": "bradleyapc",
  "CH47 (Chinook)": "ch47",
  "Cargo Plane": "cargoplane",
};

// Oil rigs are static monuments, not a polled find_entity event - their
// coordinates come from RustMaps' own monument list (see map_data.py),
// fetched once per seed/size alongside the map image itself, not on the
// 8s event poll.
const OIL_RIG_SLUGS = {
  "Small Oilrig": "oilrig-small",
  "Large Oilrig": "oilrig-large",
};

let mapWorldSize = null;
let mapOilRigs = [];
let mapPollTimer = null;
const hiddenMapTypes = new Set();
let selectedMapSteamid = null;
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapDragging = false;
let mapDragStartX = 0, mapDragStartY = 0;
let mapDragPanStartX = 0, mapDragPanStartY = 0;

function applyMapTransform() {
  $("#map-canvas").style.transform = `translate(${mapPanX}px,${mapPanY}px) scale(${mapZoom})`;
}

function clampMapPan() {
  const wrap = $("#map-wrap");
  const wrapW = wrap.offsetWidth;
  const wrapH = wrap.offsetHeight;
  const scaledW = 900 * mapZoom;
  const scaledH = 900 * mapZoom;
  mapPanX = scaledW > wrapW ? Math.max(wrapW - scaledW, Math.min(0, mapPanX)) : 0;
  mapPanY = scaledH > wrapH ? Math.max(wrapH - scaledH, Math.min(0, mapPanY)) : 0;
}

function followSelectedPlayer(players) {
  if (!selectedMapSteamid || mapZoom <= 1) return;
  const p = players.find((pl) => pl.steamid === selectedMapSteamid);
  if (!p) return;
  const pos = mapPosition(p.x, p.z);
  if (!pos) return;
  const wrap = $("#map-wrap");
  const wrapW = wrap.offsetWidth;
  const wrapH = wrap.offsetHeight;
  mapPanX = wrapW / 2 - (pos.left / 100) * 900 * mapZoom;
  mapPanY = wrapH / 2 - (pos.top / 100) * 900 * mapZoom;
  clampMapPan();
  applyMapTransform();
}

// Map toggle buttons
$all(".map-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.mapType;
    if (hiddenMapTypes.has(type)) {
      hiddenMapTypes.delete(type);
      btn.classList.add("active");
    } else {
      hiddenMapTypes.add(type);
      btn.classList.remove("active");
    }
    loadMapEntities();
  });
});

// Map zoom via mouse wheel
$("#map-wrap").addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = $("#map-wrap").getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.max(1, Math.min(4, mapZoom * factor));
  mapPanX = mouseX - (mouseX - mapPanX) * (newZoom / mapZoom);
  mapPanY = mouseY - (mouseY - mapPanY) * (newZoom / mapZoom);
  mapZoom = newZoom;
  clampMapPan();
  applyMapTransform();
}, { passive: false });

// Map pan via drag
$("#map-wrap").addEventListener("mousedown", (e) => {
  if (mapZoom <= 1) return;
  mapDragging = true;
  mapDragStartX = e.clientX;
  mapDragStartY = e.clientY;
  mapDragPanStartX = mapPanX;
  mapDragPanStartY = mapPanY;
  $("#map-wrap").classList.add("panning");
});
document.addEventListener("mousemove", (e) => {
  if (!mapDragging) return;
  mapPanX = mapDragPanStartX + (e.clientX - mapDragStartX);
  mapPanY = mapDragPanStartY + (e.clientY - mapDragStartY);
  clampMapPan();
  applyMapTransform();
});
document.addEventListener("mouseup", () => {
  if (mapDragging) {
    mapDragging = false;
    $("#map-wrap").classList.remove("panning");
  }
});

async function loadMapImage() {
  const status = $("#map-status");
  const img = $("#map-image");
  status.textContent = "Loading map...";
  try {
    const res = await fetch("/api/map/image");
    const data = await res.json();
    mapWorldSize = Number(data.size) || null;
    mapOilRigs = data.oil_rigs || [];
    if (data.status === "ready") {
      img.src = data.image_url;
      img.hidden = false;
      status.textContent = `Seed ${data.seed} - World size ${data.size}`;
    } else if (data.status === "generating") {
      img.hidden = true;
      status.textContent = "RustMaps is generating this map for the first time - this can take a couple minutes. Click Refresh to check again.";
    } else {
      img.hidden = true;
      status.textContent = data.error || "Could not load the map image.";
    }
  } catch (err) {
    img.hidden = true;
    status.textContent = "Error: " + err.message;
  }
}

// v1.4.3 tried to compensate for oil rigs sitting outside +-worldsize/2
// by widening this scale for every marker - that was wrong: checking
// several on-land monuments (Outpost, Bandit Town, both Lighthouses)
// against RustMaps' own coordinates for this map, every one of them
// already falls inside +-worldsize/2 on both axes. Only the oil rigs sit
// outside it. Widening the scale for everyone shifted players and every
// event noticeably off their real position (e.g. ~40px on a 900px
// canvas for a monument like Outpost) to "fix" markers that were never
// actually wrong. Reverted to the original worldsize-only scale, and
// clamped the result instead so a marker that's genuinely outside the
// rendered image (currently just the two oil rigs) still pins to just
// inside the edge in the right general direction rather than landing
// off-canvas and invisible.
function mapPosition(x, z) {
  if (!mapWorldSize || x == null || z == null) return null;
  const left = ((x + mapWorldSize / 2) / mapWorldSize) * 100;
  const top = (1 - (z + mapWorldSize / 2) / mapWorldSize) * 100;
  return {
    left: Math.max(1, Math.min(99, left)),
    top: Math.max(1, Math.min(99, top)),
  };
}

function mapMarker(x, z, className, title) {
  const pos = mapPosition(x, z);
  if (!pos) return null;
  const el = document.createElement("div");
  el.className = className;
  el.style.left = pos.left + "%";
  el.style.top = pos.top + "%";
  el.title = title;
  return el;
}

function playerMapMarker(p) {
  const pos = mapPosition(p.x, p.z);
  if (!pos) return null;
  const el = document.createElement("div");
  el.className = "map-player-marker" + (selectedMapSteamid === p.steamid ? " map-player-selected" : "");
  el.style.left = pos.left + "%";
  el.style.top = pos.top + "%";
  el.title = p.name;
  const avatarHtml = p.avatar
    ? `<img class="map-player-avatar" src="${escapeHtml(p.avatar)}" alt="">`
    : '<div class="map-player-avatar map-player-avatar-blank"></div>';
  el.innerHTML = `${avatarHtml}<span class="map-player-name">${escapeHtml(p.name)}</span>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedMapSteamid = selectedMapSteamid === p.steamid ? null : p.steamid;
    loadMapEntities();
  });
  return el;
}

async function loadMapEntities() {
  if (!mapWorldSize) return; // image load hasn't told us the world size yet
  const overlay = $("#map-overlay");
  try {
    const res = await fetch("/api/map/entities");
    const data = await res.json();
    if (data.error) return;
    overlay.innerHTML = "";
    if (!hiddenMapTypes.has("players")) {
      (data.players || []).forEach((p) => {
        const el = playerMapMarker(p);
        if (el) overlay.appendChild(el);
      });
    }
    (data.events || []).forEach((e) => {
      const slug = EVENT_LABEL_SLUGS[e.label] || "";
      if (slug && hiddenMapTypes.has(slug)) return;
      const el = mapMarker(e.x, e.z, `map-marker-icon map-icon-${slug}`, e.label);
      if (el) overlay.appendChild(el);
    });
    if (!hiddenMapTypes.has("oilrigs")) {
      mapOilRigs.forEach((r) => {
        const slug = OIL_RIG_SLUGS[r.type] || "";
        const el = mapMarker(r.x, r.z, `map-marker-icon map-icon-${slug}`, r.type);
        if (el) overlay.appendChild(el);
      });
    }
    followSelectedPlayer(data.players || []);
  } catch (err) {
    // next poll will catch up
  }
}

function startMapPolling() {
  if (mapPollTimer) return;
  loadMapImage().then(loadMapEntities);
  mapPollTimer = setInterval(loadMapEntities, 8000);
}

function stopMapPolling() {
  if (mapPollTimer) {
    clearInterval(mapPollTimer);
    mapPollTimer = null;
  }
}

$("#refresh-map").addEventListener("click", () => loadMapImage().then(loadMapEntities));

// ---- Reusable styled confirmation modal ----
// Replaces native confirm()/prompt() so destructive actions match the
// dashboard's theme instead of a jarring OS-native popup. Resolves true if
// confirmed, false if cancelled (Cancel button, clicking outside, or Esc).
// Pass requiredText to additionally require typing that exact text before
// Confirm will go through - used for AMAP's Critical actions.
function showConfirmModal({ title, message, requiredText, confirmLabel, confirmClass }) {
  return new Promise((resolve) => {
    const overlay = $("#confirm-modal");
    const typedWrap = $("#confirm-modal-typed-wrap");
    const typedInput = $("#confirm-modal-typed-input");
    const confirmBtn = $("#confirm-modal-confirm");
    const cancelBtn = $("#confirm-modal-cancel");

    $("#confirm-modal-title").textContent = title || "Are you sure?";
    $("#confirm-modal-message").textContent = message || "";
    confirmBtn.textContent = confirmLabel || "Confirm";
    confirmBtn.className = "btn " + (confirmClass || "btn-primary");
    typedInput.value = "";
    if (requiredText) {
      typedWrap.hidden = false;
      typedInput.placeholder = `Type "${requiredText}" to confirm`;
    } else {
      typedWrap.hidden = true;
    }
    overlay.hidden = false;
    (requiredText ? typedInput : confirmBtn).focus();

    function cleanup(result) {
      overlay.hidden = true;
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onConfirm() {
      if (requiredText && typedInput.value.trim() !== requiredText) {
        typedInput.focus();
        return;
      }
      cleanup(true);
    }
    function onCancel() { cleanup(false); }
    function onOverlayClick(e) { if (e.target === overlay) cleanup(false); }
    function onKeydown(e) { if (e.key === "Escape") cleanup(false); }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
  });
}

// ---- Help tab ----
$("#help-faq-toggle").addEventListener("click", () => {
  const content = $("#help-faq-content");
  content.hidden = !content.hidden;
  $("#help-faq-toggle").textContent = content.hidden ? "Show FAQ / Troubleshooting" : "Hide FAQ / Troubleshooting";
});

// Runs last so every .custom-select's <option>s (including the Theme
// preset dropdown, populated synchronously above) already exist.
$all(".custom-select").forEach(initCustomSelect);
