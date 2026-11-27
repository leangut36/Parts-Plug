"use strict";
// PartsPlug / EveryCar backend: vehicle catalog + VIN decode + garage + fitment search.
// Run locally: npm install && npm start (Node 20+).
// IMPORTANT: The x-user-id authentication below is a development stub only.
// Do not expose this API publicly until real authentication is implemented.
const express = require("express");
const Database = require("better-sqlite3");

const NHTSA = "https://vpic.nhtsa.dot.gov/api/vehicles";
const DAY = 86400000;
const db = new Database(process.env.DB_PATH || "partsplug.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS makes(name TEXT PRIMARY KEY, fetched_at INTEGER);
CREATE TABLE IF NOT EXISTS models(make TEXT, year INTEGER, model TEXT, PRIMARY KEY(make, year, model));
CREATE TABLE IF NOT EXISTS model_fetch(make TEXT, year INTEGER, fetched_at INTEGER, PRIMARY KEY(make, year));
CREATE TABLE IF NOT EXISTS vin_cache(vin TEXT PRIMARY KEY, specs TEXT, raw TEXT, warnings TEXT, fetched_at INTEGER);
CREATE TABLE IF NOT EXISTS garage(
  id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, vin TEXT, year INTEGER, make TEXT, model TEXT, trim TEXT,
  specs TEXT, is_primary INTEGER DEFAULT 0, created_at INTEGER, UNIQUE(user_id, vin));
CREATE TABLE IF NOT EXISTS listings(
  id INTEGER PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT NOT NULL, price_cents INTEGER NOT NULL,
  category TEXT, type TEXT, condition TEXT, universal INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS fitment(listing_id INTEGER, make TEXT, model TEXT, year_from INTEGER, year_to INTEGER, engine TEXT);
CREATE INDEX IF NOT EXISTS fit_idx ON fitment(make, model);
`);

/* ---------- helpers ---------- */
const KEEP_UPPER = new Set(["BMW", "GMC", "AMC", "MG"]);
const title = (s) => !s ? s : KEEP_UPPER.has(s.trim().toUpperCase()) ? s.trim().toUpperCase()
  : s.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const num = (x) => (x !== undefined && x !== null && x !== "" && !isNaN(+x)) ? +x : null;

async function nhtsa(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${NHTSA}/${path}${path.includes("?") ? "&" : "?"}format=json`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`NHTSA responded ${r.status}`);
    return (await r.json()).Results || [];
  } finally { clearTimeout(t); }
}

/* ---------- VIN ---------- */
const TR = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
const WT = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const validVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
function checkDigitOk(v) {
  let s = 0;
  for (let i = 0; i < 17; i++) s += (/\d/.test(v[i]) ? +v[i] : TR[v[i]]) * WT[i];
  const r = s % 11;
  return v[8] === (r === 10 ? "X" : String(r));
}
function normalize(j) {
  return {
    year: num(j.ModelYear), make: title(j.Make), model: j.Model || null, trim: j.Trim || j.Series || null,
    body: j.BodyClass || null, drive: j.DriveType || null, doors: num(j.Doors),
    engine: { displacement_l: num(j.DisplacementL), cylinders: num(j.EngineCylinders), hp: num(j.EngineHP),
      fuel: j.FuelTypePrimary || null, model: j.EngineModel || null, turbo: j.Turbo || null },
    transmission: { style: j.TransmissionStyle || null, speeds: num(j.TransmissionSpeeds) },
    plant_country: j.PlantCountry || null,
  };
}
async function decodeVin(vin) {
  const hit = db.prepare("SELECT * FROM vin_cache WHERE vin=?").get(vin);
  if (hit && Date.now() - hit.fetched_at < 90 * DAY)
    return { specs: JSON.parse(hit.specs), warnings: hit.warnings, cached: true };
  const j = (await nhtsa(`DecodeVinValues/${vin}`))[0];
  if (!j || !j.Make) { const e = new Error("VIN could not be decoded"); e.status = 422; e.detail = j && j.ErrorText; throw e; }
  const specs = normalize(j);
  db.prepare("INSERT OR REPLACE INTO vin_cache VALUES (?,?,?,?,?)")
    .run(vin, JSON.stringify(specs), JSON.stringify(j), j.ErrorText || "", Date.now());
  return { specs, warnings: j.ErrorText || "", cached: false };
}

/* ---------- vehicle catalog ---------- */
async function ensureMakes() {
  const last = db.prepare("SELECT MAX(fetched_at) t FROM makes").get().t;
  if (last && Date.now() - last < 30 * DAY) return;
  const seen = new Set();
  for (const t of ["car", "truck", "mpv"])
    for (const r of await nhtsa(`GetMakesForVehicleType/${t}`)) if (r.MakeName) seen.add(title(r.MakeName));
  const ins = db.prepare("INSERT OR REPLACE INTO makes VALUES (?,?)");
  db.transaction(() => seen.forEach((m) => ins.run(m, Date.now())))();
}
async function ensureModels(make, year) {
  const done = db.prepare("SELECT fetched_at t FROM model_fetch WHERE make=? AND year=?").get(make, year);
  if (done && Date.now() - done.t < 30 * DAY) return;
  const rows = await nhtsa(`GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}`);
  const ins = db.prepare("INSERT OR IGNORE INTO models VALUES (?,?,?)");
  db.transaction(() => {
    rows.forEach((r) => r.Model_Name && ins.run(make, year, r.Model_Name));
    db.prepare("INSERT OR REPLACE INTO model_fetch VALUES (?,?,?)").run(make, year, Date.now());
  })();
}

