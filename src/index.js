// STT Data Collection Platform — Cloudflare Worker
// Plain-text passwords by design. Drive reads done directly from browser.
// Worker handles: auth, D1, Drive upload-session minting, Drive file moves.

const uuid = () => crypto.randomUUID();
const now  = () => new Date().toISOString();

// ── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
  const origin  = req.headers.get("Origin") || "";
  const allow   = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}
const json = (data, status, env, req) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, req) },
  });
const ok  = (env, req, data = {}) => json({ ok: true,  ...data }, 200, env, req);
const err = (env, req, code, msg) => json({ ok: false, error: msg }, code, env, req);

// ── Config ───────────────────────────────────────────────────────────────────
const getConfig     = async (env, key)          => (await env.DB.prepare("SELECT value FROM config WHERE key=?").bind(key).first())?.value ?? null;
const getConfigJSON = async (env, key, fallback) => { const v = await getConfig(env, key); if (v == null) return fallback; try { return JSON.parse(v); } catch { return v; } };
const setConfig     = async (env, key, value, actor) =>
  env.DB.prepare("UPDATE config SET value=?, updated_at=?, updated_by=? WHERE key=?").bind(value, now(), actor || null, key).run();
const isKilled = async (env, k) => (await getConfig(env, k)) === "true";

// ── Auth ─────────────────────────────────────────────────────────────────────
const RANK = { user: 0, admin: 1, superadmin: 2 };
const hasRole = (s, min) => s && RANK[s.acting_role] >= RANK[min];

