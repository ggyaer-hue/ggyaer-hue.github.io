// app.js (ROOM1, Group A/B only, GitHub photo)
// -------------------------------------------------
import { app, db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, onSnapshot, query, orderBy, limit,
  runTransaction, updateDoc, setDoc, serverTimestamp, increment, writeBatch
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;              // 기본 경매 시간
const BID_STEP = 5;                      // 5점 단위
const TEAM_START_POINTS = 1000;

// ✅ 그룹별 최소 입찰 하한가
const MIN_BID_BY_GROUP = {
  A: 300,  // A는 300점 이상부터
  B: 0     // B는 제한 없음
};

// ====== REFS ======
const roomRef = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol = collection(db, "rooms", ROOM_ID, "teams");
const bidsCol = collection(db, "rooms", ROOM_ID, "bids");

// ====== DOM ======
const roleSelect = document.getElementById("role-select");
const adminControls = document.getElementById("admin-controls");
const btnStartTest = document.getElementById("btn-start-test");
const btnStartReal = document.getElementById("btn-start-real");
const btnStartRemain = document.getElementById("btn-start-remaining");
const btnReset = document.getElementById("btn-reset");

const teamEls = {
  leader1: document.getElementById("team-leader1"),
  leader2: document.getElementById("team-leader2"),
  leader3: document.getElementById("team-leader3"),
  leader4: document.getElementById("team-leader4"),
};

const currentPhoto = document.getElementById("current-player-photo");
const currentName = document.getElementById("current-player-name");
const currentRole = document.getElementById("current-player-role");
const currentGroup = document.getElementById("current-player-group");
const currentBase = document.getElementById("current-player-base");
const currentBio = document.getElementById("current-player-bio");
const currentStatusPill = document.getElementById("current-player-status");

const timerEl = document.getElementById("timer");
const timerPlayerNameEl = document.getElementById("timer-player-name");

const bidInput = document.getElementById("bid-amount");
const bidBtn = document.getElementById("bid-button");
const highestAmountEl = document.getElementById("highest-amount");
const highestLeaderEl = document.getElementById("highest-leader");

const rosterAEl = document.getElementById("roster-A");
const rosterBEl = document.getElementById("roster-B");
const bidLogEl = document.getElementById("bid-log");

const statusDot = document.getElementById("room-status-dot");
const statusText = document.getElementById("room-status-text");
const modeBadge = document.getElementById("mode-badge");

const overlay = document.getElementById("auction-overlay");
const overlayTeam = document.getElementById("auction-overlay-team");
const overlayPhoto = document.getElementById("auction-overlay-photo");
const overlayName = document.getElementById("auction-overlay-name");
const overlayPrice = document.getElementById("auction-overlay-price");

// ====== STATE ======
let myRole = localStorage.getItem("cw_role") || "viewer";
roleSelect.value = myRole;

let roomState = null;
let playersCache = [];     // all players
let teamsCache = {};       // leaderId -> team doc
let timerInterval = null;
let lastOverlayAt = 0;

// ====== HELPERS ======
const PAGE_BASE = location.pathname.endsWith("/")
  ? location.pathname
  : location.pathname.replace(/\/[^\/]*$/, "/");

function resolvePhotoUrl(u){
  if (!u) return "./assets/players/default.png";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return u;
  return PAGE_BASE + u.replace(/^\.\//, "");
}

function formatLeaderName(id){
  const map = {
    leader1: "팀장 1",
    leader2: "팀장 2",
    leader3: "팀장 3",
    leader4: "팀장 4",
    operator: "운영자"
  };
  return map[id] || id || "-";
}

function byOrderIndex(a,b){
  return (a.orderIndex ?? 9999) - (b.orderIndex ?? 9999);
}

function nowMs(){ return Date.now(); }

function startLocalTimer(endsAtMs){
  clearInterval(timerInterval);
  if (!endsAtMs){
    timerEl.textContent = "-";
    return;
  }

  const tick = async ()=>{
    const remain = Math.max(0, Math.floor((endsAtMs - nowMs())/1000));
    timerEl.textContent = remain.toString();
    if (remain <= 0){
      clearInterval(timerInterval);
      // 시간 만료 처리 (누구나 시도 가능, 락으로 1명만 성공)
      await tryFinalizeByTimeout();
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function showOverlaySold(teamId, player, price){
  const t = nowMs();
  if (t - lastOverlayAt < 300) return; // 중복 방지
  lastOverlayAt = t;

  overlayTeam.textContent = `${formatLeaderName(teamId)} 낙찰!`;
  overlayPhoto.src = resolvePhotoUrl(player.photoUrl);
  overlayName.textContent = player.name || player.id;
  overlayPrice.textContent = `${price}점`;

  overlay.classList.add("show");
  setTimeout(()=> overlay.classList.remove("show"), 1200);
}

// ====== ROLE UI ======
roleSelect.addEventListener("change", ()=>{
  myRole = roleSelect.value;
  localStorage.setItem("cw_role", myRole);
  adminControls.style.display = (myRole === "operator") ? "flex" : "none";
  bidBtn.disabled = !(myRole.startsWith("leader"));
});

// ====== INIT DEFAULT DOCS ======
async function ensureTeams(){
  const snap = await getDocs(teamsCol);
  if (!snap.empty) return;

  const batch = writeBatch(db);
  ["leader1","leader2","leader3","leader4"].forEach((id,i)=>{
    batch.set(doc(teamsCol,id), {
      name: `TEAM ${i+1}`,
      points: TEAM_START_POINTS,
      color: id,
      createdAt: serverTimestamp()
    }, {merge:true});
  });
  await batch.commit();
}

async function ensureRoom(){
  const snap = await getDoc(roomRef);
  if (snap.exists()) return;

  await setDoc(roomRef, {
    title: "팀원 경매",
    status: "waiting",       // waiting | bidding | finished
    currentGroup: "A",       // A | B
    currentPlayerId: null,
    endsAtMs: null,
    highestBid: 0,
    highestLeaderId: null,
    remainingAuction: false,
    remainingQueue: [],
    roundId: 0,
    testMode: false,
    finalizing: false,
    updatedAt: serverTimestamp()
  }, {merge:true});
}

// ====== SNAPSHOTS ======
function listenRoom(){
  onSnapshot(roomRef, (snap)=>{
    roomState = snap.data() || {};
    renderRoom();
    renderCurrent();
    renderBidStats();
    renderGroupRosters();

    startLocalTimer(roomState.endsAtMs);
  });
}

function listenPlayers(){
  const qPlayers = query(playersCol, orderBy("orderIndex","asc"));
  onSnapshot(qPlayers, (snap)=>{
    playersCache = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderCurrent();
    renderGroupRosters();
    renderTeams();
  });
}

function listenTeams(){
  onSnapshot(teamsCol, (snap)=>{
    teamsCache = {};
    snap.docs.forEach(d=> teamsCache[d.id] = {id:d.id, ...d.data()});
    renderTeams();
  });
}

function listenBids(){
  const qBids = query(bidsCol, orderBy("createdAt","desc"), limit(60));
  onSnapshot(qBids, (snap)=>{
    const bids = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderBidLog(bids);
  });
}

// ====== RENDER ======
function renderRoom(){
  const st = roomState?.status || "waiting";
  statusText.textContent = (st==="bidding" ? "경매중" : st==="finished" ? "종료" : "대기중");
  statusDot.className = "dot " + (st==="bidding" ? "bidding" : st==="finished" ? "finished" : "");
  modeBadge.textContent = `ROOM1 · ${roomState?.testMode ? "TEST" : "REAL"} · ${roomState?.currentGroup || "A"}`;

  adminControls.style.display = (myRole==="operator") ? "flex" : "none";
  bidBtn.disabled = !(myRole.startsWith("leader"));
}

function findCurrentPlayer(){
  const id = roomState?.currentPlayerId;
  if (!id) return null;
  return playersCache.find(p=>p.id===id) || null;
}

function renderCurrent(){
  const p = findCurrentPlayer();
  if (!p){
    currentPhoto.src = resolvePhotoUrl(null);
    currentName.textContent = "-";
    currentRole.textContent = "-";
    currentGroup.textContent = "-";
    currentBase.textContent = "-";
    currentBio.textContent = "-";
    currentStatusPill.textContent = "대기";
    timerPlayerNameEl.textContent = "-";
    bidInput.placeholder = "입찰 금액(5점 단위)";
    return;
  }

  currentPhoto.src = resolvePhotoUrl(p.photoUrl);
  currentName.textContent = p.name || p.id;
  currentRole.textContent = p.role || "-";
  currentGroup.textContent = p.group || "-";
  currentBase.textContent = p.basePrice ?? 0;
  currentBio.textContent = p.bio || "";
  currentStatusPill.textContent = roomState?.status==="bidding" ? "입찰중" : "대기";
  timerPlayerNameEl.textContent = p.name || p.id;

  // ✅ 그룹 하한가 안내 포함
  const minByGroup = MIN_BID_BY_GROUP[p.group] ?? 0;
  bidInput.placeholder = `입찰 금액(5점 단위) · ${p.group} 최소 ${minByGroup}점`;
}

function renderBidStats(){
  highestAmountEl.textContent = roomState?.highestBid ?? "-";
  highestLeaderEl.textContent = formatLeaderName(roomState?.highestLeaderId);
}

function renderBidLog(allBids){
  bidLogEl.innerHTML = "";
  if (!roomState) return;

  const curId = roomState.currentPlayerId;
  const roundId = roomState.roundId ?? 0;

  const bids = allBids
    .filter(b=>b.playerId===curId && (b.roundId ?? 0)===roundId)
    .sort((a,b)=>(a.createdAt?.seconds||0)-(b.createdAt?.seconds||0));

  if (bids.length===0){
    bidLogEl.innerHTML = `<div class="item" style="color:#8fa0c8;">입찰 로그 없음</div>`;
    return;
  }

  bids.forEach(b=>{
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = `${formatLeaderName(b.leaderId)} · ${b.amount}점`;
    bidLogEl.appendChild(div);
  });

  bidLogEl.scrollTop = bidLogEl.scrollHeight;
}

function renderTeams(){
  // players based roster (status sold)
  const soldPlayers = playersCache.filter(p=>p.status==="sold" && p.assignedTeamId);

  ["leader1","leader2","leader3","leader4"].forEach((leaderId,idx)=>{
    const t = teamsCache[leaderId] || {name:`TEAM ${idx+1}`, points:TEAM_START_POINTS};
    const list = soldPlayers.filter(p=>p.assignedTeamId===leaderId)
      .sort((a,b)=>(a.soldAtMs??0)-(b.soldAtMs??0));

    const el = teamEls[leaderId];
    el.style.setProperty("--team-color",
      leaderId==="leader1" ? "#7aa2ff" :
      leaderId==="leader2" ? "#ff7ad6" :
      leaderId==="leader3" ? "#62e7a7" :
      "#ffcc66"
    );

    el.innerHTML = `
      <div class="team-header">
        <div class="team-name">${t.name || `TEAM ${idx+1}`}</div>
        <div class="team-points">${t.points ?? TEAM_START_POINTS} / ${TEAM_START_POINTS}</div>
      </div>
      <div class="team-row">
        ${Array.from({length:5}).map((_,i)=>{
          const p = list[i];
          if (!p){
            return `<div class="slot empty"><div class="slot-name">EMPTY</div></div>`;
          }
          return `
            <div class="slot">
              <img src="${resolvePhotoUrl(p.photoUrl)}" alt="${p.name}">
              <div class="slot-text">
                <div class="slot-name">${p.name}</div>
                <div class="slot-price">${p.finalPrice ?? 0}점</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  });
}

function renderGroupRosters(){
  const cur = roomState?.currentPlayerId;

  const aList = playersCache.filter(p=>p.group==="A" && p.status!=="sold").sort(byOrderIndex);
  const bList = playersCache.filter(p=>p.group==="B" && p.status!=="sold").sort(byOrderIndex);

  rosterAEl.innerHTML = aList.map(p=>renderAvatar(p, cur)).join("");
  rosterBEl.innerHTML = bList.map(p=>renderAvatar(p, cur)).join("");
}

function renderAvatar(p, curId){
  const cls = [
    "avatar",
    p.id===curId ? "current" : "",
    p.status==="sold" ? "sold" : "",
    p.soldBy ? `sold-by-${p.soldBy}` : ""
  ].filter(Boolean).join(" ");

  return `
    <div class="${cls}">
      <img src="${resolvePhotoUrl(p.photoUrl)}" alt="${p.name}">
      <div class="name-tip">${p.name || p.id}</div>
    </div>
  `;
}

// ====== AUCTION FLOW ======
async function pickFirstAvailable(group){
  const list = playersCache.filter(p=>p.group===group && p.status==="available").sort(byOrderIndex);
  return list[0] || null;
}

function getNextPlayer(currentGroup){
  const listSame = playersCache.filter(p=>p.group===currentGroup && p.status==="available").sort(byOrderIndex);
  if (listSame.length>0) return {player:listSame[0], group:currentGroup};

  if (currentGroup==="A"){
    const listB = playersCache.filter(p=>p.group==="B" && p.status==="available").sort(byOrderIndex);
    if (listB.length>0) return {player:listB[0], group:"B"};
  }
  return {player:null, group:currentGroup};
}

async function startAuction(isTest){
  const firstA = await pickFirstAvailable("A");
  if (!firstA){
    alert("A그룹에 남은 선수가 없습니다.");
    return;
  }
  const endsAtMs = nowMs() + AUCTION_SECONDS*1000;

  await updateDoc(roomRef, {
    status:"bidding",
    testMode: !!isTest,
    currentGroup:"A",
    currentPlayerId:firstA.id,
    endsAtMs,
    highestBid:0,
    highestLeaderId:null,
    remainingAuction:false,
    finalizing:false,
    updatedAt: serverTimestamp()
  });
}

async function startRemainingAuction(){
  // unsold queue 기반
  const remains = playersCache.filter(p=>p.status==="unsold");
  if (remains.length===0){
    alert("유찰된 선수가 없습니다.");
    return;
  }
  const next = remains.sort(byOrderIndex)[0];
  await updateDoc(roomRef,{
    status:"bidding",
    remainingAuction:true,
    currentPlayerId:next.id,
    currentGroup:next.group || "A",
    endsAtMs: nowMs()+AUCTION_SECONDS*1000,
    highestBid:0,
    highestLeaderId:null,
    finalizing:false,
    updatedAt: serverTimestamp()
  });
}

async function resetAll(){
  // teams points reset + players reset + room reset(라운드 증가)
  const roundId = (roomState?.roundId ?? 0) + 1;

  const batch = writeBatch(db);
  ["leader1","leader2","leader3","leader4"].forEach((id,i)=>{
    batch.set(doc(teamsCol,id), {
      name:`TEAM ${i+1}`,
      points: TEAM_START_POINTS
    }, {merge:true});
  });

  playersCache.forEach(p=>{
    batch.update(doc(playersCol,p.id), {
      status:"available",
      assignedTeamId:null,
      finalPrice:null,
      soldBy:null,
      soldAtMs:null
    });
  });

  batch.set(roomRef, {
    status:"waiting",
    testMode:false,
    currentGroup:"A",
    currentPlayerId:null,
    endsAtMs:null,
    highestBid:0,
    highestLeaderId:null,
    remainingAuction:false,
    remainingQueue:[],
    roundId,
    finalizing:false,
    updatedAt: serverTimestamp()
  }, {merge:true});

  await batch.commit();
  alert("전체 리셋 완료");
}

// ====== FINALIZE (sold or unsold) ======
async function tryFinalizeByTimeout() {
  if (!roomState || roomState.status !== "bidding" || !roomState.currentPlayerId) return;

  // 트랜잭션 안에서 query를 못 쓰니까, 다음 선수 계산은 캐시로
  const cachedPlayers = playersCache.slice();
  const currentGroupLocal = roomState.currentGroup || "A";

  try {
    await runTransaction(db, async (tx) => {
      // 1) 모든 read를 먼저 끝낸다
      const roomSnap = await tx.get(roomRef);
      const room = roomSnap.data();
      if (!room || room.status !== "bidding") return;
      if (room.finalizing) return;

      const curId = room.currentPlayerId;
      if (!curId) return;

      const playerRef = doc(playersCol, curId);
      const playerSnap = await tx.get(playerRef);
      const player = playerSnap.data();
      if (!player) return;

      const highestBid = room.highestBid ?? 0;
      const winnerId = room.highestLeaderId || null;

      // 우승 팀도 여기서 읽기까지 끝내기 (read 완료 후에만 write)
      let teamRef = null;
      let team = null;
      if (highestBid > 0 && winnerId) {
        teamRef = doc(teamsCol, winnerId);
        const teamSnap = await tx.get(teamRef);
        team = teamSnap.data() || { points: TEAM_START_POINTS };
      }

      // 캐시 기반으로 다음 선수 계산 (여기도 read만)
      const listSame = cachedPlayers
        .filter(p => p.group === currentGroupLocal && p.status === "available" && p.id !== curId)
        .sort(byOrderIndex);

      let nextPlayer = listSame[0] || null;
      let nextGroup = currentGroupLocal;

      if (!nextPlayer && currentGroupLocal === "A") {
        const listB = cachedPlayers
          .filter(p => p.group === "B" && p.status === "available")
          .sort(byOrderIndex);
        nextPlayer = listB[0] || null;
        if (nextPlayer) nextGroup = "B";
      }

      const endsAtMs = nextPlayer ? nowMs() + AUCTION_SECONDS * 1000 : null;
      const newStatus = nextPlayer ? "bidding" : "finished";

      // 2) 여기부터가 write 구간
      const roomPatch = {
        status: newStatus,
        currentGroup: nextGroup,
        currentPlayerId: nextPlayer ? nextPlayer.id : null,
        endsAtMs,
        highestBid: 0,
        highestLeaderId: null,
        finalizing: false,
        updatedAt: serverTimestamp()
      };

      if (highestBid > 0 && winnerId && team && (team.points ?? TEAM_START_POINTS) >= highestBid) {
        // ✅ 낙찰
        tx.update(playerRef, {
          status: "sold",
          assignedTeamId: winnerId,
          finalPrice: highestBid,
          soldBy: winnerId,
          soldAtMs: nowMs(),
          updatedAt: serverTimestamp()
        });
        tx.update(teamRef, { points: increment(-highestBid) });

        // overlay 표시용 정보
        roomPatch.lastSold = { playerId: curId, teamId: winnerId, price: highestBid };
      } else {
        // ❌ 유찰 (포인트 부족 포함)
        tx.update(playerRef, {
          status: "unsold",
          finalPrice: null,
          updatedAt: serverTimestamp()
        });
      }

      tx.update(roomRef, roomPatch);
    });
  } catch (e) {
    console.error("finalize error", e);
  }
}

// ====== BIDDING ======
async function placeBid(){
  if (!roomState || roomState.status!=="bidding"){
    alert("경매 중이 아닙니다.");
    return;
  }
  const p = findCurrentPlayer();
  if (!p){
    alert("현재 선수 없음");
    return;
  }
  if (!myRole.startsWith("leader")){
    alert("팀장만 입찰할 수 있어요.");
    return;
  }

  let amt = Number(bidInput.value || 0);
  if (!Number.isFinite(amt)) return;

  // 5단위 체크
  if (amt % BID_STEP !== 0){
    alert(`입찰은 ${BID_STEP}점 단위로만 가능합니다.`);
    return;
  }

  // ✅ 그룹 하한가 적용
  const minByGroup = MIN_BID_BY_GROUP[p.group] ?? 0;

  // basePrice도 같이 고려
  const minAllowed = Math.max(minByGroup, p.basePrice ?? 0);

  if (amt < minAllowed){
    alert(`${p.group}그룹은 최소 ${minAllowed}점 이상부터 입찰 가능합니다.`);
    return;
  }

  const highest = roomState.highestBid ?? 0;
  if (amt <= highest){
    alert(`현재 최고가(${highest}점)보다 높게 입찰해야 합니다.`);
    return;
  }
  if ((amt - highest) < BID_STEP && highest>0){
    alert(`최소 ${BID_STEP}점 이상 올려야 합니다.`);
    return;
  }

  try{
    await runTransaction(db, async(tx)=>{
      const roomSnap = await tx.get(roomRef);
      const room = roomSnap.data();
      if (!room || room.status!=="bidding") throw new Error("not bidding");
      if (room.currentPlayerId !== p.id) throw new Error("player changed");

      const teamRef = doc(teamsCol, myRole);
      const teamSnap = await tx.get(teamRef);
      const team = teamSnap.data() || {points:TEAM_START_POINTS};

      const pts = team.points ?? TEAM_START_POINTS;
      if (pts < amt) throw new Error("points 부족");

      // 다시 하한가 검증 (동시성)
      const minAllowed2 = Math.max(MIN_BID_BY_GROUP[p.group] ?? 0, p.basePrice ?? 0);
      if (amt < minAllowed2) throw new Error("하한가 미만");

      tx.update(roomRef, {
        highestBid: amt,
        highestLeaderId: myRole,
        updatedAt: serverTimestamp()
      });

      // bid log 저장 (roundId로 필터)
      const bidRef = doc(bidsCol);
      tx.set(bidRef, {
        roundId: room.roundId ?? 0,
        playerId: p.id,
        leaderId: myRole,
        amount: amt,
        createdAt: serverTimestamp()
      });
    });

    bidInput.value = "";
  }catch(e){
    const msg = e.message || "";
    if (msg.includes("points")) alert("팀 포인트가 부족합니다.");
    else if (msg.includes("하한가")) alert("그룹 최소 입찰가 미만입니다.");
    else alert("입찰 실패(동시 갱신). 다시 시도!");
  }
}

bidBtn.addEventListener("click", placeBid);
bidInput.addEventListener("keydown",(e)=>{
  if (e.key==="Enter") placeBid();
});

// ====== ADMIN BUTTONS ======
btnStartTest?.addEventListener("click", ()=> startAuction(true));
btnStartReal?.addEventListener("click", ()=> startAuction(false));
btnStartRemain?.addEventListener("click", startRemainingAuction);
btnReset?.addEventListener("click", resetAll);

// ====== SOLD OVERLAY LISTENER ======
onSnapshot(roomRef, (snap)=>{
  const r = snap.data();
  if (r?.lastSold){
    const {playerId, teamId, price} = r.lastSold;
    const player = playersCache.find(p=>p.id===playerId);
    if (player){
      showOverlaySold(teamId, player, price);
    }
  }
});

// ====== BOOT ======
(async function boot(){
  await ensureTeams();
  await ensureRoom();

  listenRoom();
  listenPlayers();
  listenTeams();
  listenBids();
})();
