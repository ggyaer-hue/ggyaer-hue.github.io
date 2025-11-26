// app.js (ROOM1 FINAL)
// - 팀 이름: Team 동찬 / Team 영섭 / Team 윤석 / Team 재섭
// - A그룹 최소 300점, B그룹 제한 없음
// - 유찰 재경매 시 0포도 입찰 가능(단, 이전 입찰보다 낮게는 안 됨)
// - pointsByTeam(팀별 1000점)으로 포인트 차감 & 제한
// - 유찰 재경매 버튼 한 번 누르면 UNSOLD 큐 자동 진행
// - 🔥 타이머 0초 되면 역할 상관없이 자동 finalize

import { app, db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  runTransaction,
  updateDoc,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

console.log("[app.js] loaded OK", app?.name);

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;
const BID_STEP = 5;
const TEAM_START_POINTS = 1000;
const MIN_BID_BY_GROUP = { A: 300, B: 0 };

const CANON_TEAMS = ["team1", "team2", "team3", "team4"];
// 표시용 팀 이름
const TEAM_DISPLAY_NAMES = ["Team 동찬", "Team 영섭", "Team 윤석", "Team 재섭"];
const UNSOLD_KEY = "unsold";

// 🔹 canonKey( team1~4 ) → Team 동찬/영섭/...
function displayNameFromCanonKey(canonKey) {
  if (!canonKey) return null;
  const m = String(canonKey).match(/([1-4])$/);
  if (!m) return null;
  const idx = Number(m[1]) - 1;
  return TEAM_DISPLAY_NAMES[idx] || null;
}

// 🔹 teamId( leader1, team3 등 ) → Team 동찬/영섭/...
function displayNameFromTeamId(teamId) {
  if (!teamId) return null;
  const m = String(teamId).match(/([1-4])$/);
  if (!m) return null;
  const idx = Number(m[1]) - 1;
  return TEAM_DISPLAY_NAMES[idx] || null;
}

// ====== FIRESTORE REFS ======
const roomRef = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol = collection(db, "rooms", ROOM_ID, "teams");
const logsCol = collection(db, "rooms", ROOM_ID, "logs");

// ====== DOM ======
const el = (id) => document.getElementById(id);
const text = (id, v) => {
  const n = el(id);
  if (n) n.textContent = v ?? "";
};

const $ = {
  roleSelect: el("role-select"),
  adminControls: el("admin-controls"),
  btnStartTest: el("btn-start-test"),
  btnStartReal: el("btn-start-real"),
  btnStartRemaining: el("btn-start-remaining"),
  btnReset: el("btn-reset"),

  statusDot: el("room-status-dot"),
  statusText: el("room-status-text"),
  modeBadge: el("mode-badge"),

  curPhoto: el("current-player-photo"),
  curName: el("current-player-name"),
  curRole: el("current-player-role"),
  curGroup: el("current-player-group"),
  curBase: el("current-player-base"),
  curBio: el("current-player-bio"),
  curStatusBadge: el("current-player-status"),

  bidAmount: el("bid-amount"),
  bidBtn: el("bid-button"),

  highestAmount: el("highest-amount"),
  highestLeader: el("highest-leader"),

  timerPlayerName: el("timer-player-name"),
  timer: el("timer"),
  bidLog: el("bid-log"),

  overlay: el("auction-overlay"),
  overlayTeam: el("auction-overlay-team"),
  overlayPhoto: el("auction-overlay-photo"),
  overlayName: el("auction-overlay-name"),
  overlayPrice: el("auction-overlay-price"),

  teamBox: {
    team1: el("team-leader1"),
    team2: el("team-leader2"),
    team3: el("team-leader3"),
    team4: el("team-leader4")
  },

  rosterA: el("roster-A"),
  rosterB: el("roster-B"),
  rosterU: el("roster-U")
};

// ====== STATE ======
let roomState = null;
let prevRoomState = null;
let players = [];
let teams = [];
let myRole = "viewer";
let tickTimer = null;

let timeoutFiredForEndsAt = null;
let lastTickSecond = null;

// ====== HELPERS ======
const normGroup = (g) => String(g || "A").trim().toUpperCase();
const normStatus = (s) => String(s || "available").trim().toLowerCase();
const numOrder = (v) => (Number.isFinite(Number(v)) ? Number(v) : 9999);
const photoOf = (p) =>
  p?.photoUrl || p?.photoURL || p?.imageUrl || p?.image || p?.img || "";

const isOperator = () => myRole === "operator";
const myTeamId = () =>
  String(myRole).startsWith("leader") ? myRole : null;
const myCanonTeamKey = () => {
  const id = myTeamId();
  if (!id) return null;
  const m = String(id).match(/([1-4])$/);
  return m ? `team${m[1]}` : null;
};

const isUnsoldAuction = (r) => r?.auctionMode === "unsold";

function getEndsAtMs(r) {
  if (!r) return null;
  let v = r.endsAtMs ?? r.endsAt ?? r.endsAtS ?? r.endsAtSec ?? null;
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function canonicalKeyFromAnyId(anyId) {
  if (!anyId) return null;
  const s = String(anyId).toLowerCase();
  const m = s.match(/([1-4])$/);
  if (m) return `team${m[1]}`;
  return null;
}

function buildTeamMaps() {
  const byDocId = new Map();
  const byCanon = new Map();

  teams.forEach((t) => {
    byDocId.set(t.id, t);

    const oi = Number(t.orderIndex);
    if (oi >= 1 && oi <= 4) {
      byCanon.set(`team${oi}`, t);
      return;
    }
    const c = canonicalKeyFromAnyId(t.id);
    if (c && !byCanon.has(c)) byCanon.set(c, t);
  });

  return { byDocId, byCanon };
}

// room.pointsByTeam 안전하게
function normalizePointsByTeam(pointsByTeam) {
  const p = { ...(pointsByTeam || {}) };
  CANON_TEAMS.forEach((k) => {
    const v = Number(p[k]);
    p[k] = Number.isFinite(v) ? v : TEAM_START_POINTS;
  });
  return p;
}

// rosters 기반 제외 집합
function getExcludedIdsFromRoom(r) {
  const ro = r?.rosters;
  if (!ro) return new Set();
  const s = new Set();
  CANON_TEAMS.forEach((k) => {
    (ro[k] || []).forEach((x) => {
      if (x?.playerId) s.add(x.playerId);
    });
  });
  (ro[UNSOLD_KEY] || []).forEach((x) => {
    if (x?.playerId) s.add(x.playerId);
  });
  return s;
}

function getExcludedIds() {
  const fromRoom = getExcludedIdsFromRoom(roomState);
  if (fromRoom.size) return fromRoom;

  const s = new Set();
  players.forEach((p) => {
    const st = normStatus(p.status);
    if (st === "sold" || st === "unsold") s.add(p.id);
  });
  return s;
}

function getNextPlayerId(group, excludeId = null) {
  const g = normGroup(group);
  const excluded = getExcludedIds();
  const avail = players
    .filter((p) => p.id !== excludeId)
    .filter((p) => !excluded.has(p.id))
    .filter(
      (p) =>
        normStatus(p.status) === "available" &&
        normGroup(p.group) === g
    )
    .sort((a, b) => numOrder(a.orderIndex) - numOrder(b.orderIndex));
  return avail[0]?.id || null;
}

// ====== SOUND ======
let audioCtx = null;
const sfx = {
  bid: new Audio("./assets/sfx/bid.mp3"),
  tick: new Audio("./assets/sfx/tick.mp3")
};
sfx.bid.volume = 0.6;
sfx.tick.volume = 0.25;

function getAC() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}
function beep(freq = 600, dur = 0.08, vol = 0.06) {
  try {
    const ctx = getAC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch (e) {}
}
document.addEventListener(
  "pointerdown",
  () => {
    try {
      getAC().resume();
    } catch (e) {}
  },
  { once: true }
);

function playSfx(name) {
  const a = sfx[name];
  if (a) {
    try {
      a.currentTime = 0;
      a.play();
      return;
    } catch (e) {}
  }
  if (name === "tick") beep(440, 0.05, 0.04);
  if (name === "bid") beep(700, 0.08, 0.08);
}

// ====== SNAPSHOT LISTENERS ======
onSnapshot(roomRef, (snap) => {
  prevRoomState = roomState;
  roomState = snap.exists() ? snap.data() : null;

  const endsMs = getEndsAtMs(roomState);
  if (endsMs && endsMs !== timeoutFiredForEndsAt) {
    timeoutFiredForEndsAt = null;
    lastTickSecond = null;
  }

  maybeShowOverlay(prevRoomState, roomState);
  renderAll();
  syncTick();
});

onSnapshot(teamsCol, (snap) => {
  teams = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => numOrder(a.orderIndex) - numOrder(b.orderIndex));
  renderTeams();
});

onSnapshot(playersCol, (snap) => {
  players = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => numOrder(a.orderIndex) - numOrder(b.orderIndex));
  renderGroups();
  renderTeams();
  renderCurrent();
});