async function createSession(env, userId, actingRole) {
  const token   = uuid() + uuid().replace(/-/g, "");
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token,user_id,acting_role,created_at,expires_at) VALUES (?,?,?,?,?)"
  ).bind(token, userId, actingRole, now(), expires).run();
  return token;
}
async function getSession(env, req) {
  const auth  = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.user_id, s.acting_role, s.expires_at, u.system_role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=?`
  ).bind(token).first();
  if (!row || row.status !== "active" || new Date(row.expires_at) < new Date()) return null;
  return row;
}

// ── Google Drive ──────────────────────────────────────────────────────────────
let _atCache = { token: null, exp: 0 };
async function getGAT(env) {
  if (_atCache.token && Date.now() < _atCache.exp - 60000) return _atCache.token;
  const [cid, csec, rtok] = await Promise.all([
    getConfig(env, "secret.google_client_id"),
    getConfig(env, "secret.google_client_secret"),
    getConfig(env, "secret.google_refresh_token"),
  ]);
  if (!cid || !csec || !rtok) throw new Error("Google credentials not configured");
  const res  = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed");
  _atCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

// Drive folder IDs are stored in config as drive_folder_<logical>
// set them from the dashboard: main, demo, deleted, rejected, trash
async function getFolderId(env, logical) {
  const id = await getConfig(env, `drive_folder_${logical}`);
  if (!id) throw new Error(`Drive folder not configured: ${logical}. Set drive_folder_${logical} in config.`);
  return id;
}

async function createUploadSession(env, logical, filename, mimeType) {
  const at       = await getGAT(env);
  const folderId = await getFolderId(env, logical);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${at}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": mimeType || "application/octet-stream",
      },
      body: JSON.stringify({ name: filename, parents: [folderId] }),
    }
  );
  const location = res.headers.get("Location");
  if (!location) throw new Error("Failed to create Drive upload session");
  return location;
}

async function moveDriveFile(env, fileId, toLogical) {
  if (!fileId) return;
  const at       = await getGAT(env);
  const toFolder = await getFolderId(env, toLogical);
  const meta     = await (await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
    { headers: { Authorization: `Bearer ${at}` } }
  )).json();
  const removeParents = (meta.parents || []).join(",");
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${toFolder}&removeParents=${removeParents}&fields=id`,
    { method: "PATCH", headers: { Authorization: `Bearer ${at}` } }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function audit(env, actorId, action, targetType, targetId, details) {
  await env.DB.prepare(
    "INSERT INTO audit_log (id,actor_id,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(uuid(), actorId, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null, now()).run();
}
async function notify(env, userId, type, title, body) {
  if ((await getConfig(env, "notifications_paused")) === "true") return;
  await env.DB.prepare(
    "INSERT INTO notifications (id,user_id,type,title,body,is_read,created_at) VALUES (?,?,?,?,?,0,?)"
  ).bind(uuid(), userId, type, title || null, body, now()).run();
}
async function comboElementNames(env, comboId) {
  const r = await env.DB.prepare(
    `SELECT e.name FROM combination_elements ce JOIN elements e ON e.id=ce.element_id
      WHERE ce.combination_id=? ORDER BY ce.position`
  ).bind(comboId).all();
  return r.results.map(x => x.name);
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env, req) });
    const url  = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");
    const seg  = path.split("/").filter(Boolean);
    const m    = req.method;
    try {
      // auth
      if (path === "/api/auth/register"       && m === "POST")   return authRegister(req, env);
      if (path === "/api/auth/login"          && m === "POST")   return authLogin(req, env);
      if (path === "/api/auth/logout"         && m === "POST")   return authLogout(req, env);
      if (path === "/api/auth/change-password"&& m === "POST")   return authChangePwd(req, env);
      if (path === "/api/setup/seed"          && m === "POST")   return setupSeed(req, env);
      // config
      if (path === "/api/config"              && m === "GET")    return cfgPublic(req, env);
      if (path === "/api/config/secrets-status"&&m === "GET")    return cfgSecretsStatus(req, env);
      if (seg[1]==="config" && seg[2]         && m === "PUT")    return cfgSet(req, env, decodeURIComponent(seg[2]));
      // integration keys
      if (path === "/api/integrations/assemblyai-key" && m==="GET") return integAssemblyAI(req, env);
      // elements
      if (path === "/api/elements"            && m === "GET")    return eleList(req, env);
      if (path === "/api/elements"            && m === "POST")   return eleCreate(req, env);
      if (seg[1]==="elements" && seg[2]       && m === "PATCH")  return elePatch(req, env, seg[2]);
      // combinations
      if (path === "/api/combinations"        && m === "GET")    return comboList(req, env);
      if (path === "/api/combinations"        && m === "POST")   return comboCreate(req, env);
      if (path === "/api/combinations/next"   && m === "GET")    return comboNext(req, env);
      if (seg[1]==="combinations"&&seg[2]&&seg[2]!=="next"&&m==="PATCH") return comboPatch(req, env, seg[2]);
      // recording
      if (path === "/api/contributions"       && m === "POST")   return contribCreate(req, env);
      if (seg[1]==="contributions"&&seg[3]==="upload-url"&&m==="POST") return contribUploadUrl(req, env, seg[2]);
      if (seg[1]==="contributions"&&seg[3]==="audio-done"&&m==="POST") return contribAudioDone(req, env, seg[2]);
      if (path === "/api/skips"               && m === "POST")   return skipLog(req, env);
      // transcription
      if (path === "/api/me/contributions/to-transcribe" && m==="GET") return toTranscribe(req, env);
      if (seg[1]==="contributions"&&seg[3]==="transcribe"&&m==="POST") return transcribe(req, env, seg[2]);
      // my contributions
      if (path === "/api/me/contributions"    && m === "GET")    return myContribs(req, env);
      if (seg[1]==="contributions"&&seg[2]&&seg.length===3&&m==="PUT") return editContrib(req, env, seg[2]);
      // reviews
      if (path === "/api/reviews/next"        && m === "GET")    return reviewNext(req, env);
      if (path === "/api/reviews"             && m === "POST")   return reviewSubmit(req, env);
      // notifications
      if (path === "/api/notifications"       && m === "GET")    return notifList(req, env);
      if (seg[1]==="notifications"&&seg[3]==="read"&&m==="POST") return notifRead(req, env, seg[2]);
      // progress
      if (path === "/api/me/progress"         && m === "GET")    return myProgress(req, env);
      // admin
      if (path === "/api/admin/users"         && m === "GET")    return adminUsers(req, env);
      if (path === "/api/admin/users"         && m === "POST")   return adminCreateUser(req, env);
      if (seg[1]==="admin"&&seg[2]==="users"&&seg[3]&&m==="GET")    return adminUserDetail(req, env, seg[3]);
      if (seg[1]==="admin"&&seg[2]==="users"&&seg[3]&&m==="DELETE") return adminDeleteUser(req, env, seg[3]);
      if (path === "/api/admin/distribution"  && m === "GET")    return adminDistrib(req, env);
      if (path === "/api/admin/flags"         && m === "GET")    return adminFlags(req, env);
      if (path === "/api/admin/notifications/broadcast"&&m==="POST") return adminBroadcast(req, env);
      if (path === "/api/admin/audit"         && m === "GET")    return adminAudit(req, env);
      if (path === "/api/admin/review-anomalies"&&m==="GET")     return adminAnomalies(req, env);
      if (path === "/api/admin/reviews"       && m === "DELETE") return adminDeleteReviews(req, env);
      if (path === "/api/admin/exports"       && m === "POST")   return adminExportCreate(req, env);
      if (seg[1]==="admin"&&seg[2]==="exports"&&seg[3]&&m==="GET") return adminExportGet(req, env, seg[3]);
      if (path === "/api/admin/demo/phases"   && m === "POST")   return adminDemoPhase(req, env);
      if (path === "/api/admin/demo/migrate"  && m === "POST")   return adminDemoMigrate(req, env);
      if (path === "/api/admin/demo/destroy"  && m === "POST")   return adminDemoDestroy(req, env);
      if (path === "/api/admin/departments"   && m === "GET")    return adminDepts(req, env);
      if (path === "/api/admin/departments"   && m === "POST")   return adminCreateDept(req, env);
      return err(env, req, 404, "Not found");
    } catch(e) {
      return err(env, req, 500, e.message || "Server error");
    }
  }
};

