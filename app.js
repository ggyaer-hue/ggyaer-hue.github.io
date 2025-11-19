// app.js
// Firebase 설정값 가져오기
import { firebaseConfig } from "./firebase-config.js";

// Firebase SDK (CDN, v12.6.0) 불러오기
import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";

import {
  getFirestore,
  doc,
  getDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// ====== Firebase 초기화 ======
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 하나의 경매방 id (Firestore에 rooms/room1 문서 필요)
const ROOM_ID = "room1";

// 팀장 정보 (팀당 1000점)
const LEADERS = {
  leader1: { id: "leader1", name: "팀장1", startPoints: 1000 },
  leader2: { id: "leader2", name: "팀장2", startPoints: 1000 },
  leader3: { id: "leader3", name: "팀장3", startPoints: 1000 },
  leader4: { id: "leader4", name: "팀장4", startPoints: 1000 }
};

// ====== DOM 요소 ======
const roleSelect = document.getElementById("role-select");
const bidInput = document.getElementById("bid-amount");
const bidButton = document.getElementById("bid-button");
const bidLog = document.getElementById("bid-log");

const roomStatusDot = document.getElementById("room-status-dot");
const roomStatusText = document.getElementById("room-status-text");
const playerNameSpan = document.getElementById("player-name");
const playerBaseSpan = document.getElementById("player-base");
const playerStatusSpan = document.getElementById("player-status");
const timerSpan = document.getElementById("timer");

const highestAmountSpan = document.getElementById("highest-amount");
const highestLeaderSpan = document.getElementById("highest-leader");

const pointsLeader1 = document.getElementById("points-leader1");
const pointsLeader2 = document.getElementById("points-leader2");
const pointsLeader3 = document.getElementById("points-leader3");
const pointsLeader4 = document.getElementById("points-leader4");

// ====== 상태 ======
let currentRole = "viewer";   // viewer | leader1 | leader2 | leader3 | leader4
let currentPlayerId = null;   // 현재 입찰 중인 선수 ID (player01 등)
let allBids = [];             // 이 방(room1)의 모든 입찰 기록

// ====== 역할 선택 ======
roleSelect.addEventListener("change", () => {
  currentRole = roleSelect.value;
  updateBidButtonState();
});

function updateBidButtonState() {
  const isLeader = currentRole.startsWith("leader");
  bidButton.disabled = !isLeader;
  bidInput.disabled = !isLeader;
}

// ====== 방 정보 실시간 구독 (rooms/room1) ======
const roomRef = doc(db, "rooms", ROOM_ID);

onSnapshot(roomRef, async (snap) => {
  if (!snap.exists()) {
    roomStatusText.textContent = "방 정보 없음 (rooms/room1 문서를 생성하세요)";
    roomStatusDot.className = "status-dot status-finished";
    return;
  }

  const data = snap.data();
  const status = data.status || "waiting";        // waiting | bidding | finished
  const currentId = data.currentPlayerId || null; // 현재 입찰 중인 선수 ID

  // 상태 표시
  if (status === "bidding") {
    roomStatusText.textContent = "진행 중";
    roomStatusDot.className = "status-dot status-bidding";
  } else if (status === "finished") {
    roomStatusText.textContent = "종료";
    roomStatusDot.className = "status-dot status-finished";
  } else {
    roomStatusText.textContent = "대기중";
    roomStatusDot.className = "status-dot status-waiting";
  }

  currentPlayerId = currentId;

  if (currentPlayerId) {
    await loadCurrentPlayer(currentPlayerId);
    renderBids(); // 현재 선수 기준으로 최고 입찰/로그 다시 그림
  } else {
    playerNameSpan.textContent = "-";
    playerBaseSpan.textContent = "-";
    playerStatusSpan.textContent = "-";
    highestAmountSpan.textContent = "-";
    highestLeaderSpan.textContent = "-";
    bidLog.innerHTML = "";
  }

  // 타이머는 아직 로직 없이 표시만
  timerSpan.textContent = "-";
});

// 현재 선수 정보 로딩 (rooms/room1/players/{playerId})
async function loadCurrentPlayer(playerId) {
  const playerRef = doc(db, "rooms", ROOM_ID, "players", playerId);
  const snap = await getDoc(playerRef);

  if (!snap.exists()) {
    playerNameSpan.textContent = "(플레이어 문서 없음)";
    playerBaseSpan.textContent = "-";
    playerStatusSpan.textContent = "-";
    return;
  }

  const p = snap.data();
  playerNameSpan.textContent = p.name || playerId;
  playerBaseSpan.textContent = p.basePrice ?? "-";
  playerStatusSpan.textContent = p.status || "available";
}

// ====== 입찰 내역 실시간 구독 (rooms/room1/bids) ======
const bidsCol = collection(db, "rooms", ROOM_ID, "bids");
const bidsQuery = query(bidsCol, orderBy("createdAt", "asc"));

onSnapshot(bidsQuery, (snap) => {
  allBids = [];
  snap.forEach((d) => {
    allBids.push({ id: d.id, ...d.data() });
  });
  renderBids();
  renderLeaderPoints();
});

// 현재 선수 기준 입찰 로그 + 최고 입찰 표시
function renderBids() {
  bidLog.innerHTML = "";

  if (!currentPlayerId) {
    highestAmountSpan.textContent = "-";
    highestLeaderSpan.textContent = "-";
    return;
  }

  const currentBids = allBids.filter(
    (b) => b.playerId === currentPlayerId
  );

  let highest = 0;
  let highestLeader = "-";

  currentBids.forEach((b) => {
    const li = document.createElement("li");
    li.textContent = `${b.leaderName} : ${b.amount}점`;
    bidLog.appendChild(li);

    if (Number(b.amount) > highest) {
      highest = Number(b.amount);
      highestLeader = b.leaderName;
    }
  });

  if (currentBids.length === 0) {
    highestAmountSpan.textContent = "-";
    highestLeaderSpan.textContent = "-";
  } else {
    highestAmountSpan.textContent = highest;
    highestLeaderSpan.textContent = highestLeader;
  }
}

// 팀장별 사용 포인트 / 남은 포인트 계산
function renderLeaderPoints() {
  const totals = {
    leader1: 0,
    leader2: 0,
    leader3: 0,
    leader4: 0
  };

  allBids.forEach((b) => {
    if (!totals[b.leaderId]) return;
    totals[b.leaderId] += Number(b.amount) || 0;
  });

  const setPointsText = (elem, leaderKey) => {
    const start = LEADERS[leaderKey].startPoints;
    const used = totals[leaderKey];
    const remain = start - used;
    elem.textContent = `${remain} / ${start}`;
  };

  setPointsText(pointsLeader1, "leader1");
  setPointsText(pointsLeader2, "leader2");
  setPointsText(pointsLeader3, "leader3");
  setPointsText(pointsLeader4, "leader4");
}

// ====== 입찰 버튼 클릭 ======
bidButton.addEventListener("click", async () => {
  if (!currentRole.startsWith("leader")) {
    alert("팀장 역할을 선택해야 입찰할 수 있습니다.");
    return;
  }
  if (!currentPlayerId) {
    alert("현재 입찰 중인 선수가 없습니다.");
    return;
  }

  const amount = Number(bidInput.value);
  if (!amount || amount <= 0) {
    alert("입찰 금액을 올바르게 입력하세요.");
    return;
  }

  const leaderInfo = LEADERS[currentRole];
  if (!leaderInfo) {
    alert("알 수 없는 팀장입니다.");
    return;
  }

  // 포인트 체크: 현재 사용합 + 새 입찰 <= startPoints (1000)
  const usedSoFar = allBids
    .filter((b) => b.leaderId === currentRole)
    .reduce((sum, b) => sum + Number(b.amount || 0), 0);

  if (usedSoFar + amount > leaderInfo.startPoints) {
    alert("포인트가 부족합니다. (팀당 1000점 초과)");
    return;
  }

  try {
    await addDoc(collection(db, "rooms", ROOM_ID, "bids"), {
      leaderId: currentRole,
      leaderName: leaderInfo.name,
      playerId: currentPlayerId,
      amount,
      createdAt: serverTimestamp()
    });
    bidInput.value = "";
  } catch (e) {
    console.error(e);
    alert("입찰 중 오류가 발생했습니다. 콘솔을 확인하세요.");
  }
});

// 초기 상태 설정
updateBidButtonState();
