(() => {
  const $ = (id) => document.getElementById(id);
  const list = $("message-list");
  const scroller = $("messages");
  const input = $("message-input");
  const hint = $("composer-status");
  const deviceId = localStorage.getItem("transfer-device-id") || crypto.randomUUID();
  localStorage.setItem("transfer-device-id", deviceId);
  let deviceName = localStorage.getItem("transfer-device-name") || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "我的手机" : "我的电脑");
  let legacyKey = location.hash.match(/^#r=([A-Za-z0-9_-]{43})$/)?.[1] || localStorage.getItem("transfer-room-key");
  if (!/^[A-Za-z0-9_-]{43}$/.test(legacyKey || "")) legacyKey = null;
  localStorage.removeItem("transfer-room-key");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  $("legacy-home").hidden = !legacyKey;

  let rooms = [];
  let currentRoom = null;
  let pendingRoom = null;
  let latestId = 0;
  let oldestId = 0;
  let moreBefore = false;
  let loading = false;
  let sending = false;
  let toastTimer;
  const seen = new Set();
  const dayLabel = (date) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
  const timeLabel = (date) => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || "请求失败");
      error.status = response.status;
      throw error;
    }
    return value;
  }
  function notify(text) {
    const toast = $("toast");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }
  function connection(connected, text) {
    $("status-dot").classList.toggle("offline", !connected);
    $("status-text").textContent = text;
  }
  function roomUrl(roomId) {
    return location.origin + location.pathname + "?room=" + encodeURIComponent(roomId);
  }
  function formatActivity(room) {
    if (!room.last_message_at) return "还没有消息";
    return "最近消息 · " + timeLabel(new Date(room.last_message_at));
  }
  function renderRooms() {
    const container = $("room-list");
    container.replaceChildren();
    if (!rooms.length) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "还没有房间。点击右上角创建第一个房间。";
      container.append(empty);
      return;
    }
    for (const room of rooms) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "room-card" + (room.unlocked ? " unlocked" : "");
      const icon = document.createElement("span");
      icon.className = "room-card-icon";
      icon.textContent = room.unlocked ? "↗" : "⌑";
      const main = document.createElement("span");
      main.className = "room-card-main";
      const title = document.createElement("strong");
      title.textContent = room.name;
      const activity = document.createElement("small");
      activity.textContent = formatActivity(room);
      main.append(title, activity);
      const arrow = document.createElement("span");
      arrow.className = "room-card-arrow";
      arrow.textContent = room.unlocked ? "→" : "🔒";
      card.append(icon, main, arrow);
      card.addEventListener("click", () => chooseRoom(room));
      container.append(card);
    }
  }
  async function loadRooms() {
    try {
      const value = await api("/api/rooms");
      rooms = value.rooms;
      renderRooms();
      const requested = new URLSearchParams(location.search).get("room");
      if (requested && !currentRoom) {
        let room = rooms.find((item) => item.id === requested);
        if (!room) room = (await api("/api/rooms/" + encodeURIComponent(requested))).room;
        chooseRoom(room);
      }
    } catch (error) {
      $("room-list").textContent = "加载房间失败：" + error.message;
    }
  }
  function showHome(changeUrl = true) {
    currentRoom = null;
    $("chat").hidden = true;
    $("home").hidden = false;
    if (changeUrl) history.pushState(null, "", location.pathname);
    loadRooms();
  }
  function chooseRoom(room) {
    if (!room.unlocked) {
      pendingRoom = room;
      $("unlock-title").textContent = "进入「" + room.name + "」";
      $("unlock-error").textContent = "";
      $("unlock-pin").value = "";
      $("unlock-dialog").showModal();
      return;
    }
    enterRoom(room);
  }
  async function enterRoom(room) {
    currentRoom = room;
    pendingRoom = null;
    $("home").hidden = true;
    $("chat").hidden = false;
    $("chat-room-name").textContent = room.name;
    $("legacy-chat").hidden = !legacyKey;
    history.pushState(null, "", "?room=" + encodeURIComponent(room.id));
    resetMessages();
    await loadInitial();
  }
  function resetMessages() {
    list.replaceChildren();
    latestId = 0;
    oldestId = 0;
    moreBefore = false;
    seen.clear();
    loading = false;
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.id = "chat-empty";
    empty.innerHTML = '<div class="chat-empty-icon">↗</div><strong>开始传输消息</strong><span>在下方输入消息，另一台设备进入同一房间后就能看到。</span>';
    list.append(empty);
    connection(true, "正在同步…");
  }
  function appendSafeText(container, text) {
    const regex = /https?:\/\/[^\s<>"']+/g;
    let cursor = 0;
    for (const match of text.matchAll(regex)) {
      if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
      const link = document.createElement("a");
      link.href = match[0];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[0];
      container.append(link);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  }
  function messageNode(message) {
    const mine = message.client_id === deviceId;
    const wrap = document.createElement("article");
    wrap.className = "message" + (mine ? " mine" : "");
    wrap.dataset.id = String(message.id);
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = (message.sender || "设备").slice(0, 1);
    const body = document.createElement("div");
    body.className = "message-body";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("span");
    name.textContent = message.sender || "设备";
    const time = document.createElement("time");
    time.dateTime = new Date(message.created_at).toISOString();
    time.textContent = timeLabel(new Date(message.created_at));
    meta.append(name, time);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    appendSafeText(bubble, message.body);
    body.append(meta, bubble);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-copy";
    copy.textContent = "复制";
    copy.setAttribute("aria-label", "复制消息");
    copy.addEventListener("click", async () => {
      try { await copyText(message.body); notify("消息已复制"); }
      catch { notify("复制失败"); }
    });
    wrap.append(avatar, body, copy);
    return wrap;
  }
  function rebuildDayLabels() {
    list.querySelectorAll(".day").forEach((node) => node.remove());
    let previous = "";
    for (const message of list.querySelectorAll(".message")) {
      const day = dayLabel(new Date(message.querySelector("time").dateTime));
      if (day !== previous) {
        const label = document.createElement("div");
        label.className = "day";
        label.textContent = day;
        message.before(label);
        previous = day;
      }
    }
  }
  function updateOlderButton() {
    $("load-older")?.remove();
    if (!moreBefore || !oldestId) return;
    const button = document.createElement("button");
    button.id = "load-older";
    button.type = "button";
    button.className = "load-older";
    button.textContent = "查看更早消息";
    button.addEventListener("click", loadOlder);
    list.prepend(button);
  }
  function insertMessages(messages, prepend = false) {
    if (!messages.length) return;
    $("chat-empty")?.remove();
    const oldHeight = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    const wasEmpty = seen.size === 0;
    for (const message of prepend ? [...messages].reverse() : messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      latestId = Math.max(latestId, message.id);
      oldestId = oldestId ? Math.min(oldestId, message.id) : message.id;
      if (prepend) list.prepend(messageNode(message));
      else list.append(messageNode(message));
    }
    rebuildDayLabels();
    updateOlderButton();
    if (prepend) scroller.scrollTop = oldTop + scroller.scrollHeight - oldHeight;
    else if (atBottom || wasEmpty) scroller.scrollTop = scroller.scrollHeight;
  }
  function unauthorized(error) {
    if (error.status !== 401 || !currentRoom) return false;
    const room = { ...currentRoom, unlocked: false };
    currentRoom = null;
    $("chat").hidden = true;
    $("home").hidden = false;
    chooseRoom(room);
    return true;
  }
  async function loadInitial() {
    if (!currentRoom || loading) return;
    const roomId = currentRoom.id;
    loading = true;
    try {
      const value = await api("/api/rooms/" + roomId + "/messages");
      if (currentRoom?.id !== roomId) return;
      moreBefore = value.hasMore;
      insertMessages(value.messages);
      connection(true, "已同步 · 自动更新");
      hint.textContent = "Enter 发送 · Shift + Enter 换行";
      hint.classList.remove("error");
    } catch (error) {
      if (!unauthorized(error)) {
        connection(false, "连接失败，正在重试");
        hint.textContent = error.message;
        hint.classList.add("error");
      }
    } finally { loading = false; }
  }
  async function loadNew() {
    if (!currentRoom || loading) return;
    if (!latestId) return loadInitial();
    const roomId = currentRoom.id;
    loading = true;
    try {
      let more = true;
      while (more && currentRoom?.id === roomId) {
        const value = await api("/api/rooms/" + roomId + "/messages?after=" + latestId);
        insertMessages(value.messages);
        more = value.hasMore && value.messages.length > 0;
      }
      connection(true, "已同步 · 自动更新");
    } catch (error) {
      if (!unauthorized(error)) connection(false, "连接失败，正在重试");
    } finally { loading = false; }
  }
  async function loadOlder() {
    if (!currentRoom || loading) return;
    loading = true;
    if ($("load-older")) $("load-older").textContent = "加载中…";
    try {
      const value = await api("/api/rooms/" + currentRoom.id + "/messages?before=" + oldestId);
      moreBefore = value.hasMore;
      insertMessages(value.messages, true);
    } catch { notify("加载失败，请重试"); }
    finally { loading = false; updateOlderButton(); }
  }
  async function send() {
    const body = input.value.trim();
    if (!body || sending || !currentRoom) return;
    sending = true;
    $("send-button").disabled = true;
    try {
      const value = await api("/api/rooms/" + currentRoom.id + "/messages", {
        method: "POST",
        body: JSON.stringify({ body, sender: deviceName, clientId: deviceId }),
      });
      input.value = "";
      resize();
      insertMessages([value.message]);
      connection(true, "已同步 · 自动更新");
      hint.textContent = "Enter 发送 · Shift + Enter 换行";
      hint.classList.remove("error");
    } catch (error) {
      if (!unauthorized(error)) {
        hint.textContent = error.message;
        hint.classList.add("error");
        notify("发送失败：" + error.message);
      }
    } finally {
      sending = false;
      $("send-button").disabled = false;
      input.focus();
    }
  }
  function resize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 170) + "px";
  }
  async function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const area = document.createElement("textarea");
    area.value = value;
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("copy");
  }
  async function share() {
    if (!currentRoom) return;
    const url = roomUrl(currentRoom.id);
    try {
      if (navigator.share) await navigator.share({ title: currentRoom.name, text: "打开房间后输入 6 位密码", url });
      else { await copyText(url); notify("房间地址已复制，密码需单独告知"); }
    } catch (error) {
      if (error.name === "AbortError") return;
      try { await copyText(url); notify("房间地址已复制，密码需单独告知"); }
      catch { notify("分享失败，请复制地址栏中的房间地址"); }
    }
  }
  function openCreate() {
    $("create-form").reset();
    $("create-error").textContent = "";
    $("create-dialog").showModal();
    $("room-name").focus();
  }
  async function createRoom(event) {
    event.preventDefault();
    const name = $("room-name").value.trim();
    const pin = $("create-pin").value;
    const confirmation = $("confirm-pin").value;
    if (!/^[0-9]{6}$/.test(pin) || pin !== confirmation) {
      $("create-error").textContent = "两次输入的 6 位数字密码不一致";
      return;
    }
    $("create-pin").value = "";
    $("confirm-pin").value = "";
    $("submit-create").disabled = true;
    try {
      const value = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name, pin }) });
      $("create-dialog").close();
      rooms.unshift(value.room);
      renderRooms();
      enterRoom(value.room);
      notify("房间已创建，请记住密码");
    } catch (error) { $("create-error").textContent = error.message; }
    finally { $("submit-create").disabled = false; }
  }
  async function unlockRoom(event) {
    event.preventDefault();
    if (!pendingRoom) return;
    const pin = $("unlock-pin").value;
    $("unlock-pin").value = "";
    $("submit-unlock").disabled = true;
    try {
      const value = await api("/api/rooms/" + pendingRoom.id + "/unlock", { method: "POST", body: JSON.stringify({ pin }) });
      const room = { ...pendingRoom, ...value.room, unlocked: true };
      rooms = rooms.map((item) => item.id === room.id ? room : item);
      $("unlock-dialog").close();
      renderRooms();
      enterRoom(room);
    } catch (error) { $("unlock-error").textContent = error.message; }
    finally { $("submit-unlock").disabled = false; }
  }
  async function importLegacy() {
    if (!legacyKey || !currentRoom) return;
    $("import-legacy").disabled = true;
    try {
      const value = await api("/api/rooms/" + currentRoom.id + "/import-legacy", {
        method: "POST",
        body: JSON.stringify({ legacyKey }),
      });
      legacyKey = null;
      $("legacy-home").hidden = true;
      $("legacy-chat").hidden = true;
      resetMessages();
      await loadInitial();
      notify(value.alreadyImported ? "旧历史此前已导入" : "已导入 " + value.imported + " 条旧消息");
    } catch (error) { notify("导入失败：" + error.message); }
    finally { $("import-legacy").disabled = false; }
  }

  $("new-room-top").addEventListener("click", openCreate);
  $("refresh-rooms").addEventListener("click", loadRooms);
  $("cancel-create").addEventListener("click", () => { $("create-form").reset(); $("create-dialog").close(); });
  $("cancel-unlock").addEventListener("click", () => { $("unlock-pin").value = ""; $("unlock-dialog").close(); });
  $("create-form").addEventListener("submit", createRoom);
  $("unlock-form").addEventListener("submit", unlockRoom);
  $("back-home").addEventListener("click", () => showHome());
  $("share-button").addEventListener("click", share);
  $("import-legacy").addEventListener("click", importLegacy);
  $("composer-form").addEventListener("submit", (event) => { event.preventDefault(); send(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  });
  input.addEventListener("input", resize);
  $("name-button").addEventListener("click", () => { $("device-name").value = deviceName; $("name-dialog").showModal(); });
  $("name-form").addEventListener("submit", (event) => {
    if (event.submitter?.value !== "save") return;
    const next = $("device-name").value.trim();
    if (next) {
      deviceName = next.slice(0, 20);
      localStorage.setItem("transfer-device-name", deviceName);
      notify("设备名称已保存");
    }
  });
  window.addEventListener("online", loadNew);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadNew(); });
  window.addEventListener("popstate", () => {
    const requested = new URLSearchParams(location.search).get("room");
    if (!requested) showHome(false);
    else if (currentRoom?.id !== requested) {
      const room = rooms.find((item) => item.id === requested);
      if (room) chooseRoom(room);
    }
  });
  loadRooms();
  setInterval(() => { if (!document.hidden) loadNew(); }, 3000);
})();