onSnapshot(query(logsCol, orderBy("createdAt", "asc")), (snap) => {
  if (!$.bidLog) return;
  $.bidLog.innerHTML = "";
  snap.docs.forEach((d) => {
    const x = d.data();
    const row = document.createElement("div");
    row.className = "item";
    row.textContent = `${x.teamName || x.teamId} - ${
      x.playerName
    } : ${x.amount}점`;
    $.bidLog.appendChild(row);
  });
  $.bidLog.scrollTop = $.bidLog.scrollHeight;
});

// ====== RENDER ======
function renderAll() {
  renderTop();
  renderCurrent();
  renderGroups();
  renderTeams();
  renderAdminControls();
}

function renderTop() {
  if (!roomState) return;
  const st = roomState.status || "running";
  if ($.statusText) {
    $.statusText.textContent =
      st === "running" ? "경매중" : st === "finished" ? "종료" : "대기중";
  }
  if ($.statusDot) {
    $.statusDot.className =
      "dot " + (st === "running" ? "bidding" : st === "finished" ? "finished" : "");
  }
  if ($.modeBadge) {
    $.modeBadge.textContent = `ROOM1 · REAL · ${
      roomState.currentGroup || roomState.group || roomState.phase || "A"
    }`;
  }
}
function renderAdminControls() {
  if ($.adminControls) $.adminControls.style.display = isOperator() ? "" : "none";
}

