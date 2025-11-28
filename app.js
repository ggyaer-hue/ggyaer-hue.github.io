// app.js
// ----------------------------------------------------------
// ROOM1 경매 클라이언트 (A/B + 유찰 재경매 지원)
// ----------------------------------------------------------
import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  runTransaction,
  updateDoc,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;
const BID_STEP = 5;
const TEAM_START_POINTS = 1000;
const GROUP_A_MIN_BID = 300;

// 팀 문서 아이디 & 화면 표시 이름
const TEAM_IDS = ["leader1", "leader2", "leader3", "leader4"];
const TEAM_LABELS = ["Team 동찬", "Team 영섭", "Team 윤석", "Team 재섭"];

// 화면 상단 팀 박스 DOM id
const TEAM_BOX_IDS = {
  leader1: "team-leader1",
  leader2: "team-leader2",
  leader3: "team-leader3",
  leader4: "team-leader4",
};

const TEAM_LABEL_BY_ID = {
  leader1: "Team 동찬",
  leader2: "Team 영섭",
  leader3: "Team 윤석",
  leader4: "Team 재섭",
};

// ====== FIRESTORE REFS ======
const roomRef = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol = collection(db, "rooms", ROOM_ID, "teams");
const logsCol = collection(db, "rooms", ROOM_ID, "logs");

// ====== STATE ======
let roomState = null;
let players = [];
let teamsById = {};
let myRole = "viewer";
let tickTimer = null;
let localFinalizing = false;

// ====== HELPERS ======
const $ = (id) => document.getElementById(id);
const normGroup = (g) => String(g || "").trim().toUpperCase();
const isOperator = () => myRole === "operator";
const getMyTeamId = () => (myRole.startsWith("leader") ? myRole : null);
const isUnsold = (p) => p.status === "unsold" || p.status === "유찰";
const isFinishedPlayer = (p) => !!p.assignedTeamId || isUnsold(p);
const isAvailable = (p) => !isFinishedPlayer(p);

// ====== SNAPSHOT LISTENERS ======
onSnapshot(
  roomRef,
  (snap) => {
    roomState = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    renderRoomStatus();
    renderCurrent();
    startTimerLoop();
  },
  (err) => console.error("[room] snapshot error:", err)
);

onSnapshot(
  teamsCol,
  (snap) => {
    teamsById = {};
    snap.docs.forEach((d) => {
      teamsById[d.id] = { id: d.id, ...d.data() };
    });
    renderTeams();
  },
  (err) => console.error("[teams] snapshot error:", err)
);

// 🔥 players: orderBy 없이 전체 구독 (인덱스 문제 방지)
onSnapshot(
  playersCol,
  (snap) => {
    players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    console.log("[players] snapshot count:", snap.size);
    renderTeams();
    renderRosters();
    renderCurrent();
  },
  (err) => console.error("[players] snapshot error:", err)
);

onSnapshot(
  logsCol,
  (snap) => {
    const box = $("bid-log");
    if (!box) return;
    box.innerHTML = "";
    snap.docs
      .sort((a, b) => {
        const ta = a.data().createdAt?.seconds ?? 0;
        const tb = b.data().createdAt?.seconds ?? 0;
        return ta - tb;
      })
      .forEach((d) => {
        const x = d.data();
        const teamLabel =
          TEAM_LABEL_BY_ID[x.teamId] ||
          x.teamLabel ||
          x.teamName ||
          x.teamId ||
          "-";
        const playerName = x.playerName || x.playerId || "";
        const amt = x.amount ?? 0;

        const row = document.createElement("div");
        row.className = "item";
        row.textContent = `${teamLabel} - ${playerName} : ${amt}점`;
        box.appendChild(row);
      });
    box.scrollTop = box.scrollHeight;
  },
  (err) => console.error("[logs] snapshot error:", err)
);

