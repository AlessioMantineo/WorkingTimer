const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const baseUrl = "http://127.0.0.1:4173";
const testEmail = `test_${Date.now()}@example.com`;
const testPassword = "Secret123";
const jwtSecret = crypto.randomBytes(48).toString("hex");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCookie(setCookieHeader, cookieName) {
  if (!setCookieHeader) return "";
  const items = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const item of items) {
    const firstPart = String(item).split(";")[0];
    if (firstPart.startsWith(`${cookieName}=`)) return firstPart;
  }
  return "";
}

function appendCookie(cookieJar, newCookie) {
  if (!newCookie) return cookieJar;
  const [name] = newCookie.split("=");
  const parts = cookieJar
    .split("; ")
    .filter(Boolean)
    .filter((part) => !part.startsWith(`${name}=`));
  parts.push(newCookie);
  return parts.join("; ");
}

async function waitForServer(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await sleep(250);
  }
  return false;
}

async function request(path, method, body, cookies, csrfToken) {
  const headers = { "Content-Type": "application/json", Origin: baseUrl };
  if (cookies) headers.Cookie = cookies;
  if (csrfToken && method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  const setCookie = response.headers.get("set-cookie") || "";
  return { status: response.status, payload, setCookie };
}

async function run() {
  const server = spawn("node", ["server.js"], {
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "development",
      JWT_SECRET: jwtSecret,
      APP_ORIGIN: baseUrl,
    },
  });

  try {
    const up = await waitForServer();
    if (!up) throw new Error("Server non raggiungibile");

    let cookieJar = "";

    const csrf = await request("/api/auth/csrf", "GET", null, cookieJar);
    if (csrf.status !== 200 || !csrf.payload.token) {
      throw new Error(`CSRF init fallita: ${JSON.stringify(csrf.payload)}`);
    }
    cookieJar = appendCookie(cookieJar, extractCookie(csrf.setCookie, "apptest_csrf"));

    const register = await request(
      "/api/auth/register",
      "POST",
      {
        name: "Test User",
        email: testEmail,
        password: testPassword,
      },
      cookieJar,
      csrf.payload.token
    );
    if (register.status !== 201) {
      throw new Error(`Register fallita: ${JSON.stringify(register.payload)}`);
    }
    cookieJar = appendCookie(cookieJar, extractCookie(register.setCookie, "apptest_session"));

    const me = await request("/api/auth/me", "GET", null, cookieJar);
    if (me.status !== 200 || me.payload.user?.email !== testEmail) {
      throw new Error(`Me fallita: ${JSON.stringify(me.payload)}`);
    }

    const startTimer = await request("/api/timer/start", "POST", null, cookieJar, csrf.payload.token);
    if (startTimer.status !== 201) {
      throw new Error(`Start timer fallito: ${JSON.stringify(startTimer.payload)}`);
    }

    await sleep(1100);

    const stopTimer = await request("/api/timer/stop", "POST", null, cookieJar, csrf.payload.token);
    if (stopTimer.status !== 200 || !stopTimer.payload.entry?.endAt) {
      throw new Error(`Stop timer fallito: ${JSON.stringify(stopTimer.payload)}`);
    }

    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - 7);
    const to = new Date(now);
    to.setDate(now.getDate() + 7);
    const entries = await request(
      `/api/timer/entries?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(
        to.toISOString()
      )}`,
      "GET",
      null,
      cookieJar
    );
    if (entries.status !== 200 || !Array.isArray(entries.payload.entries) || entries.payload.entries.length < 1) {
      throw new Error(`Lista entries fallita: ${JSON.stringify(entries.payload)}`);
    }

    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const mondayDay = monday.toISOString().slice(0, 10);

    const adjustment = await request(
      `/api/timer/day-adjustments/${mondayDay}`,
      "PUT",
      { dayType: "smart", permissionMinutes: 30 },
      cookieJar,
      csrf.payload.token
    );
    if (adjustment.status !== 200 || adjustment.payload.adjustment?.dayType !== "smart") {
      throw new Error(`Save adjustment fallita: ${JSON.stringify(adjustment.payload)}`);
    }

    const adjustmentList = await request(
      `/api/timer/day-adjustments?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(
        to.toISOString()
      )}`,
      "GET",
      null,
      cookieJar
    );
    if (adjustmentList.status !== 200 || !Array.isArray(adjustmentList.payload.adjustments)) {
      throw new Error(`Lista adjustment fallita: ${JSON.stringify(adjustmentList.payload)}`);
    }

    const resetDay = await request(
      `/api/timer/day/${mondayDay}`,
      "DELETE",
      null,
      cookieJar,
      csrf.payload.token
    );
    if (resetDay.status !== 200) {
      throw new Error(`Reset giorno fallito: ${JSON.stringify(resetDay.payload)}`);
    }

    const created = await request(
      "/api/timer/entries",
      "POST",
      {
        startAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      cookieJar,
      csrf.payload.token
    );
    if (created.status !== 201 || !created.payload.entry?.id) {
      throw new Error(`Create manuale fallito: ${JSON.stringify(created.payload)}`);
    }

    const edited = await request(
      `/api/timer/entries/${created.payload.entry.id}`,
      "PUT",
      {
        startAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      cookieJar,
      csrf.payload.token
    );
    if (edited.status !== 200 || !edited.payload.entry?.id) {
      throw new Error(`Edit manuale fallito: ${JSON.stringify(edited.payload)}`);
    }

    const logout = await request("/api/auth/logout", "POST", null, cookieJar, csrf.payload.token);
    if (logout.status !== 200) {
      throw new Error(`Logout fallita: ${JSON.stringify(logout.payload)}`);
    }

    console.log("Smoke test OK");
  } finally {
    server.kill();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
