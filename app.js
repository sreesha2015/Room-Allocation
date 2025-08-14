import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// Supabase client
const SUPABASE_URL = window.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  alert("Supabase URL/key missing. Set them in config.js");
}
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// DOM helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

// Tabs
$$(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const id = btn.dataset.tab;
    $$(".tab").forEach(t => t.classList.remove("active"));
    byId(id).classList.add("active");
  });
});

// State
let rooms = [];
let bookings = [];
let blackouts = [];
let adminOK = false;

// Dates & helpers
const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0,10) : d);
const toDate = (s) => new Date(`${s}T00:00:00`);
const lt = (a,b) => toDate(a) < toDate(b);
const lte = (a,b) => toDate(a) <= toDate(b);
const gte = (a,b) => toDate(a) >= toDate(b);

const overlaps = (aFrom, aTo, bFrom, bTo) => lt(aFrom, bTo) && lt(bFrom, aTo);
const within = (rangeFrom, rangeTo, from, to) => lte(rangeFrom, from) && gte(rangeTo, to);
const uniqBlocks = (list) => [...new Set(list.map(r => r.block))].sort();

// Fetchers
async function fetchRooms() {
  const { data, error } = await supabase.from("rooms").select("*").order("block").order("name");
  if (error) throw error;
  rooms = (data ?? []).map(r => ({...r, ranges: Array.isArray(r.ranges) ? r.ranges : []}));
}
async function fetchBookings() {
  const today = fmt(new Date());
  const { data, error } = await supabase.from("bookings").select("*").gte("to", today).order("from", { ascending: true });
  if (error) throw error;
  bookings = data ?? [];
}
async function fetchBlackouts() {
  const { data, error } = await supabase.from("blackouts").select("*");
  if (error) throw error;
  blackouts = (data ?? []).map(b => ({...b, ranges: Array.isArray(b.ranges) ? b.ranges : []}));
}
async function fetchAll() { await Promise.all([fetchRooms(), fetchBookings(), fetchBlackouts()]); }

// Seed defaults
async function seedRoomsIfEmpty() {
  if (rooms.length > 0) return;
  const blocks = ["A","B","C","D","E","F"];
  const seed = [];
  for (const b of blocks) {
    for (let i=1;i<=25;i++) {
      seed.push({ id: crypto.randomUUID(), block: b, name: String(i).padStart(2,"0"), ranges: [] });
    }
  }
  const { error } = await supabase.from("rooms").insert(seed);
  if (error) throw error;
}

// Settings (admin pin)
async function ensureAdminPin() {
  const { data, error } = await supabase.from("settings").select("*").eq("key","admin_pin").single();
  if (error && error.code !== "PGRST116") throw error; // not found
  if (!data) {
    const { error: e2 } = await supabase.from("settings").upsert({ key:"admin_pin", value:"1234" });
    if (e2) throw e2;
  }
}

// UI population
function populateBlockSelects() {
  const blocks = uniqBlocks(rooms);
  const selects = [byId("bkBlock"), byId("avBlock"), byId("adBlock")];
  for (const sel of selects) {
    const keepAny = sel.id === "avBlock";
    sel.innerHTML = keepAny ? `<option value="">Any</option>` : "";
    for (const b of blocks) {
      const opt = document.createElement("option"); opt.value = b; opt.textContent = b; sel.appendChild(opt);
    }
  }
}
function populateRoomsFor(selectIdFromBlock, selectIdRoom) {
  const b = byId(selectIdFromBlock).value;
  const rSel = byId(selectIdRoom);
  rSel.innerHTML = "";
  const filtered = rooms.filter(r => r.block === b);
  for (const r of filtered) {
    const opt = document.createElement("option"); opt.value = r.id; opt.textContent = r.name; rSel.appendChild(opt);
  }
}
["bkBlock","adBlock"].forEach(id => {
  byId(id).addEventListener("change", () => {
    populateRoomsFor(id, id==="bkBlock" ? "bkRoom" : "adRoom");
    renderRanges();
  });
});

