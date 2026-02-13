const WEEK_TARGET_MINUTES = 38 * 60;
const DAILY_MINIMUM_MINUTES = 4 * 60;
const DAILY_TARGET_BY_WEEKDAY = {
  1: 8 * 60,
  2: 8 * 60,
  3: 8 * 60,
  4: 8 * 60,
  5: 6 * 60,
};
const DAY_NAMES = ["Domenica", "Lunedi", "Martedi", "Mercoledi", "Giovedi", "Venerdi", "Sabato"];
const DAY_TYPE_OPTIONS = [
  { value: "none", label: "Normale" },
  { value: "smart", label: "Smart" },
  { value: "ferie", label: "Ferie" },
  { value: "festa", label: "Festa" },
];

const tabs = document.querySelectorAll(".tab");
const authForm = document.getElementById("authForm");
const nameField = document.getElementById("nameField");
const nameInput = document.getElementById("name");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const submitBtn = document.getElementById("submitBtn");
const formMessage = document.getElementById("formMessage");
const authCard = document.getElementById("authCard");
const appPanel = document.getElementById("appPanel");
const welcomeTitle = document.getElementById("welcomeTitle");
const welcomeText = document.getElementById("welcomeText");
const logoutBtn = document.getElementById("logoutBtn");

const openWorkingTimerBtn = document.getElementById("openWorkingTimerBtn");
const workingTimerModule = document.getElementById("workingTimerModule");
const timerStatusText = document.getElementById("timerStatusText");
const liveTimerValue = document.getElementById("liveTimerValue");
const startWorkBtn = document.getElementById("startWorkBtn");
const stopWorkBtn = document.getElementById("stopWorkBtn");
const prevWeekBtn = document.getElementById("prevWeekBtn");
const currentWeekBtn = document.getElementById("currentWeekBtn");
const nextWeekBtn = document.getElementById("nextWeekBtn");
const weekRangeLabel = document.getElementById("weekRangeLabel");
const weeklyTargetStat = document.getElementById("weeklyTargetStat");
const workedStat = document.getElementById("workedStat");
const remainingStat = document.getElementById("remainingStat");
const minimumStat = document.getElementById("minimumStat");
const weekDaysContainer = document.getElementById("weekDaysContainer");

let mode = "login";
let csrfToken = "";
let currentUser = null;
let activeEntry = null;
let ticker = null;
let currentWeekStart = startOfWeek(new Date());

function pad(value) {
  return String(value).padStart(2, "0");
}

function toDateOnly(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toInputDateTime(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function localInputToIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function addDays(date, amount) {
  const d = new Date(date);
  d.setDate(d.getDate() + amount);
  return d;
}

function sameDate(a, b) {
  return toDateOnly(a) === toDateOnly(b);
}

function formatDuration(minutes) {
  const value = Math.max(0, Math.round(minutes));
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return `${hours}h ${pad(mins)}m`;
}

function formatClockFromMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

function isStrongPassword(password) {
  return (
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password)
  );
}

function setMode(nextMode) {
  mode = nextMode;
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  const isRegister = mode === "register";
  nameField.classList.toggle("hidden", !isRegister);
  nameInput.toggleAttribute("required", isRegister);
  passwordInput.setAttribute("autocomplete", isRegister ? "new-password" : "current-password");
  submitBtn.textContent = isRegister ? "Crea account" : "Entra";
  formMessage.textContent = "";
  formMessage.className = "form-message";
}

function showMessage(message, type = "info") {
  formMessage.textContent = message;
  formMessage.className = `form-message ${type}`;
}

function showApp(user) {
  currentUser = user;
  welcomeTitle.textContent = `Ciao ${user?.name || "utente"}!`;
  welcomeText.textContent = `Sessione attiva come ${user?.email || "-"}.`;
  authCard.classList.add("hidden");
  appPanel.classList.remove("hidden");
  openWorkingTimerBtn.classList.add("active");
  workingTimerModule.classList.remove("hidden");
}

function showAuth() {
  authCard.classList.remove("hidden");
  appPanel.classList.add("hidden");
  stopTicker();
}

async function authRequest(path, method, body) {
  const headers = { "Content-Type": "application/json" };
  const upperMethod = method.toUpperCase();
  if (upperMethod !== "GET" && upperMethod !== "HEAD" && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) throw new Error(payload.error || "Richiesta fallita.");
  return payload;
}

async function refreshCsrfToken() {
  const response = await fetch("/api/auth/csrf", {
    method: "GET",
    credentials: "include",
  });
  const payload = await response.json();
  csrfToken = payload.token || "";
}

async function secureRequest(path, method, body) {
  if (!csrfToken) await refreshCsrfToken();

  try {
    return await authRequest(path, method, body);
  } catch (error) {
    if (String(error.message).includes("CSRF")) {
      await refreshCsrfToken();
      return authRequest(path, method, body);
    }
    throw error;
  }
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!activeEntry?.startAt) {
      liveTimerValue.textContent = "00:00:00";
      return;
    }
    const elapsed = Date.now() - new Date(activeEntry.startAt).getTime();
    liveTimerValue.textContent = formatClockFromMs(elapsed);
  }, 1000);
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function updateLivePanel() {
  if (activeEntry?.startAt) {
    timerStatusText.textContent = "Sei al lavoro";
    startWorkBtn.disabled = true;
    stopWorkBtn.disabled = false;
    const elapsed = Date.now() - new Date(activeEntry.startAt).getTime();
    liveTimerValue.textContent = formatClockFromMs(elapsed);
    startTicker();
  } else {
    timerStatusText.textContent = "Fuori dal lavoro";
    liveTimerValue.textContent = "00:00:00";
    startWorkBtn.disabled = false;
    stopWorkBtn.disabled = true;
    stopTicker();
  }
}