function renderCurrent() {
  if (!roomState) {
    text("current-player-name", "-");
    text("current-player-role", "-");
    text("current-player-group", "-");
    text("current-player-base", "-");
    text("current-player-bio", "-");
    text("highest-amount", "-");
    text("highest-leader", "-");
    if ($.curPhoto) $.curPhoto.src = "";
    if ($.timerPlayerName) $.timerPlayerName.textContent = "-";
    return;
  }
  const cur = players.find((p) => p.id === roomState.currentPlayerId);
  text("current-player-name", cur?.name || "-");
  text("current-player-role", cur?.role || "-");
  text("current-player-group", normGroup(cur?.group) || "-");
  text("current-player-base", cur?.basePrice ?? 0);
  text("current-player-bio", cur?.bio || cur?.intro || "-");
  text("current-player-status", roomState.status || roomState.phase || "-");
  if ($.curPhoto) {
    $.curPhoto.src = photoOf(cur);
    $.curPhoto.alt = cur?.name || "current";
  }
  text("highest-amount", roomState.highestBid ?? 0);
  text(
    "highest-leader",
    roomState.highestBidderName || roomState.highestBidderId || "-"
  );
  if ($.timerPlayerName) $.timerPlayerName.textContent = cur?.name || "-";
}

function renderGroups() {
  const excluded = getExcludedIds();

  if ($.rosterA) {
    $.rosterA.innerHTML = "";
    players
      .filter((p) => normGroup(p.group) === "A")
      .forEach((p) => $.rosterA.appendChild(avatarItem(p, excluded)));
  }
  if ($.rosterB) {
    $.rosterB.innerHTML = "";
    players
      .filter((p) => normGroup(p.group) === "B")
      .forEach((p) => $.rosterB.appendChild(avatarItem(p, excluded)));
  }

  if ($.rosterU) {
    $.rosterU.innerHTML = "";
    const ro = roomState?.rosters;
    if (ro && Array.isArray(ro[UNSOLD_KEY])) {
      ro[UNSOLD_KEY].forEach((x) => {
        $.rosterU.appendChild(
          avatarItem(
            {
              id: x.playerId,
              name: x.name,
              photoUrl: x.photoUrl
            },
            excluded
          )
        );
      });
    } else {
      players
        .filter((p) => normStatus(p.status) === "unsold")
        .forEach((p) => $.rosterU.appendChild(avatarItem(p, excluded)));
    }
  }
}

function avatarItem(p, excluded) {
  const wrap = document.createElement("div");
  wrap.className = "avatar";

  const img = document.createElement("img");
  img.src = photoOf(p);

  const name = document.createElement("div");
  name.className = "name-tip";
  name.textContent = p.name || p.id;

  if (roomState?.currentPlayerId === p.id) wrap.classList.add("current");
  if (excluded.has(p.id)) wrap.classList.add("sold");

  const canon = p.assignedTeamKey || canonicalKeyFromAnyId(p.assignedTeamId);
  if (canon) {
    const leaderClass = canon.replace("team", "leader");
    wrap.classList.add(`sold-by-${leaderClass}`);
  }

  wrap.addEventListener("click", () => {
    if (!isOperator()) return;
    pickPlayerAsCurrent(p.id);
  });

  wrap.appendChild(img);
  wrap.appendChild(name);
  return wrap;
}