// ====== RENDER FUNCTIONS ======
function renderRoomStatus() {
  const dot = $("room-status-dot");
  const txt = $("room-status-text");
  const badge = $("current-player-status");
  if (!dot || !txt || !badge) return;

  const st = roomState?.status || "waiting";

  dot.classList.remove("bidding", "finished");
  if (st === "running") {
    dot.classList.add("bidding");
    txt.textContent = "경매중";
    badge.textContent = "running";
  } else if (st === "finished") {
    dot.classList.add("finished");
    txt.textContent = "종료";
    badge.textContent = "finished";
  } else {
    txt.textContent = "대기중";
    badge.textContent = "waiting";
  }
}

function renderCurrent() {
  const photoEl = $("current-player-photo");
  const nameEl = $("current-player-name");
  const roleEl = $("current-player-role");
  const groupEl = $("current-player-group");
  const baseEl = $("current-player-base");
  const bioEl = $("current-player-bio");
  const timerNameEl = $("timer-player-name");
  const highestEl = $("highest-amount");
  const highestLeaderEl = $("highest-leader");

  if (!roomState) {
    if (photoEl) photoEl.src = "";
    if (nameEl) nameEl.textContent = "-";
    if (roleEl) roleEl.textContent = "-";
    if (groupEl) groupEl.textContent = "-";
    if (baseEl) baseEl.textContent = "0";
    if (bioEl) bioEl.textContent = "-";
    if (timerNameEl) timerNameEl.textContent = "-";
    if (highestEl) highestEl.textContent = "-";
    if (highestLeaderEl) highestLeaderEl.textContent = "-";
    return;
  }

  const curId = roomState.currentPlayerId;
  const cur = players.find((p) => p.id === curId);

  if (photoEl) photoEl.src = cur?.photoUrl || "";
  if (nameEl) nameEl.textContent = cur?.name || "-";
  if (roleEl) roleEl.textContent = cur?.role || "-";
  if (groupEl) groupEl.textContent = normGroup(cur?.group) || "-";
  if (baseEl) baseEl.textContent = cur?.basePrice ?? 0;
  if (bioEl) bioEl.textContent = cur?.bio || "-";
  if (timerNameEl) timerNameEl.textContent = cur?.name || "-";

  if (highestEl) highestEl.textContent = roomState.highestBid ?? 0;
  if (highestLeaderEl) {
    const tId = roomState.highestBidderId;
    const label =
      TEAM_LABEL_BY_ID[tId] ||
      roomState.highestBidderName ||
      "-";
    highestLeaderEl.textContent = label;
  }
}

function renderTeams() {
  TEAM_IDS.forEach((teamId, idx) => {
    const boxId = TEAM_BOX_IDS[teamId];
    const box = $(boxId);
    if (!box) return;

    const roster = players
      .filter((p) => p.assignedTeamId === teamId)
      .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));

    const tDoc = teamsById[teamId];
    let remain = TEAM_START_POINTS;
    if (tDoc && typeof tDoc.pointsRemaining === "number") {
      remain = tDoc.pointsRemaining;
    } else {
      const spent = roster.reduce(
        (sum, p) => sum + (p.finalPrice ?? 0),
        0
      );
      remain = TEAM_START_POINTS - spent;
    }

    const header = `
      <div class="team-header">
        <div class="team-name">${TEAM_LABELS[idx]}</div>
        <div class="team-points">${remain} / ${TEAM_START_POINTS}</div>
      </div>
    `;

    const slotsHtml = [0, 1, 2, 3]
      .map((i) => {
        const p = roster[i];
        if (!p) return `<div class="slot empty"></div>`;
        return `
          <div class="slot">
            <img src="${p.photoUrl || ""}" alt="${p.name || p.id}">
            <div class="slot-text">
              <div class="slot-name">${p.name || p.id}</div>
              <div class="slot-price">${p.finalPrice ?? 0}점</div>
            </div>
          </div>
        `;
      })
      .join("");

    box.innerHTML = header + `<div class="team-row">${slotsHtml}</div>`;
  });
}

