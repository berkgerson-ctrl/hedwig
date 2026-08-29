/* ============================================================
   HEDWIG — app.js
   ------------------------------------------------------------
   1. Fill in your Firebase config below (FIREBASE_CONFIG).
   2. In the Firebase console, create a Cloud Firestore database
      (start in "production mode") and use the security rules in
      the comment block at the bottom of this file as a start.
   3. That's it — no build step. This file talks to Firestore
      directly via the CDN SDKs loaded in index.html.

   A note on push notifications: this file shows a real, working
   notification the moment a new message arrives *while the app
   is open* (foreground or backgrounded tab/PWA) using the
   Notification API + Service Worker. Truly waking the device
   when Hedwig is fully closed / the screen is locked needs
   Firebase Cloud Messaging plus a small server-side trigger
   (a Cloud Function that fires on a new Firestore message and
   sends an FCM push) — that requires a paid Firebase plan and
   is outside what a static GitHub Pages site can do alone. Say
   the word if you'd like help wiring that up next.
   ============================================================ */

// ------------------------------------------------------------------
// 🔧 PLACEHOLDER — replace with your own Firebase project config.
// Firebase Console → Project settings → General → Your apps → Web app
// ------------------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyDgPLFZn7F70dT0FNrpYRB03kGkXgpLol0",
    authDomain: "hedwig-11987.firebaseapp.com",
    databaseURL: "https://hedwig-11987-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "hedwig-11987",
    storageBucket: "hedwig-11987.firebasestorage.app",
    messagingSenderId: "472147538639",
    appId: "1:472147538639:web:91d280ae95d7f0e3b43dba",
    measurementId: "G-D125ML4NM4"
  };
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;

// ------------------------------------------------------------------
// Session (localStorage) — keeps the user logged in on their phone
// ------------------------------------------------------------------
const SESSION_KEY = "hedwig_session";
const NOTIF_BANNER_DISMISSED_KEY = "hedwig_notif_banner_dismissed";

let currentUser = null;        // { username, name, surname, avatarUrl }
let unsubChats = null;
let unsubMessages = null;
let activeChatId = null;
let activeChatPartner = null;  // profile of the other participant in the open room
let chatsCache = [];           // latest rendered (visible) chat list, for the notif dropdown
let chatsFirstLoadDone = false;
let lastKnownMillis = new Map(); // chatId -> lastMessageAt millis, used to detect genuinely new messages
let editingMessageId = null;
let activeMenuMessage = null;  // { id, read, sender }
let currentRoomMessagesCache = [];
const userCache = new Map();   // username -> profile, avoids refetching

function saveSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ------------------------------------------------------------------
// Password hashing (SHA-256 via SubtleCrypto). Lightweight deterrent,
// not a replacement for Firebase Auth — fine for a private family
// app; swap in real Firebase Auth for anything more sensitive.
// ------------------------------------------------------------------
async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------
// View router, with hardware/software back-button support.
// navigateTo() pushes a history entry for "detail" views (room,
// contacts, profile) so the phone's back gesture returns to the
// chats feed instead of leaving the app.
// ------------------------------------------------------------------
const views = ["auth", "chats", "contacts", "room", "profile"];
function showView(name) {
  views.forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle("hidden", v !== name);
  });
  document.getElementById("settings-menu").classList.add("hidden");
  document.getElementById("notif-menu").classList.add("hidden");
}

function navigateTo(view) {
  showView(view);
  if (view === "chats") {
    if (!history.state || history.state.hedwigView !== "chats") {
      history.replaceState({ hedwigView: "chats" }, "", "#chats");
    }
  } else {
    history.pushState({ hedwigView: view }, "", "#" + view);
  }
}

window.addEventListener("popstate", () => {
  // Any back navigation (hardware back button / swipe) returns to the
  // chats feed and tears down whatever detail view was open.
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  activeChatId = null;
  closeMessageMenu();
  document.getElementById("friend-profile-modal").classList.add("hidden");
  document.getElementById("confirm-modal").classList.add("hidden");
  if (currentUser) showView("chats");
});

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

// ------------------------------------------------------------------
// Generic confirm modal
// ------------------------------------------------------------------
function showConfirm({ title, body, okLabel = "Remove", onConfirm }) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-body").textContent = body;
  const okBtn = document.getElementById("confirm-ok");
  okBtn.textContent = okLabel;
  document.getElementById("confirm-modal").classList.remove("hidden");

  const cleanup = () => {
    document.getElementById("confirm-modal").classList.add("hidden");
    okBtn.removeEventListener("click", onOk);
    document.getElementById("confirm-cancel").removeEventListener("click", onCancel);
    document.getElementById("confirm-backdrop").removeEventListener("click", onCancel);
  };
  const onOk = () => { cleanup(); onConfirm(); };
  const onCancel = () => cleanup();

  okBtn.addEventListener("click", onOk);
  document.getElementById("confirm-cancel").addEventListener("click", onCancel);
  document.getElementById("confirm-backdrop").addEventListener("click", onCancel);
}