function renderBookingsList() {
  const list = byId("bkList"); list.innerHTML = "";
  for (const b of bookings) {
    const card = document.createElement("div"); card.className = "card";
    card.innerHTML = `
      <div><strong>${b.block}-${b.room_name}</strong></div>
      <div>${b.guest_name} (${b.guest_phone})</div>
      <div>${b.from} → ${b.to}</div>
      <div class="actions" style="margin-top:6px;">
        <button data-id="${b.id}" class="danger btnCancel">Cancel</button>
      </div>`;
    list.appendChild(card);
  }
  $$(".btnCancel").forEach(btn => btn.addEventListener("click", async (e)=>{
    const id = e.currentTarget.dataset.id;
    if (!confirm(`Cancel booking ${id}?`)) return;
    const { error } = await supabase.from("bookings").delete().eq("id", id);
    if (error) { alert(error.message); return; }
    await fetchBookings(); renderBookingsList();
  }));
}

function renderRanges() {
  const rid = byId("adRoom").value;
  const rangeList = byId("rangeList"); rangeList.innerHTML = "";
  if (!rid) return;
  const room = rooms.find(r => r.id === rid); if (!room) return;
  (room.ranges ?? []).forEach((rg, idx) => {
    const wrap = document.createElement("div"); wrap.className = "card";
    wrap.innerHTML = `
      <div><strong>${rg.from}</strong> → <strong>${rg.to}</strong></div>
      <div class="actions" style="margin-top:6px;">
        <button data-i="${idx}" class="danger btnDelRange">Delete</button>
      </div>`;
    rangeList.appendChild(wrap);
  });
  $$(".btnDelRange").forEach(btn => btn.addEventListener("click", ()=>{
    const i = Number(btn.dataset.i);
    const room = rooms.find(r => r.id === rid);
    room.ranges.splice(i,1); renderRanges();
  }));
}

// Blackouts/availability helpers
function getBlackoutRangesFor(block) {
  const b = blackouts.find(x => x.block === block);
  return b ? (b.ranges ?? []) : [];
}
function isAllowedByRoomRanges(room, from, to) {
  const bl = getBlackoutRangesFor(room.block);
  for (const bk of bl) { if (overlaps(from, to, bk.from, bk.to)) return false; }
  for (const rg of (room.ranges ?? [])) { if (within(rg.from, rg.to, from, to)) return true; }
  return false;
}
function hasBookingOverlap(room, from, to) {
  return bookings.some(b => b.room_id === room.id && overlaps(from, to, b.from, b.to));
}
function findAvailableRooms(from, to, block = "") {
  const list = rooms.filter(r => !block || r.block === block);
  return list.filter(r => isAllowedByRoomRanges(r, from, to) && !hasBookingOverlap(r, from, to));
}

// Actions
byId("btnCheck").addEventListener("click", ()=>{
  const from = byId("bkFrom").value, to = byId("bkTo").value;
  const rid  = byId("bkRoom").value; const room = rooms.find(r => r.id === rid);
  if (!from || !to || !room) { byId("bkMsg").textContent = "Select dates, block, room."; return; }
  if (!lt(from, to)) { byId("bkMsg").textContent = "From must be before To."; return; }
  const ok = isAllowedByRoomRanges(room, from, to) && !hasBookingOverlap(room, from, to);
  byId("bkMsg").textContent = ok ? "✅ Available" : "❌ Not available";
});
byId("btnBook").addEventListener("click", async ()=>{
  const from = byId("bkFrom").value, to = byId("bkTo").value;
  const rid  = byId("bkRoom").value; const room = rooms.find(r => r.id === rid);
  const guest_name = byId("bkGuestName").value.trim();
  const guest_phone = byId("bkGuestPhone").value.trim();
  if (!from || !to || !room || !guest_name || !guest_phone) { byId("bkMsg").textContent = "Fill all fields."; return; }
  if (!lt(from, to)) { byId("bkMsg").textContent = "From must be before To."; return; }
  const ok = isAllowedByRoomRanges(room, from, to) && !hasBookingOverlap(room, from, to);
  if (!ok) { byId("bkMsg").textContent = "Room not available in that range."; return; }
  const id = `bk_${crypto.randomUUID()}`;
  const row = { id, from, to, room_id: room.id, block: room.block, room_name: room.name, guest_name, guest_phone };
  const { error } = await supabase.from("bookings").insert(row);
  if (error) { byId("bkMsg").textContent = error.message; return; }
  byId("bkMsg").textContent = `✅ Booked ${room.block}-${room.name} (${from}→${to})`;
  await fetchBookings(); renderBookingsList();
});