function buildBusinessDays() {
  return [0, 1, 2, 3, 4].map((offset) => addDays(currentWeekStart, offset));
}

function updateWeekHeader() {
  const from = currentWeekStart;
  const to = addDays(currentWeekStart, 4);
  weekRangeLabel.textContent = `${toDateOnly(from)} - ${toDateOnly(to)} (lun-ven)`;
}

function groupEntriesByLocalDate(entries) {
  const grouped = {};
  for (const entry of entries) {
    const key = toDateOnly(new Date(entry.startAt));
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }
  Object.values(grouped).forEach((rows) => {
    rows.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  });
  return grouped;
}

function indexAdjustmentsByDate(adjustments) {
  const map = {};
  for (const row of adjustments) {
    map[row.dayDate] = row;
  }
  return map;
}

async function fetchActiveStatus() {
  const payload = await authRequest("/api/timer/status", "GET");
  activeEntry = payload.activeEntry;
  updateLivePanel();
}

async function saveEntryEdit(entryId, startValue, endValue) {
  const startAt = localInputToIso(startValue);
  const endAt = localInputToIso(endValue);
  if (!startAt || !endAt) throw new Error("Compila ingresso e uscita con un valore valido.");

  await secureRequest(`/api/timer/entries/${entryId}`, "PUT", { startAt, endAt });
}

async function createManualEntry(dayDate, fallbackHours) {
  const start = new Date(dayDate);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(start.getHours() + fallbackHours, 0, 0, 0);

  await secureRequest("/api/timer/entries", "POST", {
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  });
}

async function saveDayAdjustment(dayDate, dayType, permissionHours, permissionMinutes) {
  const hours = Number(permissionHours || 0);
  const mins = Number(permissionMinutes || 0);
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) {
    throw new Error("Permessi non validi.");
  }
  if (hours < 0 || mins < 0 || mins > 59) {
    throw new Error("Permessi non validi.");
  }
  const totalMinutes = hours * 60 + mins;

  await secureRequest(`/api/timer/day-adjustments/${dayDate}`, "PUT", {
    dayType,
    permissionMinutes: totalMinutes,
  });
}

async function resetDay(dayDate) {
  await secureRequest(`/api/timer/day/${dayDate}`, "DELETE");
}

function entryRowTemplate(entry) {
  return `
    <div class="entry-row" data-entry-id="${entry.id}">
      <label>
        <span>Ingresso</span>
        <input type="datetime-local" class="entry-start" value="${toInputDateTime(entry.startAt)}" />
      </label>
      <label>
        <span>Uscita</span>
        <input type="datetime-local" class="entry-end" value="${entry.endAt ? toInputDateTime(entry.endAt) : ""}" />
      </label>
      <button class="ghost-btn mini save-entry-btn" data-entry-id="${entry.id}">Salva orari</button>
    </div>
  `;
}

function dayTypeSelectTemplate(selected) {
  return `
    <select class="day-type-select">
      ${DAY_TYPE_OPTIONS.map(
        (opt) => `<option value="${opt.value}" ${opt.value === selected ? "selected" : ""}>${opt.label}</option>`
      ).join("")}
    </select>
  `;
}

