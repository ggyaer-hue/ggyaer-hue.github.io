// app.js
import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, onSnapshot,
  collection, addDoc, query, orderBy, where, limit,
  serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

/* ===================== 기본 설정 ===================== */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const ROOM_ID = "room1";
const ROUND_SECONDS = 30; // 라운드 시간(초)

/* 팀장 정보(포인트 시작값) */
const LEADERS = {
  leader1: { id:"leader1", name:"팀장1", startPoints:1000, teamName:"팀장1 팀" },
  leader2: { id:"leader2", name:"팀장2", startPoints:1000, teamName:"팀장2 팀" },
  leader3: { id:"leader3", name:"팀장3", startPoints:1000, teamName:"팀장3 팀" },
  leader4: { id:"leader4", name:"팀장4", startPoints:1000, teamName:"팀장4 팀" }
};
const ROLES = ["TOP","JGL","MID","BOT","SUP"];

/* ===================== DOM ===================== */
const roleSelect = document.getElementById("role-select");
const bidInput = document.getElementById("bid-amount");
const bidButton = document.getElementById("bid-button");
const bidLogDiv = document.getElementById("bid-log");
const highestAmountSpan = document.getElementById("highest-amount");
const highestLeaderSpan = document.getElementById("highest-leader");
const timerSpan = document.getElementById("timer");
const currentTurnSpan = document.getElementById("current-turn");

const roomStatusDot = document.getElementById("room-status-dot");
const roomStatusText = document.getElementById("room-status-text");

const currentPhoto = document.getElementById("current-player-photo");
const currentName = document.getElementById("current-player-name");
const currentRoleSpan = document.getElementById("current-player-role");
const currentGroupSpan = document.getElementById("current-player-group");
const currentBase = document.getElementById("current-player-base");
const currentStatus = document.getElementById("current-player-status");
const currentBio = document.getElementById("current-player-bio");

const teamCards = {
  leader1: document.getElementById("team-leader1"),
  leader2: document.getElementById("team-leader2"),
  leader3: document.getElementById("team-leader3"),
  leader4: document.getElementById("team-leader4"),
};

const rosterGroupContainers = {
  A: document.getElementById("roster-A"),
  B: document.getElementById("roster-B"),
  C: document.getElementById("roster-C"),
};

/* ===================== 상태 ===================== */
let selectedRole = "viewer";
let roomData = null;
let currentPlayerId = null;
let playersMap = new Map();     // playerId -> playerData
let allPlayers = [];           // array
let teamsMap = new Map();      // leaderId -> teamData
let allBids = [];              // bids array

/* ===================== 역할 선택 ===================== */
roleSelect.addEventListener("change", () => {
  selectedRole = roleSelect.value;
  updateBidButtonState();
});

/* ===================== 방/선수/팀/입찰 구독 ===================== */
const roomRef = doc(db, "rooms", ROOM_ID);
onSnapshot(roomRef, async (snap) => {
  if (!snap.exists()) {
    roomStatusText.textContent = "rooms/room1 문서가 없습니다";
    roomStatusDot.className = "dot finished";
    roomData = null;
    stopTimer();
    updateBidButtonState();
    return;
  }
  roomData = snap.data();
  currentPlayerId = roomData.currentPlayerId || null;

  renderRoomStatus(roomData);
  renderTurnBadge(roomData);
  updateBidButtonState();
  await renderCurrentPlayer(currentPlayerId);
  renderRosterByGroup(allPlayers, currentPlayerId);
  startTimerIfNeeded(roomData);
});

onSnapshot(collection(db, "rooms", ROOM_ID, "players"), (snap) => {
  playersMap = new Map();
  allPlayers = [];
  snap.forEach(d => {
    const p = { id: d.id, ...d.data() };
    playersMap.set(d.id, p);
    allPlayers.push(p);
  });
  renderRosterByGroup(allPlayers, currentPlayerId);
  renderTeams();
  renderCurrentPlayer(currentPlayerId);
});

onSnapshot(collection(db, "rooms", ROOM_ID, "teams"), (snap) => {
  teamsMap = new Map();
  snap.forEach(d => teamsMap.set(d.id, { id:d.id, ...d.data() }));
  renderTeams();
  updateBidButtonState();
});