// ------------------------------------------------------------------
// Long-press helper — fires onLongPress after ~480ms of holding
// still, falls back to onClick for a normal tap.
// ------------------------------------------------------------------
function bindLongPress(el, onLongPress, onClick) {
  let timer = null;
  let moved = false;
  let startX = 0, startY = 0;

  const start = (e) => {
    moved = false;
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX; startY = p.clientY;
    timer = setTimeout(() => { timer = null; onLongPress(e); }, 480);
  };
  const move = (e) => {
    const p = e.touches ? e.touches[0] : e;
    if (Math.abs(p.clientX - startX) > 10 || Math.abs(p.clientY - startY) > 10) {
      moved = true;
      clearTimeout(timer);
    }
  };
  const end = (e) => {
    if (timer) {
      clearTimeout(timer);
      if (!moved && onClick) onClick(e);
    }
  };
  const cancel = () => clearTimeout(timer);

  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: true });
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", cancel);
  el.addEventListener("mousedown", start);
  el.addEventListener("mousemove", move);
  el.addEventListener("mouseup", end);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ============================================================
// BOOT
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
  wireAuthForm();
  wireChatsHome();
  wireContacts();
  wireRoom();
  wireProfile();
  wireMessageMenu();
  wireFriendProfileModal();
  wireNotifications();
  registerServiceWorker();

  const session = loadSession();
  if (session && session.username) {
    db.collection("users").doc(session.username).get().then(doc => {
      if (doc.exists) {
        currentUser = { username: doc.id, ...doc.data() };
        delete currentUser.passwordHash;
        saveSession(currentUser);
        enterApp();
      } else {
        clearSession();
        showView("auth");
      }
    }).catch(() => showView("auth"));
  } else {
    showView("auth");
  }
});

function enterApp() {
  document.getElementById("profile-username-label").textContent = "@" + currentUser.username;
  history.replaceState({ hedwigView: "chats" }, "", "#chats");
  showView("chats");
  listenToChats();
  maybeShowNotifBanner();
}

// ============================================================
// AUTH
// ============================================================
function wireAuthForm() {
  const tabLogin = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const formLogin = document.getElementById("form-login");
  const formRegister = document.getElementById("form-register");

  function setTab(which) {
    tabLogin.classList.toggle("active", which === "login");
    tabRegister.classList.toggle("active", which === "register");
    formLogin.classList.toggle("hidden", which !== "login");
    formRegister.classList.toggle("hidden", which !== "register");
  }
  tabLogin.addEventListener("click", () => setTab("login"));
  tabRegister.addEventListener("click", () => setTab("register"));
  setTab("login");

  formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.classList.add("hidden");
    const username = document.getElementById("login-username").value.trim().toLowerCase();
    const password = document.getElementById("login-password").value;
    if (!username || !password) return;

    try {
      const doc = await db.collection("users").doc(username).get();
      if (!doc.exists) throw new Error("No account with that username.");
      const data = doc.data();
      const hash = await hashPassword(password);
      if (hash !== data.passwordHash) throw new Error("Incorrect password.");

      currentUser = { username: doc.id, name: data.name, surname: data.surname, avatarUrl: data.avatarUrl || "" };
      saveSession(currentUser);
      formLogin.reset();
      enterApp();
    } catch (err) {
      errEl.textContent = err.message || "Couldn't log in.";
      errEl.classList.remove("hidden");
    }
  });

  formRegister.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("register-error");
    errEl.classList.add("hidden");

    const name = document.getElementById("reg-name").value.trim();
    const surname = document.getElementById("reg-surname").value.trim();
    const username = document.getElementById("reg-username").value.trim().toLowerCase().replace(/\s+/g, "");
    const avatarUrl = document.getElementById("reg-avatar").value.trim();
    const password = document.getElementById("reg-password").value;

    if (!name || !surname || !username || !password) return;
    if (password.length < 6) {
      errEl.textContent = "Password must be at least 6 characters.";
      errEl.classList.remove("hidden");
      return;
    }
    if (!/^[a-z0-9_.]+$/.test(username)) {
      errEl.textContent = "Usernames can only contain letters, numbers, dots and underscores.";
      errEl.classList.remove("hidden");
      return;
    }

    try {
      const ref = db.collection("users").doc(username);
      const existing = await ref.get();
      if (existing.exists) throw new Error("That username is already taken.");

      const passwordHash = await hashPassword(password);
      const fallbackAvatar = `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(username)}`;
      const profile = {
        name, surname,
        avatarUrl: avatarUrl || fallbackAvatar,
        passwordHash,
        createdAt: FieldValue.serverTimestamp(),
      };
      await ref.set(profile);

      currentUser = { username, name, surname, avatarUrl: profile.avatarUrl };
      saveSession(currentUser);
      formRegister.reset();
      enterApp();
    } catch (err) {
      errEl.textContent = err.message || "Couldn't create that account.";
      errEl.classList.remove("hidden");
    }
  });
}

