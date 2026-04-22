const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const USER_DATA_FILE = path.join(DATA_DIR, "user-data.json");
const SESSION_COOKIE = "fitness_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const sessions = new Map();

app.use(express.json());

// ── Public landing page (no auth required) ──
app.get(["/home", "/home.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

// ── Root: redirect to home if not logged in, else app ──
app.get(["/", "/index.html"], (req, res, next) => {
  const user = getSession(req);
  if (!user) return res.redirect("/home");
  req.user = user;
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Login / register page ──
app.get(["/login", "/login.html"], (req, res) => {
  if (getSession(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.use(express.static("public", { index: false }));

app.get("/api/me", requireAuthApi, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/register", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || username).trim();
  const password = String(req.body.password || "");

  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Username must be 3-32 letters, numbers, dots, dashes, or underscores." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    const users = await readUsers();
    const exists = users.some(user => user.username.toLowerCase() === username.toLowerCase());

    if (exists) {
      return res.status(409).json({ error: "That username is already taken." });
    }

    const passwordRecord = await hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      username,
      displayName: displayName || username,
      password: passwordRecord,
      createdAt: new Date().toISOString()
    };

    users.push(user);
    await saveUsers(users);

    const publicUser = toPublicUser(user);
    createSession(res, publicUser);
    res.status(201).json({ user: publicUser });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Enter username and password." });
  }

  try {
    const users = await readUsers();
    const user = users.find(item => item.username.toLowerCase() === username.toLowerCase());
    const passwordOk = user ? await verifyPassword(password, user.password) : false;

    if (!user || !passwordOk) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const publicUser = toPublicUser(user);
    createSession(res, publicUser);
    res.json({ user: publicUser });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.post("/api/logout", requireAuthApi, (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/fitness-data", requireAuthApi, async (req, res) => {
  try {
    const userData = await readUserData(req.user.id);
    res.json(userData);
  } catch (err) {
    console.error("FITNESS DATA ERROR:", err);
    res.status(500).json({ error: "Could not load saved fitness data." });
  }
});

app.put("/api/profile", requireAuthApi, async (req, res) => {
  try {
    const profile = sanitizeProfile(req.body.profile);
    if (!profile) return res.status(400).json({ error: "Valid profile data is required." });
    const userData = await readUserData(req.user.id);
    userData.profile = profile;
    await saveUserData(req.user.id, userData);
    res.json({ profile });
  } catch (err) {
    console.error("PROFILE SAVE ERROR:", err);
    res.status(500).json({ error: "Could not save profile." });
  }
});

app.post("/api/task-plan", requireAuthApi, async (req, res) => {
  const profile = sanitizeProfile(req.body.profile);
  const trainingType = sanitizeTrainingType(req.body.trainingType);
  const days = clamp(Number.parseInt(req.body.days, 10) || 7, 1, 14);
  const notes = String(req.body.notes || "").trim().slice(0, 600);

  if (!API_KEY) return res.status(500).json({ error: "OPENROUTER_API_KEY is missing in .env." });

  try {
    const reply = await askAi([
      {
        role: "system",
        content: [
          "You are a practical fitness coach.",
          "Create safe day-by-day diet and exercise task plans.",
          "Return only valid JSON with this schema:",
          "{\"title\":\"string\",\"summary\":\"string\",\"days\":[{\"day\":1,\"diet\":\"string\",\"exercise\":\"string\",\"task\":\"string\"}]}",
          "Keep each field short and useful. Do not include markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: buildTaskPlanPrompt({ user: req.user, profile, trainingType, days, notes })
      }
    ]);

    const parsedPlan = parseTaskPlanReply(reply);
    const taskPlan = {
      id: crypto.randomUUID(),
      title: parsedPlan.title || `${labelTrainingType(trainingType)} task plan`,
      summary: parsedPlan.summary || "Daily diet and exercise tasks.",
      trainingType, daysRequested: days, notes,
      days: parsedPlan.days, planText: reply,
      createdAt: new Date().toISOString()
    };

    const userData = await readUserData(req.user.id);
    userData.profile = profile || userData.profile || null;
    userData.tasks = [taskPlan, ...userData.tasks].slice(0, 20);
    await saveUserData(req.user.id, userData);
    res.status(201).json({ task: taskPlan });
  } catch (err) {
    console.error("TASK PLAN ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || "Could not create task plan." });
  }
});

app.delete("/api/tasks/:taskId", requireAuthApi, async (req, res) => {
  try {
    const userData = await readUserData(req.user.id);
    const before = userData.tasks.length;
    userData.tasks = userData.tasks.filter(task => task.id !== req.params.taskId);
    if (userData.tasks.length === before) return res.status(404).json({ error: "Task plan not found." });
    await saveUserData(req.user.id, userData);
    res.json({ ok: true });
  } catch (err) {
    console.error("TASK DELETE ERROR:", err);
    res.status(500).json({ error: "Could not delete task plan." });
  }
});

app.post("/chat", requireAuthApi, async (req, res) => {
  const userMessage = String(req.body.message || "").trim();
  const profile = req.body.profile || null;
  if (!userMessage) return res.status(400).json({ error: "Please enter a question." });
  if (!API_KEY) return res.status(500).json({ error: "OPENROUTER_API_KEY is missing in .env." });

  try {
    const reply = await askAi([
      {
        role: "system",
        content: [
          "You are a practical fitness coach.",
          "Use the user's provided fitness profile when available.",
          "Keep answers clear, safe, and action-focused.",
          "Do not diagnose medical conditions. Suggest a qualified professional for medical concerns."
        ].join(" ")
      },
      { role: "user", content: buildCoachPrompt(userMessage, profile, req.user) }
    ]);
    res.json({ reply });
  } catch (err) {
    console.error("ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || "Server could not reach the AI service." });
  }
});

// ── Auth helpers ──
function requireAuthPage(req, res, next) {
  const user = getSession(req);
  if (!user) return res.redirect("/home");
  req.user = user;
  next();
}

function requireAuthApi(req, res, next) {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: "Login required." });
  req.user = user;
  next();
}

function getSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) { sessions.delete(token); return null; }
  return session.user;
}

function getSessionToken(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

function createSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// ── Data helpers ──
async function readUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
}

async function readUserData(userId) {
  const allData = await readAllUserData();
  return allData[userId] || { profile: null, tasks: [] };
}

async function saveUserData(userId, userData) {
  const allData = await readAllUserData();
  allData[userId] = {
    profile: userData.profile || null,
    tasks: Array.isArray(userData.tasks) ? userData.tasks : []
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USER_DATA_FILE, `${JSON.stringify(allData, null, 2)}\n`);
}

async function readAllUserData() {
  try {
    const data = await fs.readFile(USER_DATA_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function normalizeUsername(username) { return String(username || "").trim().toLowerCase(); }
function isValidUsername(username) { return /^[a-z0-9._-]{3,32}$/.test(username); }

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt);
  return `scrypt:${salt}:${hash}`;
}

async function verifyPassword(password, passwordRecord) {
  const [method, salt, savedHash] = String(passwordRecord || "").split(":");
  if (method !== "scrypt" || !salt || !savedHash) return false;
  const hash = await scrypt(password, salt);
  const savedBuffer = Buffer.from(savedHash, "hex");
  const hashBuffer = Buffer.from(hash, "hex");
  if (savedBuffer.length !== hashBuffer.length) return false;
  return crypto.timingSafeEqual(savedBuffer, hashBuffer);
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) { reject(err); return; }
      resolve(derivedKey.toString("hex"));
    });
  });
}

function toPublicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName || user.username };
}

function buildCoachPrompt(message, profile, user) {
  if (!profile) return `${user.displayName} asks: ${message}`;
  const safeProfile = {
    user: user.displayName, age: profile.age, sex: profile.sex,
    weightKg: profile.weight, heightCm: profile.height, activity: profile.activity,
    goal: profile.goal, diet: profile.diet, targetCalories: profile.calories,
    targetProteinG: profile.protein, workout: profile.workout, meals: profile.meals
  };
  return ["User fitness profile:", JSON.stringify(safeProfile, null, 2), "", `Question: ${message}`].join("\n");
}

function buildTaskPlanPrompt({ user, profile, trainingType, days, notes }) {
  const profileText = profile
    ? JSON.stringify(profile, null, 2)
    : "No saved body profile yet. Keep the plan general and ask the user to generate a profile for better targets.";
  return [
    `User: ${user.displayName}`, `Training type: ${labelTrainingType(trainingType)}`,
    `Number of days: ${days}`, `Notes: ${notes || "No extra notes."}`, "",
    "Fitness profile:", profileText, "",
    "Create a daily task planner with diet and exercise for each day.",
    "For gym plans, include sets and reps.",
    "For running plans, include time or distance and intensity.",
    "For mixed plans, combine running, gym, and recovery work."
  ].join("\n");
}

async function askAi(messages) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", messages })
  });
  let data = {};
  try { data = await response.json(); } catch (err) { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error?.message || "AI API error.");
    error.status = response.status;
    throw error;
  }
  return data.choices?.[0]?.message?.content || "No response from AI.";
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const age = Number(profile.age);
  const weight = Number(profile.weight);
  const height = Number(profile.height);
  if (!Number.isFinite(age) || !Number.isFinite(weight) || !Number.isFinite(height)) return null;
  return {
    age: clamp(Math.round(age), 10, 100),
    sex: pick(profile.sex, ["male", "female"], "male"),
    weight: clamp(Math.round(weight), 25, 250),
    height: clamp(Math.round(height), 100, 250),
    activity: pick(profile.activity, ["low", "moderate", "high"], "low"),
    goal: pick(profile.goal, ["fat_loss", "muscle_gain", "maintenance"], "fat_loss"),
    diet: pick(profile.diet, ["veg", "nonveg", "mixed"], "veg"),
    calories: clamp(Math.round(Number(profile.calories) || 0), 800, 7000),
    protein: clamp(Math.round(Number(profile.protein) || 0), 20, 400),
    workout: sanitizeStringArray(profile.workout),
    meals: sanitizeStringArray(profile.meals)
  };
}