/* ---------- app ---------- */
const app = express();
app.use(express.json());
const wrap = (fn) => (req, res) => fn(req, res).catch((e) =>
  res.status(e.status || 502).json({ error: e.message, detail: e.detail }));

// !!! STUB AUTH: trusts a header. Replace with real auth (Clerk, Auth0, Supabase, JWT) before launch.
function auth(req, res, next) {
  const id = req.get("x-user-id");
  if (!id) return res.status(401).json({ error: "Sign in required" });
  req.userId = id; next();
}

app.get("/api/catalog/makes", wrap(async (req, res) => {
  await ensureMakes();
  res.json(db.prepare("SELECT name FROM makes ORDER BY name").all().map((r) => r.name));
}));
app.get("/api/catalog/models", wrap(async (req, res) => {
  const make = title(String(req.query.make || "")), year = num(req.query.year);
  if (!make || !year) return res.status(400).json({ error: "make and year are required" });
  await ensureModels(make, year);
  res.json(db.prepare("SELECT model FROM models WHERE make=? AND year=? ORDER BY model").all(make, year).map((r) => r.model));
}));

app.get("/api/vin/:vin", wrap(async (req, res) => {
  const vin = req.params.vin.toUpperCase();
  if (!validVin(vin)) return res.status(400).json({ error: "A VIN is 17 characters and never uses I, O or Q" });
  const out = await decodeVin(vin);
  res.json({ vin, check_digit_ok: checkDigitOk(vin), ...out });
}));

// Add a car: by VIN (exact specs) or by year/make/model (no VIN).
app.post("/api/garage", auth, wrap(async (req, res) => {
  const b = req.body || {};
  let row;
  if (b.vin) {
    const vin = String(b.vin).toUpperCase();
    if (!validVin(vin)) return res.status(400).json({ error: "Invalid VIN" });
    const { specs } = await decodeVin(vin);
    row = { vin, year: specs.year, make: specs.make, model: specs.model, trim: specs.trim, specs };
  } else if (b.year && b.make && b.model) {
    row = { vin: null, year: +b.year, make: title(b.make), model: String(b.model), trim: b.trim || null, specs: b.specs || {} };
  } else return res.status(400).json({ error: "Send a vin, or year + make + model" });
  const first = !db.prepare("SELECT 1 FROM garage WHERE user_id=?").get(req.userId);
  try {
    const r = db.prepare(`INSERT INTO garage(user_id,vin,year,make,model,trim,specs,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(req.userId, row.vin, row.year, row.make, row.model, row.trim, JSON.stringify(row.specs), first ? 1 : 0, Date.now());
    res.status(201).json({ id: r.lastInsertRowid, ...row });
  } catch (e) { res.status(409).json({ error: "That VIN is already in your garage" }); }
}));
app.get("/api/garage", auth, wrap(async (req, res) => {
  res.json(db.prepare("SELECT * FROM garage WHERE user_id=? ORDER BY is_primary DESC, id").all(req.userId)
    .map((g) => ({ ...g, specs: JSON.parse(g.specs || "{}") })));
}));
app.delete("/api/garage/:id", auth, wrap(async (req, res) => {
  db.prepare("DELETE FROM garage WHERE id=? AND user_id=?").run(req.params.id, req.userId);
  res.status(204).end();
}));

// Sell: fitment can be auto-filled from the seller's own garage car.
app.post("/api/listings", auth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !num(b.price_cents)) return res.status(400).json({ error: "title and price_cents are required" });
  let fit = Array.isArray(b.fitment) ? b.fitment : [];
  if (b.garage_id) {
    const g = db.prepare("SELECT * FROM garage WHERE id=? AND user_id=?").get(b.garage_id, req.userId);
    if (!g) return res.status(404).json({ error: "Garage car not found" });
    fit = [{ make: g.make, model: g.model, year_from: g.year, year_to: g.year }];
  }
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO listings(seller_id,title,price_cents,category,type,condition,universal,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.userId, b.title, +b.price_cents, b.category || null, b.type || null, b.condition || null, b.universal ? 1 : 0, Date.now());
    const ins = db.prepare("INSERT INTO fitment VALUES (?,?,?,?,?,?)");
    fit.forEach((f) => ins.run(r.lastInsertRowid, title(f.make), f.model, +f.year_from, +(f.year_to || f.year_from), f.engine || null));
    return r.lastInsertRowid;
  })();
  res.status(201).json({ id });
}));

// Shop: pass garage_id to get a `fits` flag per listing, and fits_only=1 to filter.
app.get("/api/parts", auth, wrap(async (req, res) => {
  const g = req.query.garage_id ? db.prepare("SELECT * FROM garage WHERE id=? AND user_id=?").get(req.query.garage_id, req.userId) : null;
  const fitSql = `(l.universal=1 OR EXISTS(SELECT 1 FROM fitment f WHERE f.listing_id=l.id AND lower(f.make)=lower(@make)
    AND instr(lower(@model), lower(f.model))>0 AND @year BETWEEN f.year_from AND f.year_to))`;
  const p = { make: g ? g.make : "", model: g ? g.model : "", year: g ? g.year : 0, q: `%${req.query.q || ""}%` };
  const rows = db.prepare(`SELECT l.*, ${g ? fitSql : "NULL"} AS fits FROM listings l WHERE l.title LIKE @q
    ${req.query.fits_only && g ? "AND " + fitSql : ""} ORDER BY l.id DESC LIMIT 100`).all(p);
  res.json(rows);
}));

const port = process.env.PORT || 3000;
// Bind to loopback only: this development API has no trusted authentication.
if (require.main === module) app.listen(port, "127.0.0.1", () => console.log(`PartsPlug development API at http://127.0.0.1:${port}`));
module.exports = { app, checkDigitOk, validVin, normalize };