// ============================================================
// CHATS HOME
// ============================================================
function wireChatsHome() {
  document.getElementById("btn-settings").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("notif-menu").classList.add("hidden");
    document.getElementById("settings-menu").classList.toggle("hidden");
  });
  document.getElementById("btn-bell").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("settings-menu").classList.add("hidden");
    renderNotifDropdown();
    document.getElementById("notif-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    const sMenu = document.getElementById("settings-menu");
    const sBtn = document.getElementById("btn-settings");
    if (!sMenu.contains(e.target) && !sBtn.contains(e.target)) sMenu.classList.add("hidden");
    const nMenu = document.getElementById("notif-menu");
    const nBtn = document.getElementById("btn-bell");
    if (!nMenu.contains(e.target) && !nBtn.contains(e.target)) nMenu.classList.add("hidden");
  });
  document.getElementById("menu-profile").addEventListener("click", () => openProfile());
  document.getElementById("menu-logout").addEventListener("click", () => {
    if (unsubChats) unsubChats();
    clearSession();
    currentUser = null;
    showView("auth");
  });
  document.getElementById("fab-add").addEventListener("click", () => {
    document.getElementById("contact-search").value = "";
    document.getElementById("contact-result").innerHTML = "";
    document.getElementById("contact-status").textContent = "";
    navigateTo("contacts");
  });
}

function chatIdFor(userA, userB) {
  return [userA, userB].sort().join("__");
}

async function getUserProfile(username) {
  if (userCache.has(username)) return userCache.get(username);
  const doc = await db.collection("users").doc(username).get();
  const profile = doc.exists ? { username, ...doc.data() } : { username, name: username, surname: "", avatarUrl: "" };
  userCache.set(username, profile);
  return profile;
}

function listenToChats() {
  if (unsubChats) unsubChats();
  chatsFirstLoadDone = false;
  unsubChats = db.collection("chats")
    .where("participants", "array-contains", currentUser.username)
    .onSnapshot(async (snap) => {
      checkForNewMessageNotifications(snap);

      const chats = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c => !(c.hiddenFor || []).includes(currentUser.username));
      chats.sort((a, b) => (b.lastMessageAt?.toMillis?.() || 0) - (a.lastMessageAt?.toMillis?.() || 0));
      await renderChatList(chats);
      chatsFirstLoadDone = true;
    }, (err) => console.error("chats listener error:", err));
}

async function renderChatList(chats) {
  const list = document.getElementById("chat-list");
  const empty = document.getElementById("chats-empty");

  if (chats.length === 0) {
    list.innerHTML = "";
    list.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.classList.add("flex");
    chatsCache = [];
    setBell(false);
    return;
  }
  list.classList.remove("hidden");
  empty.classList.add("hidden");
  empty.classList.remove("flex");

  let anyUnread = false;
  const enriched = await Promise.all(chats.map(async (chat) => {
    const otherUsername = chat.participants.find(p => p !== currentUser.username);
    const other = await getUserProfile(otherUsername);
    const unread = (chat.unread && chat.unread[currentUser.username]) || 0;
    if (unread > 0) anyUnread = true;
    return { ...chat, other, unread };
  }));
  chatsCache = enriched;

  document.getElementById("chat-list").innerHTML = enriched.map((chat) => {
    const time = chat.lastMessageAt?.toDate ? formatTime(chat.lastMessageAt.toDate()) : "";
    return `
      <div class="chat-card" data-chat-id="${chat.id}" data-username="${chat.other.username}">
        <img src="${escapeAttr(chat.other.avatarUrl)}" class="w-11 h-11 rounded-full object-cover border border-border shrink-0" alt="" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <p class="font-semibold text-sm truncate">${escapeHtml(chat.other.name)} ${escapeHtml(chat.other.surname || "")}</p>
            <span class="text-[11px] text-inksoft shrink-0">${time}</span>
          </div>
          <p class="text-xs text-inksoft truncate mt-0.5">${escapeHtml(chat.lastMessage || "Say hello 👋")}</p>
        </div>
        ${chat.unread > 0 ? `<span class="unread-badge shrink-0">${chat.unread > 99 ? "99+" : chat.unread}</span>` : ""}
      </div>`;
  }).join("");

  setBell(anyUnread);

  document.querySelectorAll(".chat-card").forEach(card => {
    bindLongPress(
      card,
      () => confirmHideChat(card.dataset.chatId, card.dataset.username),
      () => openRoom(card.dataset.chatId, card.dataset.username)
    );
  });
}