function sanitizeStringArray(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => String(item || "").trim().slice(0, 120)).filter(Boolean).slice(0, 10);
}

function sanitizeTrainingType(type) { return pick(type, ["running", "gym", "home", "mixed"], "mixed"); }
function pick(value, allowed, fallback) {
  const text = String(value || "").trim().toLowerCase();
  return allowed.includes(text) ? text : fallback;
}
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function labelTrainingType(type) {
  const labels = { running: "Running", gym: "Gym", home: "Home workout", mixed: "Mixed training" };
  return labels[type] || labels.mixed;
}

function parseTaskPlanReply(reply) {
  const parsed = parseJsonFromText(reply);
  if (!parsed) return { title: "AI task plan", summary: "Saved AI response.", days: [] };
  return {
    title: String(parsed.title || "AI task plan").trim().slice(0, 80),
    summary: String(parsed.summary || "Daily diet and exercise tasks.").trim().slice(0, 280),
    days: Array.isArray(parsed.days) ? parsed.days.map(normalizeTaskDay).filter(Boolean).slice(0, 14) : []
  };
}

function parseJsonFromText(text) {
  const cleaned = String(text || "").trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (err) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (innerErr) { return null; }
  }
}

function normalizeTaskDay(day, index) {
  if (!day || typeof day !== "object") return null;
  return {
    day: clamp(Number.parseInt(day.day, 10) || index + 1, 1, 14),
    diet: String(day.diet || "").trim().slice(0, 500),
    exercise: String(day.exercise || "").trim().slice(0, 500),
    task: String(day.task || "").trim().slice(0, 500)
  };
}

startServer(PORT);

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`✅ FitAI Planner running on http://localhost:${port}`);
  });
  server.on("error", err => {
    if (err.code === "EADDRINUSE" && !process.env.PORT && port === 3000) {
      console.log("Port 3000 busy, trying 3001…");
      startServer(3001); return;
    }
    console.error("Server failed to start:", err.message);
    process.exit(1);
  });
}