function renderRosters() {
  const boxA = $("roster-A");
  const boxB = $("roster-B");
  const boxU = $("roster-U");

  const sortByOrder = (a, b) =>
    (a.orderIndex ?? 999) - (b.orderIndex ?? 999);

  const listA = players
    .filter((p) => normGroup(p.group) === "A")
    .sort(sortByOrder);
  const listB = players
    .filter((p) => normGroup(p.group) === "B")
    .sort(sortByOrder);
  const listU = players
    .filter((p) => isUnsold(p) && !p.assignedTeamId)
    .sort(sortByOrder);

  const curId = roomState?.currentPlayerId;

  const htmlFor = (p) => {
    const cls = ["avatar"];

    if (p.id === curId) cls.push("current");
    if (p.assignedTeamId) {
      cls.push(`sold-by-${p.assignedTeamId}`, "sold");
    } else if (isUnsold(p)) {
      cls.push("sold");
    }

    return `
      <div class="${cls.join(" ")}">
        <img src="${p.photoUrl || ""}" alt="${p.name || ""}">
        <div class="name-tip">${p.name || ""}</div>
      </div>
    `;
  };

  if (boxA) boxA.innerHTML = listA.map(htmlFor).join("");
  if (boxB) boxB.innerHTML = listB.map(htmlFor).join("");
  if (boxU) boxU.innerHTML = listU.map(htmlFor).join("");
}

// ====== TIMER LOOP ======
function startTimerLoop() {
  if (tickTimer) clearInterval(tickTimer);

  tickTimer = setInterval(() => {
    const tEl = $("timer");
    if (!roomState || !roomState.endsAtMs) {
      if (tEl) tEl.textContent = "-";
      return;
    }

    const leftMs = roomState.endsAtMs - Date.now();
    const left = Math.max(0, Math.ceil(leftMs / 1000));
    if (tEl) tEl.textContent = left;

    // ✅ 타임아웃 처리: 운영자 화면에서만 실행
    if (
      left <= 0 &&
      roomState.status === "running" &&
      isOperator() &&
      !localFinalizing
    ) {
      localFinalizing = true;
      finalizeCurrentAuction("timeout")
        .catch(console.error)
        .finally(() => {
          localFinalizing = false;
        });
    }
  }, 250);
}

// ====== PLAYER ORDER HELPERS ======
function sortedMainPlayers() {
  const list = players.filter((p) => isAvailable(p));
  return list.sort((a, b) => {
    const gA = normGroup(a.group);
    const gB = normGroup(b.group);
    if (gA !== gB) return gA.localeCompare(gB);
    return (a.orderIndex ?? 999) - (b.orderIndex ?? 999);
  });
}

function sortedUnsoldPlayers() {
  const list = players.filter((p) => isUnsold(p) && !p.assignedTeamId);
  return list.sort(
    (a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999)
  );
}

function getNextMainPlayer(currentId) {
  const list = sortedMainPlayers();
  if (!list.length) return null;
  if (!currentId) return list[0];
  const idx = list.findIndex((p) => p.id === currentId);
  if (idx < 0 || idx === list.length - 1) return null;
  return list[idx + 1];
}

function getNextUnsoldPlayer(currentId) {
  const list = sortedUnsoldPlayers();
  if (!list.length) return null;
  if (!currentId) return list[0];
  const idx = list.findIndex((p) => p.id === currentId);
  if (idx < 0 || idx === list.length - 1) return null;
  return list[idx + 1];
}

// ====== START / FINALIZE / RESET ======
async function startMainAuction() {
  if (!isOperator()) {
    alert("운영자만 시작할 수 있습니다.");
    return;
  }
  const first = getNextMainPlayer(null);
  if (!first) {
    alert("경매할 선수가 없습니다.");
    return;
  }

  await updateDoc(roomRef, {
    status: "running",
    remainingMode: false,
    currentPlayerId: first.id,
    currentGroup: normGroup(first.group),
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
  });
}

async function startRemainingAuction() {
  if (!isOperator()) {
    alert("운영자만 시작할 수 있습니다.");
    return;
  }
  const first = getNextUnsoldPlayer(null);
  if (!first) {
    alert("유찰 선수가 없습니다.");
    return;
  }

  await updateDoc(roomRef, {
    status: "running",
    remainingMode: true,
    currentPlayerId: first.id,
    currentGroup: normGroup(first.group),
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
  });
}