function confirmHideChat(chatId, otherUsername) {
  const chat = chatsCache.find(c => c.id === chatId);
  const name = chat ? `${chat.other.name} ${chat.other.surname || ""}`.trim() : otherUsername;
  showConfirm({
    title: "Remove from feed?",
    body: `"${name}" will disappear from your chat list. Your messages stay saved — opening a new chat with them brings the whole history back.`,
    okLabel: "Remove",
    onConfirm: async () => {
      await db.collection("chats").doc(chatId).update({
        hiddenFor: FieldValue.arrayUnion(currentUser.username),
      });
      toast("Removed from feed");
    },
  });
}

function setBell(active) {
  document.getElementById("bell-dot").classList.toggle("hidden", !active);
}

// ============================================================
// NOTIFICATION DROPDOWN (bell)
// ============================================================
function renderNotifDropdown() {
  const heading = document.getElementById("notif-heading");
  const list = document.getElementById("notif-list");

  if (chatsCache.length === 0) {
    heading.textContent = "Notifications";
    list.innerHTML = `<p class="notif-empty">Nothing yet — start a chat!</p>`;
    return;
  }

  const unreadChats = chatsCache.filter(c => c.unread > 0);
  const showingUnread = unreadChats.length > 0;
  const items = showingUnread ? unreadChats : chatsCache.slice(0, 5);

  heading.textContent = showingUnread ? "Unread messages" : "Recent activity";
  list.innerHTML = items.map(chat => `
    <button class="notif-item" data-chat-id="${chat.id}" data-username="${chat.other.username}">
      <img src="${escapeAttr(chat.other.avatarUrl)}" class="notif-avatar" alt="" />
      <span class="min-w-0 flex-1">
        <span class="notif-name block truncate">${escapeHtml(chat.other.name)} ${escapeHtml(chat.other.surname || "")}</span>
        <span class="notif-text block truncate">${escapeHtml(chat.lastMessage || "Say hello 👋")}</span>
      </span>
      ${chat.unread > 0 ? `<span class="unread-badge shrink-0">${chat.unread > 99 ? "99+" : chat.unread}</span>` : ""}
    </button>
  `).join("");

  list.querySelectorAll(".notif-item").forEach(item => {
    item.addEventListener("click", () => {
      document.getElementById("notif-menu").classList.add("hidden");
      openRoom(item.dataset.chatId, item.dataset.username);
    });
  });
}

// ============================================================
// CONTACTS (start a new chat) — partial match on username/name/surname
// ============================================================
function wireContacts() {
  document.getElementById("back-contacts").addEventListener("click", () => history.back());

  let debounceTimer;
  document.getElementById("contact-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    const value = e.target.value.trim().toLowerCase();
    debounceTimer = setTimeout(() => searchContacts(value), 300);
  });
}

async function searchContacts(query) {
  const statusEl = document.getElementById("contact-status");
  const resultEl = document.getElementById("contact-result");
  resultEl.innerHTML = "";

  if (!query) { statusEl.textContent = ""; return; }

  statusEl.textContent = "Searching…";
  try {
    // Small family-scale dataset — fetch once and filter client-side so
    // partial matches on username, first name, or surname all work.
    const snap = await db.collection("users").get();
    const matches = snap.docs
      .map(d => ({ username: d.id, ...d.data() }))
      .filter(u => u.username !== currentUser.username)
      .filter(u =>
        u.username.toLowerCase().includes(query) ||
        (u.name || "").toLowerCase().includes(query) ||
        (u.surname || "").toLowerCase().includes(query)
      )
      .slice(0, 12);

    if (matches.length === 0) {
      statusEl.textContent = "No family member matches that.";
      return;
    }
    statusEl.textContent = "";
    resultEl.innerHTML = matches.map(u => `
      <div class="chat-card mb-2" data-username="${u.username}">
        <img src="${escapeAttr(u.avatarUrl)}" class="w-11 h-11 rounded-full object-cover border border-border" alt="" />
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm truncate">${escapeHtml(u.name)} ${escapeHtml(u.surname || "")}</p>
          <p class="text-xs text-inksoft truncate">@${escapeHtml(u.username)}</p>
        </div>
        <span class="text-xs font-semibold text-amber shrink-0">Chat →</span>
      </div>`).join("");

    resultEl.querySelectorAll(".chat-card").forEach(card => {
      card.addEventListener("click", () => startChatWith(card.dataset.username));
    });
  } catch (err) {
    statusEl.textContent = "Couldn't search right now.";
  }
}