const bidsCol = collection(db, "rooms", ROOM_ID, "bids");
const bidsQuery = query(bidsCol, orderBy("createdAt", "asc"));
onSnapshot(bidsQuery, (snap) => {
  allBids = [];
  snap.forEach(d => allBids.push({ id:d.id, ...d.data() }));
  renderBids();
});

/* ===================== 렌더링 ===================== */
function renderRoomStatus(data){
  const status = data.status || "waiting";
  roomStatusText.textContent = status === "bidding" ? "진행 중"
                          : status === "finished" ? "종료"
                          : "대기중";
  roomStatusDot.className = "dot " + (status === "bidding" ? "bidding"
                            : status === "finished" ? "finished"
                            : "");
}

function renderTurnBadge(data){
  const order = data.snakeOrder || ["leader1","leader2","leader3","leader4"];
  const idx = data.turnIndex ?? 0;
  const dir = data.direction ?? 1;
  const leaderId = order[idx];
  const leaderName = LEADERS[leaderId]?.name || leaderId;
  const group = data.currentGroup || "-";
  currentTurnSpan.textContent = `${group}그룹 · ${leaderName} 턴 (${dir===1?"정방향":"역방향"})`;
}

async function renderCurrentPlayer(playerId){
  if(!playerId){
    currentPhoto.src = "";
    currentName.textContent = "-";
    currentRoleSpan.textContent = "-";
    currentGroupSpan.textContent = "-";
    currentBase.textContent = "-";
    currentStatus.textContent = "-";
    currentBio.textContent = "-";
    return;
  }
  const p = playersMap.get(playerId);
  if(!p){
    // 혹시 캐시가 늦으면 getDoc로 한 번 더
    const snap = await getDoc(doc(db,"rooms",ROOM_ID,"players",playerId));
    if(!snap.exists()) return;
    const pp = { id:snap.id, ...snap.data() };
    playersMap.set(playerId, pp);
    return renderCurrentPlayer(playerId);
  }

  currentPhoto.src = p.photoUrl || "";
  currentName.textContent = p.name || p.id;
  currentRoleSpan.textContent = (p.role || "-").toUpperCase();
  currentGroupSpan.textContent = (p.group || "-").toUpperCase();
  currentBase.textContent = p.basePrice ?? "-";
  currentStatus.textContent = p.status || "available";
  currentBio.textContent = p.bio || "-";
}

function renderTeams(){
  const playersById = (id)=>playersMap.get(id);

  Object.keys(teamCards).forEach(leaderId=>{
    const el = teamCards[leaderId];
    if(!el) return;

    const info = LEADERS[leaderId];
    const team = teamsMap.get(leaderId);

    const pointsStart = team?.pointsStart ?? info.startPoints;
    const pointsUsed = team?.pointsUsed ?? 0;
    const pointsRemain = pointsStart - pointsUsed;

    const roster = team?.roster || {};
    const slotsHtml = ROLES.map(role=>{
      const pid = roster[role] || null;
      const p = pid ? playersById(pid) : null;
      const img = p?.photoUrl ? `<img src="${p.photoUrl}" />` : "";
      const name = p?.name || role;
      return `
        <div class="slot" title="${name}">
          ${img || role}
          <div class="slot-label">${role}</div>
        </div>
      `;
    }).join("");

    el.innerHTML = `
      <div class="team-header">
        <div>${team?.name || info.teamName}</div>
        <div class="team-points">${pointsRemain} / ${pointsStart}</div>
      </div>
      <div class="team-row">${slotsHtml}</div>
    `;
  });
}

function renderRosterByGroup(players, currentPid){
  Object.values(rosterGroupContainers).forEach(el=> el && (el.innerHTML=""));

  const groups = { A:[], B:[], C:[] };
  players.forEach(p=>{
    const g = (p.group || "A").toUpperCase();
    if(!groups[g]) groups[g]=[];
    groups[g].push(p);
  });

  ["A","B","C"].forEach(g=>{
    const box = rosterGroupContainers[g];
    if(!box) return;

    // group 내부 정렬: role -> order -> id
    groups[g].sort((a,b)=>{
      const ra = (a.role||"").toUpperCase();
      const rb = (b.role||"").toUpperCase();
      if(ra!==rb) return ra.localeCompare(rb);
      const oa = a.order ?? 9999;
      const ob = b.order ?? 9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    });

    groups[g].forEach(p=>{
      const avatar = document.createElement("div");
      avatar.className =
        "avatar" +
        (p.status==="sold" ? " sold" : "") +
        (p.id===currentPid ? " current" : "");

      const img = document.createElement("img");
      img.src = p.photoUrl || "";
      img.alt = p.name || p.id;
      avatar.appendChild(img);

      if(p.tag){
        const badge = document.createElement("div");
        badge.className = "badge " + (p.tag==="MVP" ? "mvp":"new");
        badge.textContent = p.tag;
        avatar.appendChild(badge);
      }

      const tip = document.createElement("div");
      tip.className = "name-tip";
      tip.textContent = `${p.name || p.id} · ${(p.role||"-").toUpperCase()}`;
      avatar.appendChild(tip);

      box.appendChild(avatar);
    });
  });
}

