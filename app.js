/* ============================================================
   HEDWIG — app.js
   ------------------------------------------------------------
   1. Fill in your Firebase config below (FIREBASE_CONFIG).
   2. In the Firebase console, create a Cloud Firestore database
      (start in "production mode" and use the security rules at
      the bottom of this file, in the comment block, as a start).
   3. That's it — no build step. This file talks to Firestore
      directly via the CDN SDKs loaded in index.html.
   ============================================================ */

// ------------------------------------------------------------------
// 🔧 PLACEHOLDER — replace with your own Firebase project config.
// Firebase Console → Project settings → General → Your apps → Web app
// ------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDgPLFZn7F70dT0FNrpYRB03kGkXgpLol0",
  authDomain: "hedwig-11987.firebaseapp.com",
  projectId: "hedwig-11987",
  storageBucket: "hedwig-11987.firebasestorage.app",
  messagingSenderId: "472147538639",
  appId: "1:472147538639:web:91d280ae95d7f0e3b43dba",
  measurementId: "G-D125ML4NM4"
};

firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;

// ------------------------------------------------------------------
// Session (localStorage) — keeps the user logged in on their phone
// ------------------------------------------------------------------
const SESSION_KEY = "hedwig_session";
let currentUser = null;       // { username, name, surname, avatarUrl }
let unsubChats = null;
let unsubMessages = null;
let activeChatId = null;
let activeChatPartner = null; // profile of the other participant in the open room
const userCache = new Map();  // username -> profile, avoids refetching

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
// Password hashing (SHA-256 via SubtleCrypto). This is a lightweight
// deterrent, not a replacement for Firebase Auth — good enough for a
// private family app, but swap in real Firebase Auth for anything
// more sensitive.
// ------------------------------------------------------------------
async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------
// View router — simple show/hide of the pre-built containers in
// index.html.
// ------------------------------------------------------------------
const views = ["auth", "chats", "contacts", "room", "profile"];
function showView(name) {
  views.forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle("hidden", v !== name);
  });
  document.getElementById("settings-menu").classList.add("hidden");
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  wireAuthForm();
  wireChatsHome();
  wireContacts();
  wireRoom();
  wireProfile();
  registerServiceWorker();

  const session = loadSession();
  if (session && session.username) {
    // Re-hydrate the profile from Firestore in case it changed elsewhere.
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
  showView("chats");
  listenToChats();
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
  document.getElementById("btn-settings").addEventListener("click", () => {
    document.getElementById("settings-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("settings-menu");
    const btn = document.getElementById("btn-settings");
    if (!menu.contains(e.target) && !btn.contains(e.target)) menu.classList.add("hidden");
  });
  document.getElementById("menu-profile").addEventListener("click", () => openProfile());
  document.getElementById("menu-logout").addEventListener("click", () => {
    if (unsubChats) unsubChats();
    clearSession();
    currentUser = null;
    showView("auth");
  });
  document.getElementById("btn-bell").addEventListener("click", () => {
    toast("Unread messages are highlighted below.");
  });
  document.getElementById("fab-add").addEventListener("click", () => {
    document.getElementById("contact-search").value = "";
    document.getElementById("contact-result").innerHTML = "";
    document.getElementById("contact-status").textContent = "";
    showView("contacts");
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
  unsubChats = db.collection("chats")
    .where("participants", "array-contains", currentUser.username)
    .onSnapshot(async (snap) => {
      const chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      chats.sort((a, b) => (b.lastMessageAt?.toMillis?.() || 0) - (a.lastMessageAt?.toMillis?.() || 0));
      await renderChatList(chats);
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
    setBell(false);
    return;
  }
  list.classList.remove("hidden");
  empty.classList.add("hidden");
  empty.classList.remove("flex");

  let anyUnread = false;
  const cards = await Promise.all(chats.map(async (chat) => {
    const otherUsername = chat.participants.find(p => p !== currentUser.username);
    const other = await getUserProfile(otherUsername);
    const unread = (chat.unread && chat.unread[currentUser.username]) || 0;
    if (unread > 0) anyUnread = true;
    const time = chat.lastMessageAt?.toDate ? formatTime(chat.lastMessageAt.toDate()) : "";
    return `
      <div class="chat-card" data-chat-id="${chat.id}" data-username="${other.username}">
        <img src="${escapeAttr(other.avatarUrl)}" class="w-11 h-11 rounded-full object-cover border border-border shrink-0" alt="" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <p class="font-semibold text-sm truncate">${escapeHtml(other.name)} ${escapeHtml(other.surname || "")}</p>
            <span class="text-[11px] text-inksoft shrink-0">${time}</span>
          </div>
          <p class="text-xs text-inksoft truncate mt-0.5">${escapeHtml(chat.lastMessage || "Say hello 👋")}</p>
        </div>
        ${unread > 0 ? `<span class="unread-badge shrink-0">${unread > 99 ? "99+" : unread}</span>` : ""}
      </div>`;
  }));

  document.getElementById("chat-list").innerHTML = cards.join("");
  setBell(anyUnread);

  document.querySelectorAll(".chat-card").forEach(card => {
    card.addEventListener("click", () => openRoom(card.dataset.chatId, card.dataset.username));
  });
}

function setBell(active) {
  document.getElementById("bell-dot").classList.toggle("hidden", !active);
}

// ============================================================
// CONTACTS (start a new chat)
// ============================================================
function wireContacts() {
  document.getElementById("back-contacts").addEventListener("click", () => showView("chats"));

  let debounceTimer;
  document.getElementById("contact-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    const value = e.target.value.trim().toLowerCase();
    debounceTimer = setTimeout(() => searchContact(value), 300);
  });
}

async function searchContact(username) {
  const statusEl = document.getElementById("contact-status");
  const resultEl = document.getElementById("contact-result");
  resultEl.innerHTML = "";

  if (!username) { statusEl.textContent = ""; return; }
  if (username === currentUser.username) { statusEl.textContent = "That's you!"; return; }

  statusEl.textContent = "Searching…";
  try {
    const doc = await db.collection("users").doc(username).get();
    if (!doc.exists) {
      statusEl.textContent = "No family member with that exact username.";
      return;
    }
    statusEl.textContent = "";
    const data = doc.data();
    resultEl.innerHTML = `
      <div class="chat-card" id="found-contact">
        <img src="${escapeAttr(data.avatarUrl)}" class="w-11 h-11 rounded-full object-cover border border-border" alt="" />
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm truncate">${escapeHtml(data.name)} ${escapeHtml(data.surname || "")}</p>
          <p class="text-xs text-inksoft truncate">@${doc.id}</p>
        </div>
        <span class="text-xs font-semibold text-amber">Chat →</span>
      </div>`;
    document.getElementById("found-contact").addEventListener("click", () => startChatWith(doc.id));
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
      unread: { [currentUser.username]: 0, [otherUsername]: 0 },
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  openRoom(id, otherUsername);
}

// ============================================================
// CHAT ROOM
// ============================================================
function wireRoom() {
  document.getElementById("back-room").addEventListener("click", () => {
    if (unsubMessages) unsubMessages();
    activeChatId = null;
    showView("chats");
  });

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
  activeChatPartner = await getUserProfile(otherUsername);

  document.getElementById("room-avatar").src = activeChatPartner.avatarUrl || "";
  document.getElementById("room-name").textContent = `${activeChatPartner.name} ${activeChatPartner.surname || ""}`.trim();
  document.getElementById("room-username").textContent = "@" + activeChatPartner.username;

  showView("room");
  document.getElementById("room-messages").innerHTML = "";

  // Mark this chat as read for me.
  db.collection("chats").doc(chatId).update({ [`unread.${currentUser.username}`]: 0 }).catch(() => {});

  if (unsubMessages) unsubMessages();
  unsubMessages = db.collection("chats").doc(chatId).collection("messages")
    .orderBy("createdAt", "asc")
    .onSnapshot((snap) => {
      renderMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      // Keep marking read while the room is open and new messages arrive.
      db.collection("chats").doc(chatId).update({ [`unread.${currentUser.username}`]: 0 }).catch(() => {});
    }, (err) => console.error("messages listener error:", err));
}

function renderMessages(messages) {
  const wrap = document.getElementById("room-messages");
  wrap.innerHTML = messages.map(m => {
    const mine = m.sender === currentUser.username;
    const sender = mine ? currentUser : activeChatPartner;
    const time = m.createdAt?.toDate ? formatTime(m.createdAt.toDate()) : "";
    const preview = m.linkPreview ? renderLinkPreview(m.linkPreview) : "";
    return `
      <div class="bubble-row ${mine ? "mine" : "theirs"}">
        <img src="${escapeAttr(sender?.avatarUrl)}" class="w-7 h-7 rounded-full object-cover border border-border shrink-0 mb-0.5" alt="" />
        <div>
          <div class="bubble">${escapeHtml(m.text)}</div>
          ${preview}
          <div class="bubble-time ${mine ? "text-right" : ""}">${time}</div>
        </div>
      </div>`;
  }).join("");
  wrap.scrollTop = wrap.scrollHeight;
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
    createdAt: FieldValue.serverTimestamp(),
  };
  const msgDoc = await messagesRef.add(base);

  await chatRef.update({
    lastMessage: text,
    lastMessageAt: FieldValue.serverTimestamp(),
    [`unread.${activeChatPartner.username}`]: FieldValue.increment(1),
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
// PROFILE
// ============================================================
function wireProfile() {
  document.getElementById("back-profile").addEventListener("click", () => showView("chats"));

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
  showView("profile");
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