async function startChatWith(otherUsername) {
  const id = chatIdFor(currentUser.username, otherUsername);
  const ref = db.collection("chats").doc(id);
  const existing = await ref.get();

  if (!existing.exists) {
    await ref.set({
      participants: [currentUser.username, otherUsername],
      lastMessage: "",
      lastMessageAt: FieldValue.serverTimestamp(),
      lastSender: null,
      unread: { [currentUser.username]: 0, [otherUsername]: 0 },
      hiddenFor: [],
      createdAt: FieldValue.serverTimestamp(),
    });
  } else if ((existing.data().hiddenFor || []).includes(currentUser.username)) {
    // Chat existed but I'd removed it from my feed — bring it (and its
    // full history) back rather than losing anything.
    await ref.update({ hiddenFor: FieldValue.arrayRemove(currentUser.username) });
  }
  openRoom(id, otherUsername);
}

// ============================================================
// CHAT ROOM
// ============================================================
function wireRoom() {
  document.getElementById("back-room").addEventListener("click", () => history.back());

  document.getElementById("room-identity").addEventListener("click", () => openFriendProfile(activeChatPartner));

  document.getElementById("form-message").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (!text || !activeChatId) return;
    input.value = "";
    await sendMessage(text);
  });
}

async function openRoom(chatId, otherUsername) {
  activeChatId = chatId;
  editingMessageId = null;
  activeChatPartner = await getUserProfile(otherUsername);

  document.getElementById("room-avatar").src = activeChatPartner.avatarUrl || "";
  document.getElementById("room-name").textContent = `${activeChatPartner.name} ${activeChatPartner.surname || ""}`.trim();
  document.getElementById("room-username").textContent = "@" + activeChatPartner.username;

  navigateTo("room");
  document.getElementById("room-messages").innerHTML = "";

  // Mark the chat-list badge as read for me.
  db.collection("chats").doc(chatId).update({ [`unread.${currentUser.username}`]: 0 }).catch(() => {});

  if (unsubMessages) unsubMessages();
  unsubMessages = db.collection("chats").doc(chatId).collection("messages")
    .orderBy("createdAt", "asc")
    .onSnapshot((snap) => {
      const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderMessages(messages);

      // Auto read-receipt: opening the room marks the partner's messages
      // read. The long-press menu still lets either side flip this back.
      const unreadFromPartner = messages.filter(m => m.sender === otherUsername && m.read === false);
      if (unreadFromPartner.length) {
        const batch = db.batch();
        unreadFromPartner.forEach(m => {
          batch.update(db.collection("chats").doc(chatId).collection("messages").doc(m.id), { read: true });
        });
        batch.commit().catch(() => {});
      }
      db.collection("chats").doc(chatId).update({ [`unread.${currentUser.username}`]: 0 }).catch(() => {});
    }, (err) => console.error("messages listener error:", err));
}