async function renderWeek() {
  const weekDays = buildBusinessDays();
  updateWeekHeader();

  const fromIso = weekDays[0].toISOString();
  const toIso = addDays(weekDays[0], 5).toISOString();

  const [entriesPayload, adjustmentsPayload] = await Promise.all([
    authRequest(`/api/timer/entries?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, "GET"),
    authRequest(
      `/api/timer/day-adjustments?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      "GET"
    ),
  ]);

  const entries = entriesPayload.entries || [];
  const adjustments = adjustmentsPayload.adjustments || [];
  const groupedEntries = groupEntriesByLocalDate(entries);
  const adjustmentsByDate = indexAdjustmentsByDate(adjustments);

  const dayModels = weekDays.map((dayDate) => {
    const dateKey = toDateOnly(dayDate);
    const weekday = dayDate.getDay();
    const plannedMinutes = DAILY_TARGET_BY_WEEKDAY[weekday] || 0;
    const dayEntries = groupedEntries[dateKey] || [];
    const workedMinutes = dayEntries.reduce((sum, e) => sum + (e.durationMinutes || 0), 0);
    const adjustment = adjustmentsByDate[dateKey] || {
      dayType: "none",
      permissionMinutes: 0,
    };

    const extraDayTypeCredit = adjustment.dayType === "none" ? 0 : plannedMinutes;
    const effectiveMinutes = workedMinutes + adjustment.permissionMinutes + extraDayTypeCredit;

    return {
      date: dayDate,
      dayDate: dateKey,
      weekday,
      plannedMinutes,
      entries: dayEntries,
      workedMinutes,
      adjustment,
      extraDayTypeCredit,
      effectiveMinutes,
    };
  });

  const today = new Date();

  const weekWorked = dayModels.reduce((sum, d) => sum + d.effectiveMinutes, 0);
  const underMinimumDays = dayModels.filter((d) => d.effectiveMinutes > 0 && d.effectiveMinutes < DAILY_MINIMUM_MINUTES)
    .length;

  weeklyTargetStat.textContent = formatDuration(WEEK_TARGET_MINUTES);
  workedStat.textContent = formatDuration(weekWorked);
  remainingStat.textContent = formatDuration(Math.max(0, WEEK_TARGET_MINUTES - weekWorked));
  minimumStat.textContent = String(underMinimumDays);

  weekDaysContainer.innerHTML = dayModels
    .map((day) => {
      const dayType = day.adjustment.dayType || "none";
      const permissionMinutes = day.adjustment.permissionMinutes || 0;
      const permissionHours = Math.floor(permissionMinutes / 60);
      const permissionOnlyMins = permissionMinutes % 60;
      const entriesHtml =
        day.entries.length > 0
          ? day.entries.map((entry) => entryRowTemplate(entry)).join("")
          : `<p class="muted-line">Nessuna registrazione</p>
             <button class="ghost-btn mini add-manual-btn" data-day="${day.dayDate}" data-fallback-hours="${
              day.weekday === 5 ? 6 : 8
            }">Aggiungi registrazione manuale</button>`;

      return `
        <article class="day-card ${sameDate(day.date, today) ? "today" : ""}">
          <header>
            <h4>${DAY_NAMES[day.weekday]}</h4>
            <p>${day.dayDate}</p>
          </header>
          <div class="day-meta">
            <span>Totale giorno: <strong>${formatDuration(day.effectiveMinutes)}</strong></span>
            <span>Target base: <strong>${formatDuration(day.plannedMinutes)}</strong></span>
          </div>
          <div class="day-meta">
            <span>Lavorate: <strong>${formatDuration(day.workedMinutes)}</strong></span>
            <span>Permessi: <strong>${formatDuration(permissionMinutes)}</strong></span>
          </div>
          <div class="day-controls" data-day="${day.dayDate}">
            <label class="compact-control">
              <span>Stato giorno</span>
              ${dayTypeSelectTemplate(dayType)}
            </label>
            <label class="compact-control">
              <span>Permessi ore</span>
              <input type="number" class="perm-hours" min="0" max="12" step="1" value="${permissionHours}" />
            </label>
            <label class="compact-control">
              <span>Permessi min</span>
              <input type="number" class="perm-mins" min="0" max="59" step="1" value="${permissionOnlyMins}" />
            </label>
            <button class="ghost-btn mini save-adjustment-btn" data-day="${day.dayDate}">Salva giorno</button>
            <button class="ghost-btn mini reset-day-btn" data-day="${day.dayDate}">Reset giorno</button>
          </div>
          <div class="entries-list">${entriesHtml}</div>
        </article>
      `;
    })
    .join("");

  weekDaysContainer.querySelectorAll(".save-entry-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const row = event.currentTarget.closest(".entry-row");
      const entryId = event.currentTarget.dataset.entryId;
      const startValue = row.querySelector(".entry-start").value;
      const endValue = row.querySelector(".entry-end").value;
      event.currentTarget.disabled = true;
      try {
        await saveEntryEdit(entryId, startValue, endValue);
        await renderWeek();
      } catch (error) {
        alert(error.message);
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  });

  weekDaysContainer.querySelectorAll(".add-manual-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const day = event.currentTarget.dataset.day;
      const fallbackHours = Number(event.currentTarget.dataset.fallbackHours || 8);
      event.currentTarget.disabled = true;
      try {
        await createManualEntry(new Date(`${day}T00:00:00`), fallbackHours);
        await renderWeek();
      } catch (error) {
        alert(error.message);
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  });

  weekDaysContainer.querySelectorAll(".save-adjustment-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const day = event.currentTarget.dataset.day;
      const card = event.currentTarget.closest(".day-controls");
      const dayType = card.querySelector(".day-type-select").value;
      const permissionHours = card.querySelector(".perm-hours").value;
      const permissionMins = card.querySelector(".perm-mins").value;
      event.currentTarget.disabled = true;
      try {
        await saveDayAdjustment(day, dayType, permissionHours, permissionMins);
        await renderWeek();
      } catch (error) {
        alert(error.message);
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  });

  weekDaysContainer.querySelectorAll(".reset-day-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const day = event.currentTarget.dataset.day;
      const confirmed = window.confirm(`Resettare completamente ${day}?`);
      if (!confirmed) return;

      event.currentTarget.disabled = true;
      try {
        await resetDay(day);
        await renderWeek();
      } catch (error) {
        alert(error.message);
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  });
}