// ── Auth handlers ─────────────────────────────────────────────────────────────
async function authRegister(req, env) {
  const { full_name, medical_role, phone, password, departments=[], other_department, language_pref="ar" } = await req.json();
  if (!full_name||!medical_role||!phone||!password) return err(env,req,400,"Missing fields");
  if (!/^\d{8}$/.test(phone)) return err(env,req,400,"Phone must be exactly 8 digits");
  if (await env.DB.prepare("SELECT id FROM users WHERE phone=?").bind(phone).first()) return err(env,req,409,"Phone already registered");
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO users (id,full_name,medical_role,system_role,phone,password,language_pref,account_origin) VALUES (?,?,?,'user',?,?,?,'self')"
  ).bind(id, full_name, medical_role, phone, password, language_pref).run();
  for (const depId of departments)
    await env.DB.prepare("INSERT INTO user_departments (id,user_id,department_id) VALUES (?,?,?)").bind(uuid(),id,depId).run();
  if (other_department)
    await env.DB.prepare("INSERT INTO user_departments (id,user_id,custom_name) VALUES (?,?,?)").bind(uuid(),id,other_department).run();
  return ok(env, req, { user_id: id });
}
async function authLogin(req, env) {
  const { phone, password, as_role="user" } = await req.json();
  const u = await env.DB.prepare("SELECT * FROM users WHERE phone=?").bind(phone).first();
  if (!u || u.status !== "active" || u.password !== password) return err(env,req,401,"Invalid credentials");
  if (RANK[as_role] > RANK[u.system_role]) return err(env,req,403,"Not allowed");
  await env.DB.prepare("UPDATE users SET last_active_at=? WHERE id=?").bind(now(),u.id).run();
  const token = await createSession(env, u.id, as_role);
  return ok(env, req, { token, acting_role: as_role,
    user: { id:u.id, full_name:u.full_name, system_role:u.system_role, medical_role:u.medical_role, language_pref:u.language_pref } });
}
async function authLogout(req, env) {
  const s = await getSession(env, req);
  if (s) await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(s.token).run();
  return ok(env, req);
}
async function authChangePwd(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const { old: oldPwd, new: newPwd } = await req.json();
  const u = await env.DB.prepare("SELECT password FROM users WHERE id=?").bind(s.user_id).first();
  if (u.password !== oldPwd) return err(env,req,403,"Wrong current password");
  await env.DB.prepare("UPDATE users SET password=? WHERE id=?").bind(newPwd, s.user_id).run();
  return ok(env, req);
}
async function setupSeed(req, env) {
  if (await env.DB.prepare("SELECT id FROM users WHERE system_role='superadmin'").first()) return err(env,req,403,"Already seeded");
  const { full_name="Super Admin", phone, password } = await req.json();
  if (!phone||!password) return err(env,req,400,"phone and password required");
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO users (id,full_name,medical_role,system_role,phone,password,account_origin) VALUES (?,?,'other','superadmin',?,?,'admin_created')"
  ).bind(id, full_name, phone, password).run();
  return ok(env, req, { user_id: id });
}

// ── Config handlers ───────────────────────────────────────────────────────────
async function cfgPublic(req, env) {
  const r = await env.DB.prepare("SELECT key,value FROM config WHERE is_secret=0").all();
  const out = {};
  for (const row of r.results) { try { out[row.key]=JSON.parse(row.value); } catch { out[row.key]=row.value; } }
  return ok(env, req, { config: out });
}
async function cfgSecretsStatus(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const keys = ["secret.google_client_id","secret.google_client_secret","secret.google_refresh_token","secret.assemblyai_key"];
  const status = {};
  for (const k of keys) { const v = await getConfig(env,k); status[k]={ set:!!v, last4: v?String(v).slice(-4):null }; }
  return ok(env, req, { status });
}
async function cfgSet(req, env, key) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { value } = await req.json();
  await setConfig(env, key, typeof value==="string"?value:JSON.stringify(value), s.user_id);
  await audit(env, s.user_id, "set_config", "config", key, { key });
  return ok(env, req);
}
async function integAssemblyAI(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  return ok(env, req, { key: await getConfig(env,"secret.assemblyai_key") });
}