function renderMessages(messages) {
  const wrap = document.getElementById("room-messages");
  const wasNearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;

  wrap.innerHTML = messages.map(m => {
    const mine = m.sender === currentUser.username;
    const sender = mine ? currentUser : activeChatPartner;
    const time = m.createdAt?.toDate ? formatTime(m.createdAt.toDate()) : "";
    const preview = m.linkPreview ? renderLinkPreview(m.linkPreview) : "";
    const editedTag = m.edited ? `<span class="msg-edited">edited</span>` : "";

    if (m.id === editingMessageId) {
      return `
        <div class="bubble-row ${mine ? "mine" : "theirs"}" data-msg-id="${m.id}">
          <img src="${escapeAttr(sender?.avatarUrl)}" class="w-7 h-7 rounded-full object-cover border border-border shrink-0 mb-0.5" alt="" />
          <div class="bubble-edit-wrap">
            <input type="text" class="bubble-edit-input" id="edit-input-${m.id}" value="${escapeAttr(m.text)}" />
            <button class="bubble-edit-btn save" data-action="save-edit" data-msg-id="${m.id}">
              <img src="https://api.iconify.design/mdi/check.svg?color=%23FFFFFF" class="w-3.5 h-3.5" alt="Save" />
            </button>
            <button class="bubble-edit-btn cancel" data-action="cancel-edit">
              <img src="https://api.iconify.design/mdi/close.svg?color=%232A241C" class="w-3.5 h-3.5" alt="Cancel" />
            </button>
          </div>
        </div>`;
    }

    const ticks = mine ? `
      <span class="msg-ticks ${m.read ? "" : "unread"}">
        <img src="https://api.iconify.design/mdi/check-all.svg?color=${m.read ? "%23C9821F" : "%238A8175"}" class="w-3.5 h-3.5" alt="${m.read ? "Read" : "Unread"}" />
      </span>` : "";

    return `
      <div class="bubble-row ${mine ? "mine" : "theirs"}" data-msg-id="${m.id}" data-read="${!!m.read}" data-sender="${m.sender}">
        <img src="${escapeAttr(sender?.avatarUrl)}" class="w-7 h-7 rounded-full object-cover border border-border shrink-0 mb-0.5" alt="" />
        <div>
          <div class="bubble">${escapeHtml(m.text)}</div>
          ${preview}
          <div class="bubble-time ${mine ? "text-right" : ""}">${time}${editedTag}${ticks}</div>
        </div>
      </div>`;
  }).join("");

  if (wasNearBottom) wrap.scrollTop = wrap.scrollHeight;

  wrap.querySelectorAll(".bubble-row[data-msg-id]").forEach(row => {
    const msgId = row.dataset.msgId;
    if (msgId === editingMessageId) return;
    const bubbleEl = row.querySelector(".bubble");
    if (!bubbleEl) return;
    bindLongPress(bubbleEl, (e) => {
      openMessageMenu(e, {
        id: msgId,
        read: row.dataset.read === "true",
        sender: row.dataset.sender,
      });
    });
  });

  wrap.querySelectorAll('[data-action="save-edit"]').forEach(btn => {
    btn.addEventListener("click", () => saveMessageEdit(btn.dataset.msgId));
  });
  wrap.querySelectorAll('[data-action="cancel-edit"]').forEach(btn => {
    btn.addEventListener("click", () => { editingMessageId = null; renderMessages(currentRoomMessagesCache); });
  });

  const input = document.getElementById(`edit-input-${editingMessageId}`);
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }

  currentRoomMessagesCache = messages;
}

function renderLinkPreview(lp) {
  return `
    <a href="${escapeAttr(lp.url)}" target="_blank" rel="noopener noreferrer" class="link-preview mt-1.5">
      ${lp.image ? `<img src="${escapeAttr(lp.image)}" alt="" />` : ""}
      <div class="lp-body">
        <p class="lp-title">${escapeHtml(lp.title || lp.url)}</p>
        <p class="lp-domain">${escapeHtml(lp.domain || "")}</p>
      </div>
    </a>`;
}

async function sendMessage(text) {
  const url = extractFirstUrl(text);
  const messagesRef = db.collection("chats").doc(activeChatId).collection("messages");
  const chatRef = db.collection("chats").doc(activeChatId);

  const base = {
    sender: currentUser.username,
    text,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  };
  const msgDoc = await messagesRef.add(base);

  await chatRef.update({
    lastMessage: text,
    lastMessageAt: FieldValue.serverTimestamp(),
    lastSender: currentUser.username,
    [`unread.${activeChatPartner.username}`]: FieldValue.increment(1),
    // A fresh message un-hides the chat for the recipient even if they'd
    // removed it from their feed before.
    hiddenFor: FieldValue.arrayRemove(activeChatPartner.username),
  });

  if (url) {
    const preview = await fetchLinkPreview(url);
    if (preview) msgDoc.update({ linkPreview: preview }).catch(() => {});
  }
}

function extractFirstUrl(text) {
  const match = text.match(/(https?:\/\/[^\s]+)/i);
  return match ? match[0] : null;
}