function renderTeams() {
  const roomRosters = roomState?.rosters || null;
  const buckets = { team1: [], team2: [], team3: [], team4: [] };

  if (roomRosters) {
    CANON_TEAMS.forEach((k) => {
      (roomRosters[k] || []).forEach((x) => buckets[k].push(x));
    });
  } else {
    const soldPlayers = players.filter(
      (p) => normStatus(p.status) === "sold"
    );
    soldPlayers.forEach((p) => {
      const canon =
        p.assignedTeamKey || canonicalKeyFromAnyId(p.assignedTeamId);
      if (canon && buckets[canon]) buckets[canon].push(p);
    });
  }

  const pointsByTeam = normalizePointsByTeam(roomState?.pointsByTeam);

  CANON_TEAMS.forEach((canon, idx) => {
    const box = $.teamBox[canon];
    if (!box) return;

    const roster = buckets[canon].sort(
      (a, b) => numOrder(a.orderIndex) - numOrder(b.orderIndex)
    );
    const remainPts = pointsByTeam[canon] ?? TEAM_START_POINTS;

    const displayName = TEAM_DISPLAY_NAMES[idx] || `Team ${idx + 1}`;

    box.innerHTML = `
      <div class="team-header">
        <div class="team-name"><span>${displayName}</span></div>
        <div class="team-points">${remainPts} / ${TEAM_START_POINTS}</div>
      </div>
      <div class="team-row">
        ${[0, 1, 2, 3, 4]
          .map((_, i) => {
            const p = roster[i];
            if (!p) return `<div class="slot empty"></div>`;
            const pp = p.playerId ? p : p;
            return `
              <div class="slot">
                <img src="${photoOf(pp)}" alt="${pp.name || pp.playerId}">
                <div class="slot-text">
                  <div class="slot-name">${pp.name || pp.playerId}</div>
                  <div class="slot-price">${pp.finalPrice ?? 0}점</div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  });
}

// ====== TIMER ======
function syncTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const endsMs = getEndsAtMs(roomState);
    if (!endsMs) {
      if ($.timer) $.timer.textContent = "-";
      return;
    }
    const leftMs = endsMs - Date.now();
    const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
    if ($.timer) $.timer.textContent = leftSec;

    if (leftSec > 0 && leftSec !== lastTickSecond) {
      lastTickSecond = leftSec;
      playSfx("tick");
    }

    // 🔥 역할 상관없이 타이머 0초 되면 finalize 실행
    if (leftSec <= 0 && timeoutFiredForEndsAt !== endsMs) {
      timeoutFiredForEndsAt = endsMs;
      safeFinalize("timeout").catch(console.error);
    }
  }, 250);
}

// ====== AUCTION FLOW ======
async function pickPlayerAsCurrent(pid) {
  if (!isOperator()) return;
  const p = players.find((x) => x.id === pid);
  const g = normGroup(p?.group || "A");

  await updateDoc(roomRef, {
    currentPlayerId: pid,
    currentGroup: g,
    group: g,
    phase: g,
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    highestBidderCanonKey: null,
    endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
    status: "running",
    finalizing: false,
    announcement: null,
    auctionMode: "normal"
  });
}

async function startMainAuction() {
  if (!isOperator()) return;
  const firstA = getNextPlayerId("A");
  if (!firstA) return alert("GROUP A에 남은 선수가 없습니다.");

  await updateDoc(roomRef, {
    status: "running",
    currentGroup: "A",
    group: "A",
    phase: "A",
    currentPlayerId: firstA,
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    highestBidderCanonKey: null,
    endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
    announcement: "본경매 시작!",
    finalizing: false,
    auctionMode: "normal"
  });
}