// ── Elements ──────────────────────────────────────────────────────────────────
async function eleList(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const cat = new URL(req.url).searchParams.get("category");
  const r = cat
    ? await env.DB.prepare("SELECT * FROM elements WHERE category=? ORDER BY name").bind(cat).all()
    : await env.DB.prepare("SELECT * FROM elements ORDER BY category,name").all();
  return ok(env, req, { elements: r.results });
}
async function eleCreate(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { category, name } = await req.json();
  const id = uuid();
  await env.DB.prepare("INSERT INTO elements (id,category,name,created_by) VALUES (?,?,?,?)").bind(id,category,name,s.user_id).run();
  await audit(env, s.user_id, "create_element", "element", id, { category, name });
  return ok(env, req, { id });
}
async function elePatch(req, env, id) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { status } = await req.json();
  await env.DB.prepare("UPDATE elements SET status=? WHERE id=?").bind(status,id).run();
  await audit(env, s.user_id, "retire_element", "element", id, { status });
  return ok(env, req);
}

// ── Combinations ──────────────────────────────────────────────────────────────
async function comboList(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const r = await env.DB.prepare(
    "SELECT c.*,(SELECT COUNT(*) FROM contributions ct WHERE ct.combination_id=c.id) AS contribution_count FROM combinations c ORDER BY c.created_at DESC LIMIT 500"
  ).all();
  return ok(env, req, { combinations: r.results });
}
async function comboCreate(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { combos } = await req.json();
  const created = [];
  for (const elementIds of combos) {
    const comboKey = [...elementIds].sort().join("|");
    if (await env.DB.prepare("SELECT id FROM combinations WHERE combo_key=?").bind(comboKey).first()) continue;
    const id = uuid();
    await env.DB.prepare("INSERT INTO combinations (id,combo_key,size) VALUES (?,?,?)").bind(id,comboKey,elementIds.length).run();
    let pos=1; for (const eid of elementIds)
      await env.DB.prepare("INSERT INTO combination_elements (combination_id,element_id,position) VALUES (?,?,?)").bind(id,eid,pos++).run();
    created.push(id);
  }
  return ok(env, req, { created });
}
async function comboNext(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  if (await isKilled(env,"kill_recording")) return ok(env,req,{ paused:true });
  const r = await env.DB.prepare("SELECT id FROM combinations WHERE status='available' ORDER BY RANDOM() LIMIT 4").all();
  const combinations = [];
  for (const row of r.results)
    combinations.push({ combination_id:row.id, elements: await comboElementNames(env,row.id) });
  return ok(env, req, { combinations });
}
async function comboPatch(req, env, id) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { status } = await req.json();
  await env.DB.prepare("UPDATE combinations SET status=? WHERE id=?").bind(status,id).run();
  return ok(env, req);
}

// ── Recording ─────────────────────────────────────────────────────────────────
async function contribCreate(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const { combination_id, device_type, os, browser } = await req.json();
  const demoOn    = (await getConfig(env,"demo_mode")) === "true";
  const phaseRow  = demoOn ? await env.DB.prepare("SELECT id FROM demo_phases WHERE status='active' ORDER BY created_at DESC LIMIT 1").first() : null;
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO contributions (id,user_id,combination_id,status,drive_folder,is_demo,demo_phase_id,device_type,os,browser) VALUES (?,?,?,'recording',?,?,?,?,?,?)"
  ).bind(id, s.user_id, combination_id, demoOn?"demo":"main", demoOn?1:0, phaseRow?.id||null, device_type||null, os||null, browser||null).run();
  await env.DB.prepare("UPDATE combinations SET status='in_use' WHERE id=? AND status='available'").bind(combination_id).run();
  return ok(env, req, { contribution_id: id });
}
async function contribUploadUrl(req, env, contribId) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const c = await env.DB.prepare("SELECT * FROM contributions WHERE id=? AND user_id=?").bind(contribId,s.user_id).first();
  if (!c) return err(env,req,404,"Not found");
  const { mime_type } = await req.json();
  const ext = (mime_type||"").includes("mp4")?"m4a":"webm";
  const url = await createUploadSession(env, c.drive_folder, `${contribId}.${ext}`, mime_type);
  return ok(env, req, { upload_url: url });
}
async function contribAudioDone(req, env, contribId) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const { drive_file_id, original_format, duration_seconds } = await req.json();
  const minDur = parseFloat(await getConfig(env,"min_recording_seconds")||"2");
  if (duration_seconds != null && duration_seconds < minDur) return err(env,req,422,"recording_too_short");
  await env.DB.prepare(
    "UPDATE contributions SET drive_file_id=?,original_format=?,duration_seconds=?,status='to_transcribe',updated_at=? WHERE id=? AND user_id=?"
  ).bind(drive_file_id, original_format||null, duration_seconds||null, now(), contribId, s.user_id).run();
  return ok(env, req);
}
async function skipLog(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const { combination_id } = await req.json();
  await env.DB.prepare("INSERT INTO skips (id,user_id,combination_id) VALUES (?,?,?)").bind(uuid(),s.user_id,combination_id).run();
  await env.DB.prepare("UPDATE combinations SET status='available' WHERE id=?").bind(combination_id).run();
  return ok(env, req);
}