function renderBids(){
  bidLogDiv.innerHTML = "";
  if(!roomData || !currentPlayerId){
    highestAmountSpan.textContent = "-";
    highestLeaderSpan.textContent = "-";
    return;
  }
  const roundId = roomData.roundId ?? 0;
  const bids = allBids.filter(b => b.roundId===roundId && b.playerId===currentPlayerId);

  let max = 0, leader = "-";
  bids.forEach(b=>{
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = `${b.leaderName} : ${b.amount}점`;
    bidLogDiv.appendChild(div);

    if(Number(b.amount) > max){
      max = Number(b.amount);
      leader = b.leaderName;
    }
  });

  highestAmountSpan.textContent = bids.length? max : "-";
  highestLeaderSpan.textContent = bids.length? leader : "-";
}

/* ===================== 입찰 가능 여부 ===================== */
function updateBidButtonState(){
  const isLeader = selectedRole.startsWith("leader");
  if(!isLeader || !roomData || roomData.status!=="bidding"){
    bidButton.disabled = true;
    bidInput.disabled = true;
    return;
  }

  const order = roomData.snakeOrder || ["leader1","leader2","leader3","leader4"];
  const idx = roomData.turnIndex ?? 0;
  const turnLeaderId = order[idx];

  const isMyTurn = selectedRole === turnLeaderId;
  bidButton.disabled = !isMyTurn;
  bidInput.disabled = !isMyTurn;
}

/* ===================== 입찰 버튼 ===================== */
bidButton.addEventListener("click", async () => {
  if(!roomData || roomData.status!=="bidding") return;
  if(!currentPlayerId) return;

  const amount = Number(bidInput.value);
  if(!amount || amount<=0){
    alert("입찰 금액을 입력하세요.");
    return;
  }

  const leaderInfo = LEADERS[selectedRole];
  if(!leaderInfo){
    alert("팀장을 선택하세요.");
    return;
  }

  const team = teamsMap.get(selectedRole);
  const pointsStart = team?.pointsStart ?? leaderInfo.startPoints;
  const pointsUsed = team?.pointsUsed ?? 0;
  const pointsRemain = pointsStart - pointsUsed;
  if(amount > pointsRemain){
    alert("포인트가 부족합니다.");
    return;
  }

  const p = playersMap.get(currentPlayerId);
  const basePrice = p?.basePrice ?? 0;

  // 기본가 미만 금지 + 현재 최고가보다 낮으면 금지
  const currentMax = Number(highestAmountSpan.textContent) || 0;
  if(amount < basePrice){
    alert(`기본가(${basePrice}) 이상으로 입찰하세요.`);
    return;
  }
  if(currentMax && amount <= currentMax){
    alert(`현재 최고가(${currentMax})보다 높게 입찰하세요.`);
    return;
  }

  try{
    await addDoc(collection(db,"rooms",ROOM_ID,"bids"),{
      roundId: roomData.roundId ?? 0,
      playerId: currentPlayerId,
      leaderId: selectedRole,
      leaderName: leaderInfo.name,
      amount,
      createdAt: serverTimestamp()
    });
    bidInput.value="";
  }catch(e){
    console.error(e);
    alert("입찰 오류. 콘솔 확인.");
  }
});

/* ===================== 타이머 ===================== */
let timerInterval = null;

function startTimerFromEndsAt(endsAtMs){
  if(timerInterval) clearInterval(timerInterval);

  const tick = () => {
    const left = Math.max(0, Math.ceil((endsAtMs - Date.now())/1000));
    timerSpan.textContent = left;
    if(left<=0){
      clearInterval(timerInterval);
      timerInterval=null;
      finalizeRound(); // 0초면 낙찰 자동 처리
    }
  };
  tick();
  timerInterval=setInterval(tick, 250);
}