// 유찰 재경매: UNSOLD 큐에서 하나 꺼내서 시작
// 유찰 재경매: 현재 players 상태 기준으로 UNSOLD 큐를 재구성하고, 자동 진행 모드로 진입
async function startRemainingAuction() {
  if (!isOperator()) return;

  // 1) 클라이언트에서 보고 있는 players 기준으로 "유찰 선수 리스트" 만들기
  const unsoldFromState = players
    .filter(p => normStatus(p.status) === "unsold")
    .sort((a, b) => numOrder(a.orderIndex) - numOrder(b.orderIndex))
    .map((p, idx) => ({
      playerId: p.id,
      name: p.name || p.id,
      photoUrl: photoOf(p),
      finalPrice: p.finalPrice ?? 0,
      orderIndex: numOrder(p.orderIndex ?? idx)
    }));

  if (unsoldFromState.length === 0) {
    alert("유찰된 선수가 없습니다.");
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error("room missing");
      const r = roomSnap.data();

      // 원래 rosters 유지 + UNSOLD 큐만 현재 상태로 재구성
      const rosters = { ...(r.rosters || {}) };
      CANON_TEAMS.forEach(k => {
        if (!Array.isArray(rosters[k])) rosters[k] = [];
      });

      // 🔥 지금 화면 기준 유찰 리스트를 통째로 room.rosters.unsold 에 넣는다
      rosters[UNSOLD_KEY] = unsoldFromState;

      // 큐의 첫 번째 선수부터 재경매 시작
      const first = rosters[UNSOLD_KEY][0];
      const pid = first.playerId;

      const pRef  = doc(playersCol, pid);
      const pSnap = await tx.get(pRef);
      const pData = pSnap.exists() ? pSnap.data() : {};
      const nextGroup = normGroup(pData.group || "A");

      // 상태를 다시 available 로
      tx.update(pRef, {
        status: "available",
        updatedAt: serverTimestamp()
      });

      tx.update(roomRef, {
        status: "running",
        currentPlayerId: pid,
        currentGroup: nextGroup,
        group: nextGroup,
        phase: nextGroup,

        highestBid: 0,
        highestBidderId: null,
        highestBidderName: null,
        highestBidderCanonKey: null,

        endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
        announcement: "유찰 재경매 시작!",
        finalizing: false,
        rosters,
        auctionMode: "unsold"   // 👈 여기서부터 finalizeFull이 UNSOLD 큐를 자동으로 돈다
      });
    });
  } catch (e) {
    alert(e.message || "잔여 재경매 시작 실패");
    console.error(e);
  }
}