async function fetchLinkPreview(url) {
  try {
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`);
    const json = await res.json();
    if (json.status !== "success") return null;
    const d = json.data;
    return {
      url,
      title: d.title || url,
      domain: (d.publisher || (new URL(url)).hostname),
      image: d.image?.url || d.logo?.url || "",
    };
  } catch {
    return null;
  }
}

// ============================================================
// MESSAGE ACTION MENU (long-press a bubble)
// ============================================================
function wireMessageMenu() {
  document.getElementById("message-menu-backdrop").addEventListener("click", closeMessageMenu);

  document.getElementById("msg-toggle-read").addEventListener("click", async () => {
    if (!activeMenuMessage) return;
    const { id, read } = activeMenuMessage;
    closeMessageMenu();
    await db.collection("chats").doc(activeChatId).collection("messages").doc(id)
      .update({ read: !read });
  });

  document.getElementById("msg-edit").addEventListener("click", () => {
    if (!activeMenuMessage) return;
    editingMessageId = activeMenuMessage.id;
    closeMessageMenu();
    renderMessages(currentRoomMessagesCache);
  });

  document.getElementById("msg-delete").addEventListener("click", () => {
    if (!activeMenuMessage) return;
    const id = activeMenuMessage.id;
    closeMessageMenu();
    showConfirm({
      title: "Delete this message?",
      body: "It will be removed for everyone in this chat. This can't be undone.",
      okLabel: "Delete",
      onConfirm: async () => {
        await db.collection("chats").doc(activeChatId).collection("messages").doc(id).delete();
      },
    });
  });
}

function openMessageMenu(e, msg) {
  activeMenuMessage = msg;
  const menu = document.getElementById("message-menu");
  const backdrop = document.getElementById("message-menu-backdrop");

  document.getElementById("msg-toggle-read-icon").src =
    `https://api.iconify.design/mdi/${msg.read ? "email-mark-as-unread-outline" : "email-check-outline"}.svg?color=%232A241C`;
  document.getElementById("msg-toggle-read-label").textContent =
    msg.read ? "Mark as unread" : "Mark as read";

  backdrop.classList.remove("hidden");
  menu.classList.remove("hidden");

  const p = e.touches ? (e.changedTouches ? e.changedTouches[0] : e.touches[0]) : e;
  const menuWidth = 208, menuHeight = 150;
  let left = (p?.clientX ?? window.innerWidth / 2) - menuWidth / 2;
  let top = (p?.clientY ?? window.innerHeight / 2) + 12;
  left = Math.max(12, Math.min(left, window.innerWidth - menuWidth - 12));
  top = Math.min(top, window.innerHeight - menuHeight - 12);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeMessageMenu() {
  document.getElementById("message-menu").classList.add("hidden");
  document.getElementById("message-menu-backdrop").classList.add("hidden");
  activeMenuMessage = null;
}

async function saveMessageEdit(msgId) {
  const input = document.getElementById(`edit-input-${msgId}`);
  const text = input ? input.value.trim() : "";
  if (!text) return;
  await db.collection("chats").doc(activeChatId).collection("messages").doc(msgId).update({
    text,
    edited: true,
    editedAt: FieldValue.serverTimestamp(),
  });
  editingMessageId = null;
}

// ============================================================
// FRIEND PROFILE PEEK (tap partner's name in the chat header)
// ============================================================
function wireFriendProfileModal() {
  document.getElementById("friend-profile-close").addEventListener("click", () => {
    document.getElementById("friend-profile-modal").classList.add("hidden");
  });
  document.getElementById("friend-profile-backdrop").addEventListener("click", () => {
    document.getElementById("friend-profile-modal").classList.add("hidden");
  });
}

function openFriendProfile(profile) {
  if (!profile) return;
  document.getElementById("friend-profile-avatar").src = profile.avatarUrl || "";
  document.getElementById("friend-profile-name").textContent = `${profile.name} ${profile.surname || ""}`.trim();
  document.getElementById("friend-profile-username").textContent = "@" + profile.username;
  document.getElementById("friend-profile-modal").classList.remove("hidden");
}

// ============================================================
// PROFILE (my own — editable)
// ============================================================
function wireProfile() {
  document.getElementById("back-profile").addEventListener("click", () => history.back());

  document.getElementById("form-profile").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("profile-name").value.trim();
    const surname = document.getElementById("profile-surname").value.trim();
    const avatarUrl = document.getElementById("profile-avatar").value.trim();
    const statusEl = document.getElementById("profile-status");

    try {
      await db.collection("users").doc(currentUser.username).update({ name, surname, avatarUrl });
      currentUser = { ...currentUser, name, surname, avatarUrl };
      saveSession(currentUser);
      userCache.set(currentUser.username, { username: currentUser.username, name, surname, avatarUrl });
      document.getElementById("profile-avatar-preview").src = avatarUrl;
      statusEl.textContent = "Saved.";
      statusEl.classList.remove("hidden");
      toast("Profile updated");
      setTimeout(() => statusEl.classList.add("hidden"), 1800);
    } catch (err) {
      statusEl.textContent = "Couldn't save right now.";
      statusEl.classList.remove("hidden");
    }
  });
}