function stopTimer(){
  if(timerInterval) clearInterval(timerInterval);
  timerInterval=null;
  timerSpan.textContent="-";
}

function startTimerIfNeeded(data){
  if(data.status!=="bidding" || !data.roundEndsAt){
    stopTimer();
    return;
  }
  startTimerFromEndsAt(data.roundEndsAt);
}

/* ===================== 낙찰 + 팀 이동 + 다음 턴/선수 ===================== */
async function finalizeRound(){
  const roomRef = doc(db,"rooms",ROOM_ID);

  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    if(!roomSnap.exists()) return;

    const room = roomSnap.data();
    if(room.status!=="bidding") return; // 이미 처리됨

    const roundId = room.roundId ?? 0;
    const playerId = room.currentPlayerId;
    if(!playerId) return;

    // 최고가 1건만 가져오기
    const bidsQ = query(
      collection(db,"rooms",ROOM_ID,"bids"),
      where("roundId","==",roundId),
      where("playerId","==",playerId),
      orderBy("amount","desc"),
      limit(1)
    );
    const bidsSnap = await tx.get(bidsQ);
    if(bidsSnap.empty){
      // 입찰 없음 → 다음 선수/턴만 넘김(가격/팀 없음)
      await moveToNext(tx, room, null, 0);
      return;
    }

    const topBid = bidsSnap.docs[0].data();
    const winnerLeaderId = topBid.leaderId;
    const price = Number(topBid.amount)||0;

    const playerRef = doc(db,"rooms",ROOM_ID,"players",playerId);
    const playerSnap = await tx.get(playerRef);
    if(!playerSnap.exists()) return;
    const player = playerSnap.data();
    const role = (player.role || "TOP").toUpperCase();

    // 선수 sold 처리
    tx.update(playerRef,{
      status:"sold",
      assignedTeamId:winnerLeaderId,
      finalPrice:price
    });

    // 팀 로스터/포인트 업데이트
    const teamRef = doc(db,"rooms",ROOM_ID,"teams",winnerLeaderId);
    const teamSnap = await tx.get(teamRef);
    const team = teamSnap.exists() ? teamSnap.data() : {
      name: LEADERS[winnerLeaderId]?.teamName || winnerLeaderId,
      pointsStart: 1000,
      pointsUsed: 0,
      roster: {}
    };

    const newRoster = { ...(team.roster||{}) };
    newRoster[role] = playerId;

    tx.set(teamRef,{
      ...team,
      pointsUsed: (team.pointsUsed||0) + price,
      roster: newRoster
    },{ merge:true });

    // 다음 턴/선수 이동
    await moveToNext(tx, room, winnerLeaderId, price);
  });
}

async function moveToNext(tx, room, winnerLeaderId, price){
  const order = room.snakeOrder || ["leader1","leader2","leader3","leader4"];
  const last = order.length-1;

  let nextIndex = (room.turnIndex ?? 0) + (room.direction ?? 1);
  let nextDir = room.direction ?? 1;

  if(nextIndex > last){
    nextDir = -1;
    nextIndex = last-1;
  } else if(nextIndex < 0){
    nextDir = 1;
    nextIndex = 1;
  }

  // 다음 선수: 같은 그룹에서 available 첫번째
  const group = (room.currentGroup || "A").toUpperCase();
  const playersSnap = await tx.get(collection(db,"rooms",ROOM_ID,"players"));
  const candidates = playersSnap.docs
    .map(d=>({id:d.id, ...d.data()}))
    .filter(p => (p.group||"A").toUpperCase()===group && p.status!=="sold")
    .sort((a,b)=>{
      const oa=a.order ?? 9999, ob=b.order ?? 9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    });

  const nextPlayer = candidates[0] || null;

  tx.update(doc(db,"rooms",ROOM_ID),{
    turnIndex: nextIndex,
    direction: nextDir,
    currentPlayerId: nextPlayer ? nextPlayer.id : null,
    roundId: (room.roundId ?? 0) + 1,
    roundEndsAt: nextPlayer ? (Date.now() + ROUND_SECONDS*1000) : null,
    // 그룹이 끝났으면 status를 waiting으로 두는 단순 룰
    status: nextPlayer ? "bidding" : "waiting"
  });
}

/* ===================== 초기 버튼 상태 ===================== */
updateBidButtonState();