// 1차: players + room(포인트/roster)
async function finalizeFull(reason = "sold") {
  await runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("room missing");
    const r = roomSnap.data();
    if (r.finalizing) return;

    const isUnsoldMode = r.auctionMode === "unsold";

    const curId = r.currentPlayerId;
    if (!curId) {
      tx.update(roomRef, { finalizing: false });
      return;
    }

    const curRef = doc(playersCol, curId);
    const curSnap = await tx.get(curRef);
    if (!curSnap.exists()) {
      tx.update(roomRef, { currentPlayerId: null, finalizing: false });
      return;
    }

    const cur = curSnap.data();
    const curGroup = normGroup(cur.group);

    const highestBid = r.highestBid ?? 0;
    const bidderId = r.highestBidderId || null;
    const canonKey =
      r.highestBidderCanonKey || canonicalKeyFromAnyId(bidderId);

    const rosters = { ...(r.rosters || {}) };
    CANON_TEAMS.forEach((k) => {
      if (!Array.isArray(rosters[k])) rosters[k] = [];
    });
    if (!Array.isArray(rosters[UNSOLD_KEY])) rosters[UNSOLD_KEY] = [];

    const pointsByTeam = normalizePointsByTeam(r.pointsByTeam);

    tx.update(roomRef, { finalizing: true });

    if (highestBid > 0 && bidderId && canonKey) {
      // 낙찰
      tx.update(curRef, {
        status: "sold",
        assignedTeamId: bidderId,
        assignedTeamKey: canonKey,
        soldBy: bidderId,
        soldAtMs: Date.now(),
        finalPrice: highestBid,
        updatedAt: serverTimestamp()
      });

      pointsByTeam[canonKey] = Math.max(
        0,
        pointsByTeam[canonKey] - highestBid
      );

      rosters[canonKey].push({
        playerId: curId,
        name: cur.name || curId,
        photoUrl:
          cur.photoUrl || cur.photoURL || cur.imageUrl || "",
        finalPrice: highestBid,
        orderIndex:
          cur.orderIndex ?? rosters[canonKey].length
      });

      // UNSOLD 목록에서 제거
      rosters[UNSOLD_KEY] = (rosters[UNSOLD_KEY] || []).filter(
        (x) => x.playerId !== curId
      );
    } else {
      // 유찰 처리
      tx.update(curRef, {
        status: "unsold",
        assignedTeamId: null,
        assignedTeamKey: null,
        soldBy: null,
        soldAtMs: Date.now(),
        finalPrice: 0,
        updatedAt: serverTimestamp()
      });

      const base = (rosters[UNSOLD_KEY] || []).filter(
        (x) => x.playerId !== curId
      );
      base.push({
        playerId: curId,
        name: cur.name || curId,
        photoUrl:
          cur.photoUrl || cur.photoURL || cur.imageUrl || "",
        finalPrice: 0,
        orderIndex: cur.orderIndex ?? base.length
      });
      rosters[UNSOLD_KEY] = base;
    }

    let nextId = null;
    let nextGroup = curGroup;
    let nextAuctionMode = r.auctionMode || "normal";

    if (isUnsoldMode) {
      // 유찰 재경매 모드: UNSOLD 목록에서 다음 선수 자동 선택
      const list = rosters[UNSOLD_KEY] || [];
      const nextEntry = list.find(
        (x) => x.playerId && x.playerId !== curId
      );
      if (nextEntry) {
        nextId = nextEntry.playerId;

        const nextRef = doc(playersCol, nextId);
        const nextSnap = await tx.get(nextRef);
        const nextData = nextSnap.exists() ? nextSnap.data() : {};
        nextGroup = normGroup(nextData.group || "A");

        tx.update(nextRef, {
          status: "available",
          updatedAt: serverTimestamp()
        });

        nextAuctionMode = "unsold";
      } else {
        // 더 이상 유찰 선수 없음 → 유찰 재경매 끝
        nextAuctionMode = "normal";
      }
    } else {
      // 일반 A/B 경매 흐름
      nextGroup = curGroup;
      nextId = getNextPlayerId(nextGroup, curId);
      if (!nextId && curGroup === "A") {
        nextGroup = "B";
        nextId = getNextPlayerId("B", curId);
      }
      nextAuctionMode = "normal";
    }

    if (!nextId) {
      // 다음 선수 없으면 종료
      tx.update(roomRef, {
        status: "finished",
        currentPlayerId: null,
        currentGroup: nextGroup,
        group: nextGroup,
        phase: nextGroup,
        highestBid: 0,
        highestBidderId: null,
        highestBidderName: null,
        highestBidderCanonKey: null,
        endsAtMs: null,
        finalizing: false,
        rosters,
        pointsByTeam,
        auctionMode: nextAuctionMode,
        announcement: "경매 종료"
      });
      return;
    }

    tx.update(roomRef, {
      status: "running",
      currentGroup: nextGroup,
      group: nextGroup,
      phase: nextGroup,
      currentPlayerId: nextId,
      highestBid: 0,
      highestBidderId: null,
      highestBidderName: null,
      highestBidderCanonKey: null,
      endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
      finalizing: false,
      rosters,
      pointsByTeam,
      auctionMode: nextAuctionMode,
      announcement: isUnsoldMode
        ? reason === "timeout"
          ? "유찰 재경매 → 다음 선수"
          : "유찰 재경매 낙찰 완료!"
        : reason === "timeout"
        ? "유찰 → 다음 선수"
        : "낙찰 완료!"
    });
  });
}