byId("btnFind").addEventListener("click", ()=>{
  const from = byId("avFrom").value, to = byId("avTo").value, block = byId("avBlock").value;
  if (!from || !to || !lt(from, to)) { byId("avMsg").textContent = "Pick a valid date range."; return; }
  const avail = findAvailableRooms(from, to, block);
  const list = byId("avList"); list.innerHTML = "";
  if (avail.length === 0) { byId("avMsg").textContent = "No rooms available for that range."; return; }
  byId("avMsg").textContent = `${avail.length} room(s) available.`;
  for (const r of avail) {
    const card = document.createElement("div"); card.className = "card";
    card.innerHTML = `
      <div><strong>${r.block}-${r.name}</strong></div>
      <div class="muted">Room ID: ${r.id.slice(0,8)}…</div>
      <div class="actions" style="margin-top:6px;">
        <button data-id="${r.id}" class="btnUse">Use in Booking</button>
      </div>`;
    list.appendChild(card);
  }
  $$(".btnUse").forEach(btn => btn.addEventListener("click", (e)=>{
    const rid = e.currentTarget.dataset.id; const r = rooms.find(x => x.id === rid);
    byId("bkBlock").value = r.block; populateRoomsFor("bkBlock","bkRoom"); byId("bkRoom").value = r.id;
    document.querySelector('[data-tab="bookTab"]').click();
  }));
});

// Admin
byId("btnAdminLogin").addEventListener("click", async ()=>{
  const pin = byId("adminPin").value.trim();
  const { data, error } = await supabase.from("settings").select("*").eq("key","admin_pin").single();
  if (error) { byId("adminStatus").textContent = error.message; return; }
  if (data.value === pin) { 
    adminOK = true; byId("adminPanel").classList.remove("hidden"); byId("adminStatus").textContent = "Logged in."; 
  } else { byId("adminStatus").textContent = "Invalid PIN."; }
});
byId("btnAddRange").addEventListener("click", ()=>{
  if (!adminOK) return;
  const rid = byId("adRoom").value; const rf = byId("rngFrom").value; const rt = byId("rngTo").value;
  if (!rid || !rf || !rt || !lt(rf,rt)) { byId("adMsg").textContent = "Pick valid room & dates."; return; }
  const room = rooms.find(r => r.id === rid); room.ranges.push({ from: rf, to: rt });
  room.ranges.sort((a,b)=> toDate(a.from)-toDate(b.from));
  renderRanges(); byId("adMsg").textContent = "Range added locally. Click Save Ranges to persist.";
});
byId("btnSaveRanges").addEventListener("click", async ()=>{
  if (!adminOK) return;
  const rid = byId("adRoom").value; const room = rooms.find(r => r.id === rid); if (!room) return;
  const { error } = await supabase.from("rooms").update({ ranges: room.ranges }).eq("id", room.id);
  if (error) { byId("adMsg").textContent = error.message; return; }
  byId("adMsg").textContent = "✅ Ranges saved."; await fetchRooms(); renderRanges();
});
byId("btnSeed").addEventListener("click", async ()=>{
  if (!adminOK) return;
  if (!confirm("Seed A–F blocks with 25 rooms each? (Skips if rooms already exist)")) return;
  await seedRoomsIfEmpty(); await fetchRooms(); populateBlockSelects();
  populateRoomsFor("bkBlock","bkRoom"); populateRoomsFor("adBlock","adRoom"); renderRanges();
  byId("adMsg").textContent = "✅ Seed complete.";
});

// Realtime (optional)
try {
  const ch = supabase.channel("db-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, async ()=>{ await fetchRooms(); populateBlockSelects(); renderRanges(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, async ()=>{ await fetchBookings(); renderBookingsList(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "blackouts" }, async ()=>{ await fetchBlackouts(); })
    .subscribe();
} catch { /* no-op */ }

// Init
(async function init(){
  try {
    await ensureAdminPin();
    await fetchAll();
    await seedRoomsIfEmpty();
    await fetchAll();
    populateBlockSelects();
    populateRoomsFor("bkBlock","bkRoom"); populateRoomsFor("adBlock","adRoom");
    renderBookingsList(); renderRanges();
    document.getElementById("bkMsg").textContent = "Ready.";
  } catch (e) { console.error(e); alert("Init error: " + (e?.message || e)); }
})();