// ── Transcription ─────────────────────────────────────────────────────────────
async function toTranscribe(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const r = await env.DB.prepare(
    "SELECT id,combination_id,drive_file_id,original_format,duration_seconds FROM contributions WHERE user_id=? AND status='to_transcribe' ORDER BY created_at ASC"
  ).bind(s.user_id).all();
  const items = [];
  for (const c of r.results)
    items.push({ ...c, word_boost: await comboElementNames(env, c.combination_id) });
  return ok(env, req, { count: items.length, items });
}
async function transcribe(req, env, contribId) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  if (await isKilled(env,"kill_transcription")) return ok(env,req,{ paused:true });
  const { transcription, source, ai_suggestion } = await req.json();
  if (!transcription?.trim()) return err(env,req,400,"Transcription required");
  await env.DB.prepare(
    "UPDATE contributions SET transcription=?,transcription_source=?,ai_suggestion=?,status='submitted',review_count=0,submitted_at=?,updated_at=? WHERE id=? AND user_id=? AND status='to_transcribe'"
  ).bind(transcription.trim(), source||"typed_own", ai_suggestion||null, now(), now(), contribId, s.user_id).run();
  return ok(env, req);
}

// ── My contributions ──────────────────────────────────────────────────────────
async function myContribs(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const r = await env.DB.prepare(
    "SELECT id,combination_id,drive_file_id,transcription,status,review_count,created_at FROM contributions WHERE user_id=? AND status NOT IN ('deleted','trashed') ORDER BY created_at DESC LIMIT 200"
  ).bind(s.user_id).all();
  const items = r.results.map(c => ({
    ...c,
    editable: (c.status==="submitted"||c.status==="to_transcribe") && c.review_count===0,
    rejected: c.status==="rejected",
  }));
  return ok(env, req, { items });
}
async function editContrib(req, env, contribId) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const c = await env.DB.prepare("SELECT * FROM contributions WHERE id=? AND user_id=?").bind(contribId,s.user_id).first();
  if (!c) return err(env,req,404,"Not found");
  if (c.review_count>0||c.status==="rejected") return err(env,req,403,"Not editable");
  const { transcription } = await req.json();
  await env.DB.prepare("UPDATE contributions SET transcription=?,transcription_source='typed_own',updated_at=? WHERE id=?")
    .bind(transcription, now(), contribId).run();
  return ok(env, req);
}