async function finalizeCurrentAuction(reason = "sold") {
  try {
    await runTransaction(db, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error("room missing");
      const r = roomSnap.data();

      // ✅ 이미 running이 아니면 아무것도 안 함
      if (r.status !== "running") return;

      const curId = r.currentPlayerId;
      if (!curId) return;

      const curRef = doc(playersCol, curId);
      const curSnap = await tx.get(curRef);
      if (!curSnap.exists()) return;
      const cur = curSnap.data();

      const highestBid = r.highestBid ?? 0;
      const bidderId = r.highestBidderId || null;

      let teamRef = null;
      let teamData = null;
      if (bidderId) {
        teamRef = doc(teamsCol, bidderId);
        const teamSnap = await tx.get(teamRef);
        if (teamSnap.exists()) {
          teamData = teamSnap.data();
        }
      }

      // --- write-only 영역 ---
      if (bidderId) {
        // ✅ 금액이 0이어도 bidderId가 있으면 낙찰
        tx.update(curRef, {
          status: "sold",
          assignedTeamId: bidderId,
          finalPrice: highestBid,
          updatedAt: serverTimestamp(),
        });

        if (teamRef && teamData) {
          const remain =
            (teamData.pointsRemaining ?? TEAM_START_POINTS) -
            highestBid;
          tx.update(teamRef, { pointsRemaining: remain });
        }
      } else {
        // 아무도 입찰 안 했을 때만 유찰
        tx.update(curRef, {
          status: "unsold",
          assignedTeamId: null,
          finalPrice: 0,
          updatedAt: serverTimestamp(),
        });
      }

      let nextPlayer = null;
      if (r.remainingMode) {
        nextPlayer = getNextUnsoldPlayer(curId);
      } else {
        nextPlayer = getNextMainPlayer(curId);
      }

      if (!nextPlayer) {
        tx.update(roomRef, {
          status: "finished",
          currentPlayerId: null,
          currentGroup: null,
          highestBid: 0,
          highestBidderId: null,
          highestBidderName: null,
          endsAtMs: null,
        });
      } else {
        tx.update(roomRef, {
          status: "running",
          currentPlayerId: nextPlayer.id,
          currentGroup: normGroup(nextPlayer.group),
          highestBid: 0,
          highestBidderId: null,
          highestBidderName: null,
          endsAtMs: Date.now() + AUCTION_SECONDS * 1000,
        });
      }
    });
  } catch (err) {
    console.error(err);
    alert(err.message || "낙찰 처리 중 오류가 발생했습니다.");
  }
}

async function resetAll() {
  if (!isOperator()) {
    alert("운영자만 가능합니다.");
    return;
  }
  if (!confirm("전체 리셋 (포인트, 선수상태, 로그)을 진행할까요?")) return;

  const batch = writeBatch(db);

  const pSnap = await getDocs(playersCol);
  pSnap.forEach((d) => {
    batch.update(d.ref, {
      status: "available",
      assignedTeamId: null,
      finalPrice: 0,
      updatedAt: serverTimestamp(),
    });
  });

  const tSnap = await getDocs(teamsCol);
  tSnap.forEach((d) => {
    batch.update(d.ref, { pointsRemaining: TEAM_START_POINTS });
  });

  batch.update(roomRef, {
    status: "waiting",
    remainingMode: false,
    currentPlayerId: null,
    currentGroup: null,
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    endsAtMs: null,
  });

  await batch.commit();

  const logSnap = await getDocs(logsCol);
  const batch2 = writeBatch(db);
  logSnap.forEach((d) => batch2.delete(d.ref));
  await batch2.commit();
}

