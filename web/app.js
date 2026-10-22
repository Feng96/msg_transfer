(() => {
  const $ = (id) => document.getElementById(id);
  const list = $("message-list");
  const scroller = $("messages");
  const input = $("message-input");
  const hint = $("composer-status");
  const deviceId = localStorage.getItem("transfer-device-id") || crypto.randomUUID();
  localStorage.setItem("transfer-device-id", deviceId);
  let deviceName = localStorage.getItem("transfer-device-name") || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "我的手机" : "我的电脑");
  let roomKey = location.hash.match(/^#r=([A-Za-z0-9_-]{43})$/)?.[1] || localStorage.getItem("transfer-room-key");
  if (!roomKey || !/^[A-Za-z0-9_-]{43}$/.test(roomKey)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    roomKey = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  localStorage.setItem("transfer-room-key", roomKey);
  history.replaceState(null, "", location.pathname + location.search + "#r=" + roomKey);

  let latestId = 0;
  let oldestId = 0;
  let moreBefore = false;
  let loading = false;
  let sending = false;
  let toastTimer;
  const seen = new Set();
  const roomLink = () => location.origin + location.pathname + "#r=" + roomKey;
  const dayLabel = (date) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
  const timeLabel = (date) => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);

  function notify(text) {
    const toast = $("toast");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }
  function connection(connected, text) {
    $("status-dot").classList.toggle("offline", !connected);
    $("status-text").textContent = text;
  }
  function appendSafeText(container, text) {
    const regex = /https?:\/\/[^\s<>"']+/g;
    let cursor = 0;
    for (const match of text.matchAll(regex)) {
      if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
      const a = document.createElement("a");
      a.href = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[0];
      container.append(a);
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
    list.querySelectorAll(".day").forEach((e) => e.remove());
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
    $("intro")?.remove();
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
  async function requestMessages(query = "") {
    const response = await fetch("/api/messages" + query, { headers: { "X-Room-Key": roomKey }, cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "读取失败");
    return value;
  }
  async function loadInitial() {
    if (loading) return;
    loading = true;
    try {
      const value = await requestMessages();
      moreBefore = value.hasMore;
      insertMessages(value.messages);
      connection(true, "已同步 · 自动更新");
      hint.textContent = "Enter 发送 · Shift + Enter 换行";
      hint.classList.remove("error");
    } catch (error) {
      connection(false, "连接失败，正在重试");
      hint.textContent = error.message;
      hint.classList.add("error");
    } finally { loading = false; }
  }
  async function loadNew() {
    if (loading) return;
    if (!latestId) return loadInitial();
    loading = true;
    try {
      let more = true;
      while (more) {
        const value = await requestMessages("?after=" + latestId);
        insertMessages(value.messages);
        more = value.hasMore && value.messages.length > 0;
      }
      connection(true, "已同步 · 自动更新");
      hint.textContent = "Enter 发送 · Shift + Enter 换行";
      hint.classList.remove("error");
    } catch {
      connection(false, "连接失败，正在重试");
    } finally { loading = false; }
  }
  async function loadOlder() {
    if (loading) return;
    loading = true;
    if ($("load-older")) $("load-older").textContent = "加载中…";
    try {
      const value = await requestMessages("?before=" + oldestId);
      moreBefore = value.hasMore;
      insertMessages(value.messages, true);
    } catch { notify("加载失败，请重试"); }
    finally { loading = false; updateOlderButton(); }
  }
  async function send() {
    const body = input.value.trim();
    if (!body || sending) return;
    sending = true;
    $("send-button").disabled = true;
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "X-Room-Key": roomKey, "Content-Type": "application/json" },
        body: JSON.stringify({ body, sender: deviceName, clientId: deviceId }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "发送失败");
      input.value = "";
      resize();
      insertMessages([value.message]);
      hint.textContent = "Enter 发送 · Shift + Enter 换行";
      hint.classList.remove("error");
      connection(true, "已同步 · 自动更新");
    } catch (error) {
      hint.textContent = error.message;
      hint.classList.add("error");
      notify("发送失败：" + error.message);
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
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy");
  }
  async function share() {
    const url = roomLink();
    try {
      if (navigator.share) await navigator.share({ title: "消息传输助手", text: "打开这个链接，查看同一段聊天", url });
      else { await copyText(url); notify("完整房间链接已复制"); }
    } catch (error) {
      if (error.name === "AbortError") return;
      try { await copyText(url); notify("完整房间链接已复制"); }
      catch { notify("分享失败，请复制地址栏中的完整链接"); }
    }
  }
  $("composer-form").addEventListener("submit", (event) => { event.preventDefault(); send(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  });
  input.addEventListener("input", resize);
  for (const id of ["share-button", "side-copy", "intro-share"]) $(id).addEventListener("click", share);
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
  loadInitial();
  setInterval(() => { if (!document.hidden) loadNew(); }, 3000);
})();

