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

async function checkServerReachable() {
  try {
    const data = await fetch("/api/status").then((res) => res.json());
    return !!data.connected;
  } catch (err) {
    return false;
  }
}

async function runLoadingGate() {
  const startedAt = Date.now();
  const deadline = startedAt + LOADING_TIMEOUT_MS;
  const progressTimer = setInterval(() => {
    setLoadingProgress(Math.round(((Date.now() - startedAt) / LOADING_TIMEOUT_MS) * 100));
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

function activateTab(tab) {
  $all(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#settings-gear-btn").classList.toggle("active", tab === "settings");
  $all(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
  if (tab === "map") startMapPolling(); else stopMapPolling();
  if (tab === "terminal") fitTerminal();
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
function showToast({ title, message, fix, variant }) {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${variant === "error" ? "error" : "info"}`;
  el.innerHTML = `
    <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
    ${fix ? `<div class="toast-fix">Suggested fix: ${escapeHtml(fix)}</div>` : ""}
  `;
  el.querySelector(".toast-close").addEventListener("click", () => el.remove());
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
}
refreshStatus();
setInterval(refreshStatus, 15000);

// ---- Console ----
const consoleOutput = $("#console-output");
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
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
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

  function syncTrigger() {
    const opt = select.options[select.selectedIndex];
    trigger.innerHTML = opt ? `${dotHtml(opt.dataset.color)}${escapeHtml(opt.textContent)}` : "";
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
      .map((opt) => `<div class="combo-option" data-value="${escapeHtml(opt.value)}">${dotHtml(opt.dataset.color)}${escapeHtml(opt.textContent)}</div>`)
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
function renderPlayerList(box, players, errorMessage) {
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
    row.innerHTML = `
      ${avatarHtml}
      <div class="console-player-meta">
        <div class="console-player-name">${escapeHtml(p.name)}</div>
        <div class="console-player-time muted">${escapeHtml(timeText)}</div>
      </div>
    `;
    box.appendChild(row);
  });
}

// Compact player list next to the console - name, avatar, session time.
// Also doubles as the data source for the Permissions tab's player
// dropdown suggestions and the Overview tab's connected-players panel,
// since it's already fetching this every 20s.
async function refreshConsolePlayerList() {
  const consoleBox = $("#console-player-list");
  const overviewBox = $("#overview-player-list");
  try {
    const res = await fetch("/api/players/online");
    const data = await res.json();
    if (data.error) {
      renderPlayerList(consoleBox, [], data.error);
      renderPlayerList(overviewBox, [], data.error);
      updateOnlinePlayersDatalist([]);
      return;
    }
    const players = data.players || [];
    updateOnlinePlayersDatalist(players);
    renderPlayerList(consoleBox, players);
    renderPlayerList(overviewBox, players);
  } catch (err) {
    renderPlayerList(consoleBox, [], err.message);
    renderPlayerList(overviewBox, [], err.message);
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

async function loadPlayers() {
  const body = $("#players-body");
  body.innerHTML = '<tr><td colspan="9" class="muted">Loading...</td></tr>';
  try {
    const res = await fetch("/api/players");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<tr><td colspan="9" class="muted">Error: ${escapeHtml(data.error)}</td></tr>`;
      return;
    }
    const players = data.players || [];
    if (players.length === 0) {
      body.innerHTML = data.ok === false
        ? `<tr><td colspan="9" class="muted">Response wasn't in the expected format.<br>Raw response: ${escapeHtml(data.raw || "(empty)")}</td></tr>`
        : `<tr><td colspan="9" class="muted">No players currently online.</td></tr>`;
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
        <td>${escapeHtml(name)}</td>
        <td class="mono">${escapeHtml(steamid)}</td>
        <td class="mono">${escapeHtml(String(ip))}</td>
        <td>${escapeHtml(String(ping))}</td>
        <td>${escapeHtml(session)}</td>
        <td>${escapeHtml(total)}</td>
        <td>${escapeHtml(lastConnected)}</td>
        <td>${escapeHtml(String(rustHours))}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-outline btn-small" data-steamid="${escapeHtml(steamid)}">Look up</button>
            <button class="btn btn-outline btn-small" data-notes-steamid="${escapeHtml(steamid)}">Notes</button>
            <button class="btn ${banClass} btn-small" data-ban-steamid="${escapeHtml(steamid)}" data-banned="${p.banned ? "true" : "false"}" data-name="${escapeHtml(name)}">${banLabel}</button>
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
        }
        refreshAllPlayerTables();
      });
    });
  } catch (err) {
    body.innerHTML = `<tr><td colspan="9" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function refreshAllPlayerTables() {
  loadPlayers();
  loadOfflinePlayers();
  loadBannedPlayers();
}

// ---- Offline Players ----
$("#refresh-offline").addEventListener("click", loadOfflinePlayers);

async function loadOfflinePlayers() {
  const body = $("#offline-body");
  body.innerHTML = '<tr><td colspan="5" class="muted">Loading...</td></tr>';
  try {
    const res = await fetch("/api/players/offline");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<tr><td colspan="5" class="muted">Error: ${escapeHtml(data.error)}</td></tr>`;
      return;
    }
    const players = data.players || [];
    if (players.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="muted">No recently-seen offline players yet.</td></tr>';
      return;
    }
    body.innerHTML = "";
    players.forEach((p) => {
      const total = p.total_seconds_on_server != null ? formatSeconds(p.total_seconds_on_server) : "-";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(p.name || "Unknown")}</td>
        <td class="mono">${escapeHtml(p.steamid)}</td>
        <td>${escapeHtml(total)}</td>
        <td>${escapeHtml(formatLastConnected(p.last_connected))}</td>
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
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- Banned Players ----
$("#refresh-banned").addEventListener("click", loadBannedPlayers);

async function loadBannedPlayers() {
  const body = $("#banned-body");
  body.innerHTML = '<tr><td colspan="3" class="muted">Loading...</td></tr>';
  try {
    const res = await fetch("/api/players/banned");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<tr><td colspan="3" class="muted">Error: ${escapeHtml(data.error)}</td></tr>`;
      return;
    }
    const players = data.players || [];
    if (players.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="muted">No players currently banned.</td></tr>';
      return;
    }
    body.innerHTML = "";
    players.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
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
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- Player Notes ----
function formatNoteTimestamp(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
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
    if (notes.length === 0) {
      box.innerHTML = '<p class="muted">No notes for this player yet.</p>';
      return;
    }
    box.innerHTML = notes
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
        loadNotes(btn.dataset.deleteNoteSteamid);
      });
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">Error: ${escapeHtml(err.message)}</p>`;
  }
}

$("#notes-load").addEventListener("click", () => loadNotes($("#notes-steamid").value.trim()));

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
  $("#notes-text").value = "";
  loadNotes(steamid);
});