// ── Reviews ───────────────────────────────────────────────────────────────────
async function reviewNext(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  if (await isKilled(env,"kill_review")) return ok(env,req,{ paused:true });
  const minRow = await env.DB.prepare(
    "SELECT MIN(review_count) AS lvl FROM contributions WHERE status='submitted' AND user_id!=?1 AND NOT EXISTS (SELECT 1 FROM reviews WHERE contribution_id=contributions.id AND reviewer_id=?1)"
  ).bind(s.user_id).first();
  if (minRow.lvl == null) return ok(env,req,{ clip:null });
  const c = await env.DB.prepare(
    "SELECT id,transcription,review_count,drive_file_id FROM contributions WHERE status='submitted' AND review_count=?2 AND user_id!=?1 AND NOT EXISTS (SELECT 1 FROM reviews WHERE contribution_id=contributions.id AND reviewer_id=?1) ORDER BY RANDOM() LIMIT 1"
  ).bind(s.user_id, minRow.lvl).first();
  if (!c) return ok(env,req,{ clip:null });
  const flags = await env.DB.prepare("SELECT category,code,free_text,is_red FROM flags WHERE contribution_id=? AND category='audio'").bind(c.id).all();
  return ok(env, req, { clip: { contribution_id:c.id, text:c.transcription, level:c.review_count+1, drive_file_id:c.drive_file_id, existing_audio_flags:flags.results } });
}
async function reviewSubmit(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const { contribution_id, text_seen, audio_flags=[], text_flags=[], text_edited=false, text_left, duration_seconds } = await req.json();
  const c = await env.DB.prepare("SELECT * FROM contributions WHERE id=?").bind(contribution_id).first();
  if (!c||c.status!=="submitted") return err(env,req,409,"Not reviewable");
  if (c.user_id===s.user_id) return err(env,req,403,"Cannot review own");
  if (await env.DB.prepare("SELECT id FROM reviews WHERE contribution_id=? AND reviewer_id=?").bind(contribution_id,s.user_id).first()) return err(env,req,409,"Already reviewed");
  // conditional follow-up validation
  for (const f of [...audio_flags,...text_flags])
    if (f.followup_question && !f.followup_answer) return err(env,req,422,"followup_required");
  const level   = c.review_count + 1;
  const hasOff  = await env.DB.prepare("SELECT id FROM reviews WHERE contribution_id=? AND level=? AND is_official=1").bind(contribution_id,level).first();
  const isOff   = hasOff ? 0 : 1;
  const reviewId = uuid();
  await env.DB.prepare(
    "INSERT INTO reviews (id,contribution_id,reviewer_id,level,text_seen,text_left,text_edited,is_official,duration_seconds) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(reviewId, contribution_id, s.user_id, level, text_seen||null, text_left||c.transcription, text_edited?1:0, isOff, duration_seconds||null).run();
  const autoReject = await getConfigJSON(env,"auto_reject_flags",[]);
  let rejected = false;
  for (const f of audio_flags) { await insertFlag(env,reviewId,contribution_id,"audio",f); if(autoReject.includes(f.code)) rejected=true; }
  for (const f of text_flags)  { await insertFlag(env,reviewId,contribution_id,"text",f);  if(autoReject.includes(f.code)) rejected=true; }
  if (rejected) {
    await env.DB.prepare("UPDATE contributions SET status='rejected',drive_folder='rejected',updated_at=? WHERE id=?").bind(now(),contribution_id).run();
    await moveDriveFile(env, c.drive_file_id, "rejected");
    await env.DB.prepare("UPDATE combinations SET status='available' WHERE id=?").bind(c.combination_id).run();
    const fixits  = await getConfigJSON(env,"fixit_messages",{});
    const first   = [...audio_flags,...text_flags].find(f=>autoReject.includes(f.code));
    await notify(env, c.user_id, "rejection", "Contribution rejetée", (first&&fixits[first.code])||"Votre contribution n'a pas été retenue.");
    return ok(env,req,{ result:"rejected" });
  }
  if (isOff) {
    const newText  = text_edited ? (text_left||c.transcription) : c.transcription;
    const newCount = level;
    await env.DB.prepare("UPDATE contributions SET transcription=?,review_count=?,status=?,updated_at=? WHERE id=?")
      .bind(newText, newCount, newCount>=3?"final":"submitted", now(), contribution_id).run();
  }
  return ok(env,req,{ result:"reviewed", official:!!isOff });
}
async function insertFlag(env, reviewId, contribId, category, f) {
  await env.DB.prepare(
    "INSERT INTO flags (id,review_id,contribution_id,category,code,free_text,followup_question,followup_answer,is_red) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(uuid(), reviewId, contribId, category, f.code, f.free_text||null, f.followup_question||null, f.followup_answer||null, f.is_red?1:0).run();
}

// ── Notifications ─────────────────────────────────────────────────────────────
async function notifList(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const r = await env.DB.prepare("SELECT id,type,title,body,is_read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(s.user_id).all();
  return ok(env,req,{ items:r.results, unread:r.results.filter(n=>!n.is_read).length });
}
async function notifRead(req, env, id) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  await env.DB.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?").bind(id,s.user_id).run();
  return ok(env,req);
}

// ── Progress ──────────────────────────────────────────────────────────────────
async function myProgress(req, env) {
  const s = await getSession(env, req);
  if (!s) return err(env,req,401,"Unauthorized");
  const contrib = await env.DB.prepare("SELECT COUNT(*) AS n FROM contributions WHERE user_id=? AND status IN ('submitted','final')").bind(s.user_id).first();
  const reviews = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE reviewer_id=?").bind(s.user_id).first();
  const today   = await env.DB.prepare("SELECT COUNT(*) AS n FROM contributions WHERE user_id=? AND status IN ('submitted','final') AND substr(submitted_at,1,10)=substr(?,1,10)").bind(s.user_id,now()).first();
  const target  = parseInt(await getConfig(env,"daily_target")||"20",10);
  const interval= parseInt(await getConfig(env,"congrats_interval")||"15",10);
  return ok(env,req,{ contributions:contrib.n, reviews:reviews.n, today:today.n, daily_target:target, remaining_today:Math.max(0,target-today.n), congrats_interval:interval });
}

// ── Admin ─────────────────────────────────────────────────────────────────────
async function adminUsers(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const r = await env.DB.prepare(
    "SELECT u.id,u.full_name,u.medical_role,u.system_role,u.last_active_at,(SELECT COUNT(*) FROM contributions c WHERE c.user_id=u.id AND c.status IN ('submitted','final')) AS contributions,(SELECT COUNT(*) FROM reviews rv WHERE rv.reviewer_id=u.id) AS reviews FROM users u WHERE u.status='active' ORDER BY u.full_name"
  ).all();
  return ok(env,req,{ users:r.results });
}
async function adminCreateUser(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const { full_name, medical_role="other", phone, password, system_role="user" } = await req.json();
  if (system_role!=="user" && !hasRole(s,"superadmin")) return err(env,req,403,"Only super-admin creates admins");
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO users (id,full_name,medical_role,system_role,phone,password,account_origin,created_by) VALUES (?,?,?,?,?,?,'admin_created',?)"
  ).bind(id,full_name,medical_role,system_role,phone,password,s.user_id).run();
  await audit(env,s.user_id,"create_user","user",id,{ system_role });
  return ok(env,req,{ id });
}
async function adminUserDetail(req, env, userId) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const u = await env.DB.prepare("SELECT id,full_name,medical_role,system_role,phone,created_at,last_active_at FROM users WHERE id=?").bind(userId).first();
  const cs= await env.DB.prepare("SELECT id,status,review_count,transcription,original_format,device_type,os,browser,created_at FROM contributions WHERE user_id=? ORDER BY created_at DESC LIMIT 200").bind(userId).all();
  return ok(env,req,{ user:u, contributions:cs.results });
}
async function adminDeleteUser(req, env, userId) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const cs = await env.DB.prepare("SELECT id,drive_file_id FROM contributions WHERE user_id=?").bind(userId).all();
  for (const c of cs.results) if (c.drive_file_id) await moveDriveFile(env,c.drive_file_id,"deleted");
  await env.DB.prepare("UPDATE contributions SET status='deleted',drive_folder='deleted' WHERE user_id=?").bind(userId).run();
  await env.DB.prepare("UPDATE users SET status='deleted' WHERE id=?").bind(userId).run();
  await audit(env,s.user_id,"delete_user","user",userId,{});
  return ok(env,req);
}
async function adminDistrib(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const byCat = await env.DB.prepare(
    "SELECT e.category,COUNT(DISTINCT c.id) AS n FROM contributions c JOIN combination_elements ce ON ce.combination_id=c.combination_id JOIN elements e ON e.id=ce.element_id WHERE c.status IN ('submitted','final') GROUP BY e.category"
  ).all();
  const total = await env.DB.prepare("SELECT COALESCE(SUM(duration_seconds),0) AS secs,COUNT(*) AS n FROM contributions WHERE status IN ('submitted','final')").first();
  return ok(env,req,{ by_category:byCat.results, total_seconds:total.secs, total_clips:total.n });
}
async function adminFlags(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const code = new URL(req.url).searchParams.get("code");
  const r = code
    ? await env.DB.prepare("SELECT * FROM flags WHERE code=? ORDER BY created_at DESC LIMIT 300").bind(code).all()
    : await env.DB.prepare("SELECT * FROM flags ORDER BY created_at DESC LIMIT 300").all();
  return ok(env,req,{ flags:r.results });
}
async function adminBroadcast(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const { user_ids, title, body } = await req.json();
  let targets = user_ids?.length ? user_ids : (await env.DB.prepare("SELECT id FROM users WHERE status='active' AND system_role='user'").all()).results.map(u=>u.id);
  for (const uid of targets) await notify(env,uid,"broadcast",title,body);
  return ok(env,req,{ sent:targets.length });
}
async function adminAudit(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const r = await env.DB.prepare("SELECT a.*,u.full_name AS actor_name FROM audit_log a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 300").all();
  return ok(env,req,{ log:r.results });
}
async function adminAnomalies(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const threshold = parseFloat(await getConfig(env,"review_time_min_seconds")||"4");
  const r = await env.DB.prepare("SELECT reviewer_id,COUNT(*) AS fast_reviews,AVG(duration_seconds) AS avg_secs FROM reviews WHERE duration_seconds IS NOT NULL AND duration_seconds<?  GROUP BY reviewer_id ORDER BY fast_reviews DESC").bind(threshold).all();
  return ok(env,req,{ threshold, suspects:r.results });
}
async function adminDeleteReviews(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const p = new URL(req.url).searchParams;
  const below = parseFloat(p.get("below")||"0");
  const user  = p.get("user");
  const res   = user
    ? await env.DB.prepare("DELETE FROM reviews WHERE duration_seconds<? AND reviewer_id=?").bind(below,user).run()
    : await env.DB.prepare("DELETE FROM reviews WHERE duration_seconds<?").bind(below).run();
  await audit(env,s.user_id,"delete_reviews","review",null,{ below,user });
  return ok(env,req,{ deleted:res.meta.changes });
}
async function adminExportCreate(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { label, criteria } = await req.json();
  const snapId = uuid();
  await env.DB.prepare("INSERT INTO export_snapshots (id,label,criteria,created_by) VALUES (?,?,?,?)").bind(snapId,label||null,JSON.stringify(criteria||{}),s.user_id).run();
  const minLevel = criteria?.min_level ?? 0;
  const clips = await env.DB.prepare("SELECT id,transcription,review_count FROM contributions WHERE status IN ('submitted','final') AND review_count>=?").bind(minLevel).all();
  for (const c of clips.results)
    await env.DB.prepare("INSERT INTO snapshot_contributions (snapshot_id,contribution_id,frozen_transcription,frozen_review_count) VALUES (?,?,?,?)").bind(snapId,c.id,c.transcription,c.review_count).run();
  await audit(env,s.user_id,"create_export","export",snapId,{ count:clips.results.length });
  return ok(env,req,{ snapshot_id:snapId, frozen:clips.results.length });
}
async function adminExportGet(req, env, snapId) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const snap = await env.DB.prepare("SELECT * FROM export_snapshots WHERE id=?").bind(snapId).first();
  const r    = await env.DB.prepare("SELECT sc.*,c.drive_file_id,c.original_format FROM snapshot_contributions sc JOIN contributions c ON c.id=sc.contribution_id WHERE sc.snapshot_id=?").bind(snapId).all();
  return ok(env,req,{ snapshot:snap, clips:r.results });
}
async function adminDemoPhase(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { action, label } = await req.json();
  if (action==="start") {
    const id = uuid();
    await env.DB.prepare("INSERT INTO demo_phases (id,label) VALUES (?,?)").bind(id,label||null).run();
    await setConfig(env,"demo_mode","true",s.user_id);
    return ok(env,req,{ phase_id:id });
  }
  await setConfig(env,"demo_mode","false",s.user_id);
  return ok(env,req);
}
async function adminDemoMigrate(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { contribution_ids=[] } = await req.json();
  for (const id of contribution_ids) {
    const c = await env.DB.prepare("SELECT drive_file_id FROM contributions WHERE id=?").bind(id).first();
    if (c?.drive_file_id) await moveDriveFile(env,c.drive_file_id,"main");
    await env.DB.prepare("UPDATE contributions SET is_demo=0,demo_phase_id=NULL,drive_folder='main' WHERE id=?").bind(id).run();
  }
  return ok(env,req,{ migrated:contribution_ids.length });
}
async function adminDemoDestroy(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { phase_id } = await req.json();
  const cs = await env.DB.prepare("SELECT id,drive_file_id FROM contributions WHERE demo_phase_id=?").bind(phase_id).all();
  for (const c of cs.results) if (c.drive_file_id) await moveDriveFile(env,c.drive_file_id,"trash");
  await env.DB.prepare("UPDATE contributions SET status='trashed',drive_folder='trash' WHERE demo_phase_id=?").bind(phase_id).run();
  await env.DB.prepare("UPDATE demo_phases SET status='destroyed' WHERE id=?").bind(phase_id).run();
  await setConfig(env,"demo_mode","false",s.user_id);
  return ok(env,req,{ trashed:cs.results.length });
}
async function adminDepts(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"admin")) return err(env,req,403,"Forbidden");
  const r = await env.DB.prepare("SELECT * FROM departments ORDER BY name").all();
  return ok(env,req,{ departments:r.results });
}
async function adminCreateDept(req, env) {
  const s = await getSession(env, req);
  if (!hasRole(s,"superadmin")) return err(env,req,403,"Forbidden");
  const { name } = await req.json();
  const id = uuid();
  await env.DB.prepare("INSERT INTO departments (id,name) VALUES (?,?)").bind(id,name).run();
  return ok(env,req,{ id });
}