// ====== BID ======
async function placeBid() {
  const input = $("bid-amount");
  if (!input) return;

  const raw = Number(input.value);
  if (Number.isNaN(raw)) {
    alert("입찰 금액을 숫자로 입력해 주세요.");
    return;
  }
  const amount = Math.floor(raw);

  const teamId = getMyTeamId();
  if (!teamId) {
    alert("팀장 역할을 선택한 후 입찰할 수 있습니다.");
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error("room missing");
      const r = roomSnap.data();

      if (r.status !== "running") {
        throw new Error("현재 경매 중이 아닙니다.");
      }

      const curId = r.currentPlayerId;
      if (!curId) throw new Error("선택된 선수가 없습니다.");

      const curRef = doc(playersCol, curId);
      const curSnap = await tx.get(curRef);
      if (!curSnap.exists())
        throw new Error("선수 정보를 찾을 수 없습니다.");
      const cur = curSnap.data();

      const highest = r.highestBid ?? 0;
      const g = normGroup(cur.group);

      if (!r.remainingMode) {
        // 본경매 (A/B)
        if (amount <= 0) {
          throw new Error("0점 이하는 입찰할 수 없습니다.");
        }
        if (amount % BID_STEP !== 0) {
          throw new Error(`입찰은 ${BID_STEP}점 단위만 가능합니다.`);
        }
        if (amount < highest + BID_STEP) {
          throw new Error(`최소 ${BID_STEP}점 이상 올려야 합니다.`);
        }
        if (g === "A" && amount < GROUP_A_MIN_BID) {
          throw new Error(
            `GROUP A 선수는 최소 ${GROUP_A_MIN_BID}점 이상부터 입찰 가능합니다.`
          );
        }
      } else {
        // 유찰 재경매 모드: 0점 허용, 현재가 이상이면 OK
        if (amount < 0) {
          throw new Error("0점 이상으로 입력해 주세요.");
        }
        if (amount < highest) {
          throw new Error(
            "현재 입찰가보다 같거나 높은 금액만 입력할 수 있습니다."
          );
        }
      }

      const teamRef = doc(teamsCol, teamId);
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists()) throw new Error("팀 정보를 찾을 수 없습니다.");
      const t = teamSnap.data();
      const remain = t.pointsRemaining ?? TEAM_START_POINTS;
      if (amount > remain) {
        throw new Error("잔여 포인트보다 많이 입찰할 수 없습니다.");
      }

      const teamLabel =
        TEAM_LABEL_BY_ID[teamId] || t.name || teamId;

      tx.update(roomRef, {
        highestBid: amount,
        highestBidderId: teamId,
        highestBidderName: teamLabel,
        lastBidAtMs: Date.now(),
      });

      const logRef = doc(logsCol);
      tx.set(logRef, {
        createdAt: serverTimestamp(),
        teamId,
        teamLabel,
        playerId: curId,
        playerName: cur.name || curId,
        amount,
        group: g,
      });
    });

    input.value = "";
  } catch (err) {
    console.error(err);
    alert(err.message || "입찰 중 오류가 발생했습니다.");
  }
}

// ====== EVENT BINDINGS ======
function bindEvents() {
  const roleSel = $("role-select");
  if (roleSel) {
    myRole = roleSel.value;
    roleSel.addEventListener("change", () => {
      myRole = roleSel.value;
      const adminBox = $("admin-controls");
      if (adminBox) {
        adminBox.style.display = isOperator() ? "inline-flex" : "none";
      }
    });
  }

  const bidBtn = $("bid-button");
  if (bidBtn) bidBtn.addEventListener("click", placeBid);

  const bidInput = $("bid-amount");
  if (bidInput) {
    bidInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") placeBid();
    });
  }

  const btnStartReal = $("btn-start-real");
  if (btnStartReal)
    btnStartReal.addEventListener("click", startMainAuction);

  const btnStartTest = $("btn-start-test");
  if (btnStartTest)
    btnStartTest.addEventListener("click", startMainAuction);

  const btnStartRemaining = $("btn-start-remaining");
  if (btnStartRemaining)
    btnStartRemaining.addEventListener(
      "click",
      startRemainingAuction
    );

  const btnReset = $("btn-reset");
  if (btnReset) btnReset.addEventListener("click", resetAll);
}

bindEvents();
console.log("[app.js] loaded");