// 2차 fallback: room만(혹시 위 트랜잭션 실패 대비용)
async function finalizeRoomOnly(reason = "sold") {
  await runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("room missing");
    const r = roomSnap.data();
    if (r.finalizing) return;

    const curId = r.currentPlayerId;
    if (!curId) {
      tx.update(roomRef, { finalizing: false });
      return;
    }

    const curLocal = players.find((p) => p.id === curId) || {};
    const curGroup = normGroup(
      curLocal.group || r.currentGroup || r.group || "A"
    );

    const highestBid = r.highestBid ?? 0;
    const canonKey =
      r.highestBidderCanonKey || canonicalKeyFromAnyId(r.highestBidderId);

    const rosters = { ...(r.rosters || {}) };
    CANON_TEAMS.forEach((k) => {
      if (!Array.isArray(rosters[k])) rosters[k] = [];
    });
    if (!Array.isArray(rosters[UNSOLD_KEY])) rosters[UNSOLD_KEY] = [];

    const pointsByTeam = normalizePointsByTeam(r.pointsByTeam);

    tx.update(roomRef, { finalizing: true });

    if (highestBid > 0 && canonKey) {
      rosters[canonKey].push({
        playerId: curId,
        name: curLocal.name || curId,
        photoUrl: photoOf(curLocal),
        finalPrice: highestBid,
        orderIndex:
          curLocal.orderIndex ?? rosters[canonKey].length
      });
      pointsByTeam[canonKey] = Math.max(
        0,
        pointsByTeam[canonKey] - highestBid
      );
    } else {
      rosters[UNSOLD_KEY].push({
        playerId: curId,
        name: curLocal.name || curId,
        photoUrl: photoOf(curLocal),
        finalPrice: 0,
        orderIndex:
          curLocal.orderIndex ?? rosters[UNSOLD_KEY].length
      });
    }

    let nextGroup = curGroup;
    let nextId = getNextPlayerId(nextGroup, curId);
    if (!nextId && curGroup === "A") {
      nextGroup = "B";
      nextId = getNextPlayerId("B", curId);
    }

    if (!nextId) {
      tx.update(roomRef, {
        status: "finished",
        currentPlayerId: null,
        currentGroup: nextGroup,
        group: nextGroup,
        phase: nextGroup,
        highestBid: 0,
        highestBidderId: null,
        highestBidderName: null,
        highestBidderCanonKey: null,
        endsAtMs: null,
        finalizing: false,
        rosters,
        pointsByTeam,
        auctionMode: "normal",
        announcement: "경매 종료(ROOM 저장모드)"
      });
      return;
    }

    tx.update(roomRef, {
      status: "running",
      currentGroup: nextGroup,
      group: nextGroup,
      phase: nextGroup,
      currentPlayerId: nextId,
      highestBid: 0,
      highestBidderId: null,
      highestBidderName: null,
      highestBidderCanonKey: null,
      endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
      finalizing: false,
      rosters,
      pointsByTeam,
      auctionMode: "normal",
      announcement:
        reason === "timeout"
          ? "유찰 → 다음 선수(ROOM 저장모드)"
          : "낙찰 완료!(ROOM 저장모드)"
    });
  });
}

// ====== BID ======
async function placeBid() {
  try {
    const raw = $.bidAmount?.value;
    const amount = Number(raw);
    if (raw === "" || Number.isNaN(amount)) {
      return alert("입찰 금액을 입력해줘.");
    }
    if (amount < 0) return alert("0 이상만 입력해줘.");
    if (amount % BID_STEP !== 0)
      return alert(`입찰은 ${BID_STEP}점 단위만 가능해.`);

    const teamId = myTeamId();
    const canonKey = myCanonTeamKey();
    if (!teamId || !canonKey) return alert("팀장만 입찰 가능.");

    const unsoldNow = isUnsoldAuction(roomState);

    // 일반 경매일 때만 최소 입찰 체크
    const curId0 = roomState?.currentPlayerId;
    const curLocal = players.find((p) => p.id === curId0);
    const g0 = normGroup(
      curLocal?.group || roomState?.currentGroup || "A"
    );
    const minBid0 = unsoldNow ? 0 : (MIN_BID_BY_GROUP[g0] ?? 0);
    if (!unsoldNow && amount < minBid0) {
      return alert(
        `GROUP ${g0}는 최소 ${minBid0}점부터 입찰 가능해.`
      );
    }

    playSfx("bid");

    await runTransaction(db, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      const r = roomSnap.data();
      const curId = r.currentPlayerId;
      if (!curId) throw new Error("현재 경매 선수가 없음");

      const unsoldTx = isUnsoldAuction(r);

      const curRef = doc(playersCol, curId);
      const curSnap = await tx.get(curRef);
      const cur = curSnap.data();

      const g = normGroup(cur.group);
      const minBid = unsoldTx ? 0 : (MIN_BID_BY_GROUP[g] ?? 0);
      if (!unsoldTx && amount < minBid) {
        throw new Error(`GROUP ${g}는 최소 ${minBid}점부터 입찰 가능`);
      }

      const highest = r.highestBid ?? 0;
      if (unsoldTx) {
        // 유찰 재경매: 이전 입찰가보다 낮게만 안 되면 됨
        if (amount < highest) {
          throw new Error(
            "이전 입찰가보다 낮게는 입찰할 수 없습니다."
          );
        }
      } else {
        // 일반 경매: 최소 +5
        if (amount < highest + BID_STEP) {
          throw new Error(
            `최소 ${BID_STEP}점 이상 높여야 함`
          );
        }
      }

      const pointsByTeam = normalizePointsByTeam(r.pointsByTeam);
      const remain = pointsByTeam[canonKey];
      if (amount > remain) throw new Error("잔여 포인트 부족");

      const displayName =
        displayNameFromCanonKey(canonKey) ||
        displayNameFromTeamId(teamId) ||
        teamId;

      tx.update(roomRef, {
        highestBid: amount,
        highestBidderId: teamId,
        highestBidderName: displayName,
        highestBidderCanonKey: canonKey,
        lastBidAtMs: Date.now(),
        pointsByTeam
      });

      const logRef = doc(logsCol);
      tx.set(logRef, {
        createdAt: serverTimestamp(),
        teamId,
        teamName: displayName,
        playerId: curId,
        playerName: cur.name || curId,
        amount,
        group: g
      });
    });

    $.bidAmount.value = "";
  } catch (e) {
    alert(e.message || "입찰 실패");
    console.error(e);
  }
}