async function refreshWorkingTimerUI() {
  await fetchActiveStatus();
  await renderWeek();
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    showMessage("Compila email e password.", "error");
    return;
  }
  if (mode === "register" && !isStrongPassword(password)) {
    showMessage("Password debole: minimo 8 caratteri con maiuscola, minuscola e numero.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = mode === "register" ? "Creo..." : "Accesso...";

  try {
    if (mode === "register" && !name) {
      showMessage("Inserisci il nome per registrarti.", "error");
      return;
    }

    const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const payload = await secureRequest(endpoint, "POST", { name, email, password });
    showMessage(payload.message || "Operazione completata.", "success");
    showApp(payload.user);
    await refreshWorkingTimerUI();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = mode === "register" ? "Crea account" : "Entra";
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await secureRequest("/api/auth/logout", "POST");
  } catch {
    // no-op
  }
  currentUser = null;
  activeEntry = null;
  showAuth();
  authForm.reset();
  setMode("login");
});

startWorkBtn.addEventListener("click", async () => {
  startWorkBtn.disabled = true;
  try {
    await secureRequest("/api/timer/start", "POST");
    await refreshWorkingTimerUI();
  } catch (error) {
    alert(error.message);
    startWorkBtn.disabled = false;
  }
});

stopWorkBtn.addEventListener("click", async () => {
  stopWorkBtn.disabled = true;
  try {
    await secureRequest("/api/timer/stop", "POST");
    await refreshWorkingTimerUI();
  } catch (error) {
    alert(error.message);
    stopWorkBtn.disabled = false;
  }
});

openWorkingTimerBtn.addEventListener("click", () => {
  openWorkingTimerBtn.classList.add("active");
  workingTimerModule.classList.remove("hidden");
});

prevWeekBtn.addEventListener("click", async () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  await renderWeek();
});

nextWeekBtn.addEventListener("click", async () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  await renderWeek();
});

currentWeekBtn.addEventListener("click", async () => {
  currentWeekStart = startOfWeek(new Date());
  await renderWeek();
});

window.addEventListener("DOMContentLoaded", async () => {
  setMode("login");

  try {
    await refreshCsrfToken();
    const payload = await authRequest("/api/auth/me", "GET");
    showApp(payload.user);
    await refreshWorkingTimerUI();
  } catch {
    showAuth();
  }
});