// ---- Permissions ----
$("#perm-grant").addEventListener("click", () => doPermAction("/api/permissions/grant"));
$("#perm-revoke").addEventListener("click", () => doPermAction("/api/permissions/revoke"));

async function doPermAction(url) {
  const target_type = $("#perm-target-type").value;
  const target = $("#perm-target").value.trim();
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

$("#show-submit").addEventListener("click", async () => {
  const type = $("#show-target-type").value;
  const target = $("#show-target").value.trim();
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

// ---- Settings tab: Wipe Schedule ----
const COMMON_TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

function syncWipeFormVisibility() {
  const frequency = $("#wipe-setting-frequency").value;
  $("#wipe-setting-anchor-wrap").hidden = frequency !== "biweekly";
  const tzSelect = $("#wipe-setting-timezone").value;
  $("#wipe-setting-timezone-other-wrap").hidden = tzSelect !== "other";
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
    if (COMMON_TIMEZONES.includes(tz)) {
      $("#wipe-setting-timezone").value = tz;
    } else {
      $("#wipe-setting-timezone").value = "other";
      $("#wipe-setting-timezone-other").value = tz;
    }
    $("#wipe-setting-anchor").value = data.wipe_anchor_date || "";
    syncWipeFormVisibility();
    $("#wipe-setting-frequency")._syncCustomSelectTrigger && $("#wipe-setting-frequency")._syncCustomSelectTrigger();
    $("#wipe-setting-timezone")._syncCustomSelectTrigger && $("#wipe-setting-timezone")._syncCustomSelectTrigger();
  } catch (err) {
    // form just keeps its defaults - Save will surface any real problem
  }
}
loadWipeSettingsForm();

$("#wipe-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const wipe_frequency = $("#wipe-setting-frequency").value;
  const wipe_time = $("#wipe-setting-time").value;
  const tzSelect = $("#wipe-setting-timezone").value;
  const wipe_timezone = tzSelect === "other" ? $("#wipe-setting-timezone-other").value.trim() : tzSelect;
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

// ---- Settings tab: Plugin Deploy ----
async function loadPluginDeploySettings() {
  try {
    const data = await fetch("/api/settings/plugin-deploy").then((res) => res.json());
    $("#plugin-deploy-setting-host").value = data.plugin_deploy_host || "";
    $("#plugin-deploy-setting-username").value = data.plugin_deploy_username || "";
    $("#plugin-deploy-setting-path").value = data.plugin_deploy_path || "";
  } catch (err) {
    // fields stay blank - Save will surface any real problem
  }
}
loadPluginDeploySettings();

$("#plugin-deploy-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const plugin_deploy_host = $("#plugin-deploy-setting-host").value.trim();
  const plugin_deploy_username = $("#plugin-deploy-setting-username").value.trim();
  const plugin_deploy_path = $("#plugin-deploy-setting-path").value.trim();
  if (!plugin_deploy_host || !plugin_deploy_username || !plugin_deploy_path) {
    alert("Host, username, and path are all required.");
    return;
  }
  const data = await postJson("/api/settings/plugin-deploy", { plugin_deploy_host, plugin_deploy_username, plugin_deploy_path });
  alert(data.error ? "Error: " + data.error : "Saved.");
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

let mapWorldSize = null;
let mapPollTimer = null;

async function loadMapImage() {
  const status = $("#map-status");
  const img = $("#map-image");
  status.textContent = "Loading map...";
  try {
    const res = await fetch("/api/map/image");
    const data = await res.json();
    mapWorldSize = Number(data.size) || null;
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

function mapPosition(x, z) {
  if (!mapWorldSize || x == null || z == null) return null;
  return {
    left: ((x + mapWorldSize / 2) / mapWorldSize) * 100,
    top: (1 - (z + mapWorldSize / 2) / mapWorldSize) * 100,
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
  el.className = "map-player-marker";
  el.style.left = pos.left + "%";
  el.style.top = pos.top + "%";
  el.title = p.name;
  const avatarHtml = p.avatar
    ? `<img class="map-player-avatar" src="${escapeHtml(p.avatar)}" alt="">`
    : '<div class="map-player-avatar map-player-avatar-blank"></div>';
  el.innerHTML = `${avatarHtml}<span class="map-player-name">${escapeHtml(p.name)}</span>`;
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
    (data.players || []).forEach((p) => {
      const el = playerMapMarker(p);
      if (el) overlay.appendChild(el);
    });
    (data.events || []).forEach((e) => {
      const slug = EVENT_LABEL_SLUGS[e.label] || "";
      const el = mapMarker(e.x, e.z, `map-marker map-marker-event map-dot-${slug}`, e.label);
      if (el) overlay.appendChild(el);
    });
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

// ---- Live Map: drag to pan ----
// The viewport (.map-wrap) is a plain scrollable box around the oversized
// .map-canvas - dragging just converts mouse movement into scrollLeft/Top
// changes, the same trick as any "click-and-drag to pan" widget.
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

// ---- AMAP Scripts ----
// No password gate here - Critical actions already require typing the
// action's exact name into the confirmation modal before they'll run,
// which is the real protection against a stray click. The backend's own
// fixed action whitelist is what stops anything other than these specific
// scripts from ever being reachable at all.
let amapActions = [];

async function loadAmapCards() {
  try {
    const data = await fetch("/api/amap/actions").then((res) => res.json());
    amapActions = data.actions || [];
    renderAmapCards();
  } catch (err) {
    $("#amap-cards").innerHTML = `<p class="muted">Error loading actions: ${escapeHtml(err.message)}</p>`;
  }
}
loadAmapCards();

function renderAmapCards() {
  const box = $("#amap-cards");
  // Upload Plugin is a static card (its own upload logic, not a generic
  // RCON action) living in this same grid - detach it before wiping the
  // dynamic ones, then re-append the *same* node so its already-bound
  // event listeners and custom-select wrapper survive the rebuild.
  const uploadCard = $("#amap-upload-card");
  box.innerHTML = "";
  amapActions.forEach((a) => {
    const isCritical = a.category === "critical";
    const card = document.createElement("div");
    card.className = "amap-card amap-card-" + a.category;

    const fieldsHtml = (a.fields || [])
      .map((f) => `<input type="text" data-field="${escapeHtml(f.key)}" placeholder="${escapeHtml(f.placeholder || f.label)}">`)
      .join("");
    // Wipe Configurator only - lets you check what's currently saved for
    // the next wipe before deciding whether to overwrite it.
    const viewButtonHtml = a.key === "wipe_configure"
      ? '<button type="button" class="btn btn-outline btn-small" data-view-wipe-config>View Current Config</button>'
      : "";

    card.innerHTML = `
      <div class="amap-card-header">
        <span class="amap-card-title">${escapeHtml(a.label)}</span>
        <span class="amap-tag amap-tag-${a.category}">${isCritical ? "Critical" : "Noncritical"}</span>
      </div>
      <p class="amap-card-desc">${escapeHtml(a.description || "")}</p>
      ${fieldsHtml ? `<div class="amap-card-fields">${fieldsHtml}</div>` : ""}
      ${viewButtonHtml}
      <button type="button" class="btn btn-small ${isCritical ? "btn-danger" : "btn-outline"}">Run</button>
    `;
    card.querySelector("button:not([data-view-wipe-config])").addEventListener("click", () => runAmapAction(a, card));
    const viewBtn = card.querySelector("[data-view-wipe-config]");
    if (viewBtn) viewBtn.addEventListener("click", viewWipeConfig);
    box.appendChild(card);
  });
  if (uploadCard) box.appendChild(uploadCard);
}

async function viewWipeConfig() {
  amapLog("Checking current wipe config...");
  try {
    const data = await fetch("/api/amap/wipe-config").then((res) => res.json());
    amapLog(data.error ? `View Current Config: Error - ${data.error}` : `Current wipe config:\n${data.response}`);
  } catch (err) {
    amapLog(`View Current Config: Error - ${err.message}`);
  }
}

function amapLog(line) {
  const box = $("#amap-result-log");
  const row = document.createElement("div");
  row.className = "console-line";
  row.textContent = `[${nowTimestamp()}] ${line}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ---- AMAP: Upload Plugin ----
async function loadInstalledPlugins() {
  try {
    const data = await fetch("/api/amap/plugins").then((res) => res.json());
    const select = $("#amap-installed-plugins");
    select.innerHTML = (data.plugins || [])
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join("") || '<option value="">(none found)</option>';
    select._syncCustomSelectTrigger && select._syncCustomSelectTrigger();
  } catch (err) {
    // dropdown just stays empty - it's informational only
  }
}
loadInstalledPlugins();

$("#amap-plugin-upload").addEventListener("click", async () => {
  const fileInput = $("#amap-plugin-file");
  const file = fileInput.files[0];
  if (!file) {
    alert("Choose a .cs file first.");
    return;
  }
  const confirmed = await showConfirmModal({
    title: "Upload Plugin",
    message: `Upload "${file.name}" to the configured oxide/plugins folder? This will overwrite an existing file with the same name.`,
    confirmLabel: "Upload",
  });
  if (!confirmed) return;

  amapLog(`Upload Plugin: sending ${file.name}...`);
  try {
    const formData = new FormData();
    formData.append("plugin", file);
    const res = await fetch("/api/amap/upload-plugin", { method: "POST", body: formData });
    const data = await res.json();
    if (data.error) {
      amapLog(`Upload Plugin: Error - ${data.error}`);
      return;
    }
    amapLog(`Upload Plugin: ${data.message}`);
    if (data.added_permissions && data.added_permissions.length) {
      amapLog(`Upload Plugin: added new permissions - ${data.added_permissions.join(", ")}`);
    }
    fileInput.value = "";
    loadInstalledPlugins();
    loadPermissionsCatalog();
  } catch (err) {
    amapLog(`Upload Plugin: Error - ${err.message}`);
  }
});

// ---- Terminal ----
// The dashboard's only WebSocket feature - everything else above is plain
// HTTP polling. One xterm.js instance is created lazily on first Connect and
// reused across reconnects; ws_terminal on the backend (app/ssh_ws.py) backs
// it with a real paramiko SSH session, one per WebSocket connection.
let terminalWs = null;
let terminalTerm = null;
let terminalFit = null;
let terminalConnected = false;

function terminalWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/terminal`;
}

function ensureTerminal() {
  if (terminalTerm) return;
  terminalTerm = new Terminal({
    cursorBlink: true,
    fontFamily: "'Consolas', 'Courier New', monospace",
    fontSize: 14,
    theme: {
      background: "#000000",
      foreground: "#39ff14",
      cursor: "#39ff14",
      selectionBackground: "rgba(57, 255, 20, .3)",
    },
  });
  terminalFit = new FitAddon.FitAddon();
  terminalTerm.loadAddon(terminalFit);
  terminalTerm.open($("#terminal-container"));
  terminalTerm.onData((data) => {
    if (terminalWs && terminalConnected) {
      terminalWs.send(JSON.stringify({ type: "data", data }));
    }
  });
}

function fitTerminal() {
  if (!terminalTerm || !terminalFit) return;
  terminalFit.fit();
  if (terminalWs && terminalConnected) {
    terminalWs.send(JSON.stringify({ type: "resize", cols: terminalTerm.cols, rows: terminalTerm.rows }));
  }
}

function setTerminalStatus(text) {
  $("#terminal-status").textContent = text;
}

function showTerminalConnectedUi(connected) {
  $("#terminal-connect-form").hidden = connected;
  $("#terminal-wrap").hidden = !connected;
}

$("#terminal-connect-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const host = $("#terminal-host").value.trim();
  const port = parseInt($("#terminal-port").value, 10) || 22;
  const username = $("#terminal-username").value.trim();
  const password = $("#terminal-password").value;
  if (!host || !username) return;

  showTerminalConnectedUi(true);
  ensureTerminal();
  terminalTerm.reset();
  setTerminalStatus("Connecting...");
  terminalConnected = false;

  terminalWs = new WebSocket(terminalWsUrl());
  terminalWs.onopen = () => {
    terminalFit.fit();
    terminalWs.send(JSON.stringify({
      type: "connect", host, port, username, password,
      cols: terminalTerm.cols, rows: terminalTerm.rows,
    }));
  };
  terminalWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "data") {
      terminalTerm.write(msg.data);
    } else if (msg.type === "status" && msg.state === "connected") {
      terminalConnected = true;
      setTerminalStatus("Connected");
    } else if (msg.type === "status" && (msg.state === "error" || msg.state === "closed")) {
      terminalConnected = false;
      setTerminalStatus(msg.state === "error" ? `Error: ${msg.message}` : "Not connected");
      const color = msg.state === "error" ? "31" : "33";
      terminalTerm.writeln(`\r\n\x1b[${color}m[${msg.message || "Connection closed."}]\x1b[0m`);
      terminalWs.close();
      showTerminalConnectedUi(false);
    }
  };
  terminalWs.onclose = () => {
    if (terminalConnected) {
      terminalConnected = false;
      setTerminalStatus("Not connected");
      showTerminalConnectedUi(false);
    }
  };

  $("#terminal-password").value = "";
});

$("#terminal-disconnect").addEventListener("click", () => {
  if (terminalWs) terminalWs.close();
  terminalConnected = false;
  setTerminalStatus("Not connected");
  showTerminalConnectedUi(false);
});

window.addEventListener("resize", () => {
  if ($("#tab-terminal").classList.contains("active")) fitTerminal();
});

async function runAmapAction(a, card) {
  const fields = {};
  for (const f of a.fields || []) {
    const input = card.querySelector(`[data-field="${f.key}"]`);
    const value = (input.value || "").trim();
    if (!value) {
      alert(`Please fill in ${f.label}.`);
      return;
    }
    fields[f.key] = value;
  }

  const isCritical = a.category === "critical";
  const confirmed = await showConfirmModal({
    title: a.label,
    message: a.confirm || `Run ${a.label}?`,
    requiredText: isCritical ? a.label : null,
    confirmLabel: isCritical ? "Run (Critical)" : "Run",
    confirmClass: isCritical ? "btn-danger" : "btn-primary",
  });
  if (!confirmed) {
    amapLog(`${a.label}: cancelled.`);
    return;
  }
  // Critical actions (Updater, Nightly Restart, Map/Full Wipe) intentionally
  // stop the server - that expected disconnect shouldn't trigger the
  // "RCON connection lost" toast with its (wrong, in this case) suggestion
  // to check config.json. Resetting to null means the next status poll
  // can't see it as a transition; it picks back up once reconnected.
  if (isCritical) wasConnected = null;
  amapLog(`${a.label}: sending...`);
  try {
    const data = await postJson("/api/amap/run", { action: a.key, fields });
    amapLog(data.error ? `${a.label}: Error - ${data.error}` : `${a.label}: ${data.response}`);
  } catch (err) {
    amapLog(`${a.label}: Error - ${err.message}`);
  }
}

// Runs last so every .custom-select's <option>s (including the Theme
// preset dropdown, populated synchronously above) already exist.
$all(".custom-select").forEach(initCustomSelect);