// ====== RESET ======
async function resetAll() {
  if (!isOperator()) return;

  const batch = writeBatch(db);

  batch.update(roomRef, {
    status: "waiting",
    currentGroup: "A",
    group: "A",
    phase: "A",
    currentPlayerId: null,
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    highestBidderCanonKey: null,
    endsAtMs: null,
    announcement: "전체 리셋 완료",
    finalizing: false,
    rosters: {
      team1: [],
      team2: [],
      team3: [],
      team4: [],
      unsold: []
    },
    pointsByTeam: {
      team1: TEAM_START_POINTS,
      team2: TEAM_START_POINTS,
      team3: TEAM_START_POINTS,
      team4: TEAM_START_POINTS
    },
    auctionMode: "normal"
  });

  const pSnap = await getDocs(playersCol);
  pSnap.forEach((d) => {
    batch.update(d.ref, {
      status: "available",
      assignedTeamId: null,
      assignedTeamKey: null,
      soldBy: null,
      soldAtMs: null,
      finalPrice: 0,
      updatedAt: serverTimestamp()
    });
  });

  const tSnap = await getDocs(teamsCol);
  tSnap.forEach((d) =>
    batch.update(d.ref, { pointsRemaining: TEAM_START_POINTS })
  );

  await batch.commit();

  const lSnap = await getDocs(logsCol);
  const delBatch = writeBatch(db);
  lSnap.forEach((d) => delBatch.delete(d.ref));
  await delBatch.commit();
}

// ====== OVERLAY ======
function maybeShowOverlay(prev, cur) {
  if (!prev || !cur) return;
  if (prev.currentPlayerId && prev.currentPlayerId !== cur.currentPlayerId) {
    const soldPlayer = players.find(
      (p) => p.id === prev.currentPlayerId
    );
    if (!soldPlayer) return;

    const price = prev.highestBid ?? 0;
    const canonKey = prev.highestBidderCanonKey;
    const leaderClass = canonKey ? canonKey.replace("team", "leader") : null;
    const teamName =
      prev.highestBidderName || prev.highestBidderId || "유찰";

    showOverlay({
      leaderClass,
      teamName,
      player: soldPlayer,
      price,
      sold: price > 0
    });
  }
}
function showOverlay({ leaderClass, teamName, player, price, sold }) {
  if (!$.overlay) return;

  $.overlayTeam.textContent = sold ? teamName : "유찰";
  $.overlayName.textContent = player?.name || "-";
  $.overlayPrice.textContent = sold ? `${price}점 낙찰` : "유찰";
  $.overlayPhoto.src = photoOf(player);

  $.overlayTeam.style.color = leaderClass
    ? `var(--c-${leaderClass})`
    : "#cbd7f7";
  $.overlayPhoto.style.borderColor = leaderClass
    ? `var(--c-${leaderClass})`
    : "#cbd7f7";

  $.overlay.classList.remove("show");
  void $.overlay.offsetWidth;
  $.overlay.classList.add("show");
}

// ====== EVENTS ======
function bindEvents() {
  if ($.roleSelect) {
    $.roleSelect.addEventListener("change", () => {
      myRole = $.roleSelect.value;
      renderAdminControls();
    });
    myRole = $.roleSelect.value;
  }

  $.bidBtn && $.bidBtn.addEventListener("click", placeBid);
  $.bidAmount &&
    $.bidAmount.addEventListener("keydown", (e) => {
      if (e.key === "Enter") placeBid();
    });

  $.btnStartReal &&
    $.btnStartReal.addEventListener("click", startMainAuction);
  $.btnStartTest &&
    $.btnStartTest.addEventListener("click", startMainAuction);
  $.btnStartRemaining &&
    $.btnStartRemaining.addEventListener("click", startRemainingAuction);
  $.btnReset && $.btnReset.addEventListener("click", resetAll);
}
bindEvents();

// 디버그용
window.__finalize = safeFinalize;
