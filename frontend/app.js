const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[c]);
let overview;

function date(value) { return value ? new Date(value).toLocaleString() : "—"; }
function badge(value) { return `<span class="badge ${esc(value)}">${esc(String(value).replaceAll("_", " "))}</span>`; }
function deviceName(item) { return `${esc(item.name || item.ip)} <span class="muted">${esc(item.ip)}</span>`; }
function show(message = "", error = false) { const el = $("#notice"); el.textContent = message; el.style.color = error ? "var(--bad)" : "var(--good)"; }

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function render(data) {
  overview = data;
  const labels = [["devices", "Registered devices"], ["activeDevices", "Active devices"], ["users", "Active users"], ["usersFullySynced", "Fully synced users"], ["usersNeedingSync", "Users needing sync"], ["deviceEvents", "Captured device events"], ["requestLogs", "Recorded API requests"]];
  $("#stats").innerHTML = labels.map(([key, label]) => `<div class="stat"><span>${label}</span><strong>${data.stats[key]}</strong></div>`).join("");
  $("#devices").innerHTML = data.devices.map((device) => `<tr>
    <td><div class="device-name">${esc(device.name || device.ip)}</div><span class="muted">${esc(device.ip)} · ${esc(device.username)}</span></td>
    <td>${badge(device.status)}${device.lastStatus ? ` ${badge(device.lastStatus)}` : ""}</td>
    <td>${date(device.lastAttemptAt)}${device.lastError ? `<div class="muted">${esc(device.lastError)}</div>` : ""}</td>
    <td>${device.syncedUsers} synced<br><span class="muted">${device.unsyncedUsers} need sync</span></td>
    <td><div class="actions"><button class="text-button" data-edit="${device._id}">Edit</button><button class="text-button" data-toggle="${device._id}">${device.status === "active" ? "Disable" : "Enable"}</button></div></td>
  </tr>`).join("") || `<tr><td colspan="5" class="muted">No devices registered yet.</td></tr>`;
  renderUsers();
  $("#events").innerHTML = eventItems(data.recentEvents) || '<p class="muted">No persisted device events yet.</p>';
}

function renderUsers() {
  const term = $("#user-search").value.trim().toLowerCase();
  const users = overview.users.filter((user) => `${user.name} ${user.employeeNo}`.toLowerCase().includes(term));
  $("#users").innerHTML = users.map((user) => `<tr><td><strong>${esc(user.name)}</strong><br><span class="muted">${esc(user.employeeNo)} · ${esc(user.userType)}</span></td><td>${user.syncedDevices.length ? user.syncedDevices.map(deviceName).join("<br>") : '<span class="muted">None</span>'}</td><td>${user.unsyncedDevices.length ? user.unsyncedDevices.map((d) => `${deviceName(d)} ${badge(d.status)}`).join("<br>") : badge("synced")}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">No matching users.</td></tr>';
}

function eventItems(events) { return events.map((event) => `<article class="log-item"><strong>${esc(event.eventType || "device event")} · ${esc(event.name || event.employeeNoString || "Unknown user")}</strong><small>${esc(event.deviceId?.name || event.deviceId?.ip || "Unknown device")} · ${date(event.time)}</small></article>`).join(""); }
function requestItems(logs) { return logs.map((log) => `<article class="log-item"><strong>${esc(log.method)} ${esc(log.url)} · ${log.statusCode || "—"}</strong><small>${date(log.createdAt)} · ${log.durationMs ?? "—"} ms · ${esc(log.ip || "")}</small></article>`).join(""); }

async function load() { try { render(await api("/dashboard/overview")); show(""); } catch (err) { show(`Could not load dashboard: ${err.message}`, true); } }

function openDeviceForm(device) {
  const form = $("#device-form"); form.reset();
  if (device) { form.elements.id.value = device._id; form.elements.name.value = device.name || ""; form.elements.ip.value = device.ip; form.elements.username.value = device.username; form.elements.password.placeholder = "Leave blank to keep current password"; }
  else form.password.placeholder = "Required for new devices";
  $("#device-form-wrap").classList.remove("hidden"); form.name.focus();
}

$("#refresh").addEventListener("click", load);
$("#new-device").addEventListener("click", () => openDeviceForm());
$("#cancel-device").addEventListener("click", () => $("#device-form-wrap").classList.add("hidden"));
$("#user-search").addEventListener("input", () => overview && renderUsers());
$("#devices").addEventListener("click", async (event) => {
  const id = event.target.dataset.edit || event.target.dataset.toggle; if (!id) return;
  if (event.target.dataset.edit) return openDeviceForm(overview.devices.find((device) => device._id === id));
  const device = overview.devices.find((item) => item._id === id);
  try { await api(`/devices/${id}/status`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ status: device.status === "active" ? "disabled" : "active" }) }); show("Device state updated."); load(); } catch (err) { show(err.message, true); }
});
$("#device-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form));
  if (!body.id && !body.password) return show("A password is required for a new device.", true);
  if (body.id && !body.password) delete body.password;
  try { await api(body.id ? `/devices/${body.id}` : "/devices", { method: body.id ? "PATCH" : "POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }); $("#device-form-wrap").classList.add("hidden"); show("Device saved."); load(); } catch (err) { show(err.message, true); }
});
async function showLogs(type) {
  const data = await api(type === "events" ? "/dashboard/device-events?limit=200" : "/dashboard/request-logs?limit=200");
  $("#dialog-title").textContent = type === "events" ? `Device events (${data.total})` : `API requests (${data.total})`;
  $("#dialog-content").innerHTML = type === "events" ? eventItems(data.events) : requestItems(data.logs);
  $("#logs-dialog").showModal();
}
$("#load-events").addEventListener("click", () => showLogs("events").catch((err) => show(err.message, true)));
$("#load-requests").addEventListener("click", () => showLogs("requests").catch((err) => show(err.message, true)));
$("#close-dialog").addEventListener("click", () => $("#logs-dialog").close());
load();