function openProfile() {
  document.getElementById("profile-name").value = currentUser.name || "";
  document.getElementById("profile-surname").value = currentUser.surname || "";
  document.getElementById("profile-avatar").value = currentUser.avatarUrl || "";
  document.getElementById("profile-avatar-preview").src = currentUser.avatarUrl || "";
  document.getElementById("profile-username-label").textContent = "@" + currentUser.username;
  navigateTo("profile");
}

// ============================================================
// NOTIFICATIONS (system notification on new incoming messages)
// ============================================================
function wireNotifications() {
  document.getElementById("notif-enable").addEventListener("click", async () => {
    if (!("Notification" in window)) { toast("Notifications aren't supported on this device."); return; }
    const perm = await Notification.requestPermission();
    document.getElementById("notif-banner").classList.add("hidden");
    localStorage.setItem(NOTIF_BANNER_DISMISSED_KEY, "1");
    if (perm === "granted") toast("Notifications enabled");
  });
  document.getElementById("notif-dismiss").addEventListener("click", () => {
    document.getElementById("notif-banner").classList.add("hidden");
    localStorage.setItem(NOTIF_BANNER_DISMISSED_KEY, "1");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open-chat" && event.data.chatId) {
        openRoom(event.data.chatId, event.data.username);
      }
    });
  }
}

function maybeShowNotifBanner() {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  if (localStorage.getItem(NOTIF_BANNER_DISMISSED_KEY)) return;
  document.getElementById("notif-banner").classList.remove("hidden");
}

function checkForNewMessageNotifications(snap) {
  // Skip the very first snapshot after (re)attaching the listener — those
  // are existing chats, not new activity.
  if (!chatsFirstLoadDone) {
    snap.docs.forEach(d => lastKnownMillis.set(d.id, d.data().lastMessageAt?.toMillis?.() || 0));
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  snap.docChanges().forEach(async (change) => {
    if (change.type !== "modified" && change.type !== "added") return;
    const chat = { id: change.doc.id, ...change.doc.data() };
    const millis = chat.lastMessageAt?.toMillis?.() || 0;
    const prevMillis = lastKnownMillis.get(chat.id) || 0;
    lastKnownMillis.set(chat.id, millis);

    if (millis <= prevMillis) return;                       // not actually new
    if (chat.lastSender === currentUser.username) return;    // I sent it
    if ((chat.hiddenFor || []).includes(currentUser.username)) return;

    // Don't interrupt with a notification if I'm already looking at this chat.
    const viewingThisChat = activeChatId === chat.id && document.visibilityState === "visible";
    if (viewingThisChat) return;

    const otherUsername = chat.participants.find(p => p !== currentUser.username);
    const other = await getUserProfile(otherUsername);
    showMessageNotification(other, chat.lastMessage || "New message", chat.id);
  });
}

function showMessageNotification(partner, text, chatId) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = `${partner.name} ${partner.surname || ""}`.trim() || partner.username;
  const body = text.length > 90 ? text.slice(0, 90) + "…" : text;

  const show = (reg) => reg.showNotification(title, {
    body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: "hedwig-chat-" + chatId,
    renotify: true,
    data: { chatId, username: partner.username },
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then(show).catch(() => {
      try { new Notification(title, { body, icon: "icon-192.png" }); } catch {}
    });
  } else {
    try { new Notification(title, { body, icon: "icon-192.png" }); } catch {}
  }
}

// ============================================================
// Helpers
// ============================================================
function formatTime(date) {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const diffDays = Math.round((now - date) / 86400000);
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function escapeHtml(str) {
  return (str ?? "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(str) {
  return escapeHtml(str || "https://api.dicebear.com/7.x/notionists/svg?seed=hedwig");
}

// ============================================================
// PWA — service worker registration
// ============================================================
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW registration failed:", err));
    });
  }
}

/* ============================================================
   Suggested Firestore security rules (Firebase console →
   Firestore Database → Rules). These assume the app-level
   password check above and simply keep chats/messages scoped
   to their participants:

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{username} {
         allow read: if true;                 // needed to look up contacts
         allow create: if request.resource.id == username;
         allow update: if true;               // tighten with real auth if possible
       }
       match /chats/{chatId} {
         allow read, write: if true;          // tighten with real auth if possible
         match /messages/{messageId} {
           allow read, write: if true;
         }
       }
     }
   }

   Note: because this app authenticates with app-level username/
   password (not Firebase Auth), Firestore has no way to verify
   *who* is making a request — these rules can't be scoped to
   "only participants" the way they could with real Firebase Auth.
   For a stronger guarantee, upgrade to Firebase Authentication
   (e.g. anonymous auth + a custom token minted after your
   password check) and reference request.auth.uid in the rules.
   ============================================================ */
