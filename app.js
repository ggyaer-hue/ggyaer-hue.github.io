// app.js (ROOM1, Group A/B only, GitHub photos)
// -------------------------------------------------
import { app, db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, onSnapshot, query, orderBy, limit,
  runTransaction, updateDoc, setDoc, serverTimestamp, increment, writeBatch, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;              // 기본 경매 시간
const BID_STEP = 5;                      // 5점 단위
const TEAM_START_POINTS = 1000;

// ✅ 그룹별 최소 입찰 하한가 (요청 반영)
const MIN_BID_BY_GROUP = {
  A: 300,  // A는 300점 이상
  B: 0     // B는 0점부터
};

// ====== REFS ======
const roomRef = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol   = collection(db, "rooms", ROOM_ID, "teams");
const bidsCol    = collection(db, "rooms", ROOM_ID, "bids");

// ====== DOM (없어도 죽지 않게 안전 처리) ======
const $ = (id)=>document.getElementById(id);

const roleSelect       = $("role-select");
const adminControls    = $("admin-controls");
const btnStartTest     = $("btn-start-test");
const btnStartReal     = $("btn-start-real");
const btnStartRemain   = $("btn-start-remaining");
const btnReset         = $("btn-reset");

const teamEls = {
  leader1: $("team-leader1"),
  leader2: $("team-leader2"),
  leader3: $("team-leader3"),
  leader4: $("team-leader4"),
};

const currentPhoto     = $("current-player-photo");
const currentName      = $("current-player-name");
const currentRole      = $("current-player-role");
const currentGroup     = $("current-player-group");
const currentBase      = $("current-player-base");
const currentBio       = $("current-player-bio");
const currentStatusPill= $("current-player-status");

const timerEl          = $("timer");
const timerPlayerNameEl= $("timer-player-name");

const bidInput         = $("bid-amount");
const bidBtn           = $("bid-button");
const highestAmountEl  = $("highest-amount");
const highestLeaderEl  = $("highest-leader");

const rosterAEl        = $("roster-A");
const rosterBEl        = $("roster-B");
const bidLogEl         = $("bid-log");

const statusDot        = $("room-status-dot");
const statusText       = $("room-status-text");
const modeBadge        = $("mode-badge");

// overlay는 있으면 쓰고 없으면 무시
const overlay          = $("auction-overlay");
const overlayTeam      = $("auction-overlay-team");
const overlayPhoto     = $("auction-overlay-photo");
const overlayName      = $("auction-overlay-name");
const overlayPrice     = $("auction-overlay-price");

// ====== STATE ======
let myRole = localStorage.getItem("cw_role") || "viewer";
if (roleSelect) roleSelect.value = myRole;

let roomState = null;
let playersCache = [];
let teamsCache = {};
let timerInterval = null;

let lastOverlayKey = null;
let lastOverlayAt = 0;

// ====== HELPERS ======
const PAGE_BASE = location.pathname.endsWith("/")
  ? location.pathname
  : location.pathname.replace(/\/[^\/]*$/, "/");

function resolvePhotoUrl(u){
  if (!u) return "./assets/players/default.png";
  if (/^https?:\/\//i.test(u)) return u;

  let cleaned = u.toString().trim();

  // ✅ 흔한 오타 자동 보정: players01.png -> player01.png
  cleaned = cleaned
    .replace("/assets/players/players", "/assets/players/player")
    .replace("assets/players/players", "assets/players/player");

  // ✅ GitHub Pages에서는 "/assets/..."가 루트로 가서 404남 → repo 상대경로로 변환
  if (cleaned.startsWith("/")) cleaned = cleaned.slice(1);

  // "./assets/..."도 정리
  if (cleaned.startsWith("./")) cleaned = cleaned.slice(2);

  return PAGE_BASE + cleaned;
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
  if (!timerEl) return;
  if (!endsAtMs){
    timerEl.textContent = "-";
    return;
  }

  const tick = async ()=>{
    const remain = Math.max(0, Math.floor((endsAtMs - nowMs())/1000));
    timerEl.textContent = remain.toString();
    if (remain <= 0){
      clearInterval(timerInterval);
      await tryFinalizeByTimeout(); // 타임아웃 자동 처리
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function showOverlaySold(teamId, player, price){
  if (!overlay) return;
  const t = nowMs();
  if (t - lastOverlayAt < 300) return;
  lastOverlayAt = t;

  if (overlayTeam) overlayTeam.textContent = `${formatLeaderName(teamId)} 낙찰!`;
  if (overlayPhoto) overlayPhoto.src = resolvePhotoUrl(player.photoUrl);
  if (overlayName) overlayName.textContent = player.name || player.id;
  if (overlayPrice) overlayPrice.textContent = `${price}점`;

  overlay.classList.add("show");
  setTimeout(()=> overlay.classList.remove("show"), 1200);
}

// ====== ROLE UI ======
if (roleSelect){
  roleSelect.addEventListener("change", ()=>{
    myRole = roleSelect.value;
    localStorage.setItem("cw_role", myRole);
    if (adminControls) adminControls.style.display = (myRole === "operator") ? "flex" : "none";
    if (bidBtn) bidBtn.disabled = !(myRole.startsWith("leader"));
  });
}

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
    lastSold: null,
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

    // overlay (중복 재생 방지)
    if (roomState.lastSold){
      const k = JSON.stringify(roomState.lastSold);
      if (k !== lastOverlayKey){
        lastOverlayKey = k;
        const {playerId, teamId, price} = roomState.lastSold;
        const player = playersCache.find(p=>p.id===playerId);
        if (player) showOverlaySold(teamId, player, price);
      }
    }
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
  // 단일 orderBy만 사용(복합인덱스 요구 X)
  const qBids = query(bidsCol, orderBy("createdAt","desc"), limit(80));
  onSnapshot(qBids, (snap)=>{
    const bids = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderBidLog(bids);
  });
}

// ====== RENDER ======
function renderRoom(){
  const st = roomState?.status || "waiting";
  if (statusText) statusText.textContent =
    (st==="bidding" ? "경매중" : st==="finished" ? "종료" : "대기중");

  if (statusDot){
    statusDot.className = "dot " +
      (st==="bidding" ? "bidding" : st==="finished" ? "finished" : "");
  }

  if (modeBadge){
    modeBadge.textContent = `ROOM1 · ${roomState?.testMode ? "TEST" : "REAL"} · ${roomState?.currentGroup || "A"}`;
  }

  if (adminControls) adminControls.style.display = (myRole==="operator") ? "flex" : "none";
  if (bidBtn) bidBtn.disabled = !(myRole.startsWith("leader"));
}

function findCurrentPlayer(){
  const id = roomState?.currentPlayerId;
  if (!id) return null;
  return playersCache.find(p=>p.id===id) || null;
}

function renderCurrent(){
  const p = findCurrentPlayer();
  if (!p){
    if (currentPhoto) currentPhoto.src = resolvePhotoUrl(null);
    if (currentName) currentName.textContent = "-";
    if (currentRole) currentRole.textContent = "-";
    if (currentGroup) currentGroup.textContent = "-";
    if (currentBase) currentBase.textContent = "-";
    if (currentBio) currentBio.textContent = "-";
    if (currentStatusPill) currentStatusPill.textContent = "대기";
    if (timerPlayerNameEl) timerPlayerNameEl.textContent = "-";
    if (bidInput) bidInput.placeholder = "입찰 금액(5점 단위)";
    return;
  }

  if (currentPhoto) currentPhoto.src = resolvePhotoUrl(p.photoUrl);
  if (currentName) currentName.textContent = p.name || p.id;
  if (currentRole) currentRole.textContent = p.role || "-";
  if (currentGroup) currentGroup.textContent = normalizeGroup(p.group) || "-";
  if (currentBase) currentBase.textContent = p.basePrice ?? 0;
  if (currentBio) currentBio.textContent = p.bio || "";
  if (currentStatusPill) currentStatusPill.textContent = (roomState?.status==="bidding" ? "입찰중" : "대기");
  if (timerPlayerNameEl) timerPlayerNameEl.textContent = p.name || p.id;

  const g = normalizeGroup(p.group);
  const minByGroup = MIN_BID_BY_GROUP[g] ?? 0;
  const minAllowed = Math.max(minByGroup, p.basePrice ?? 0);

  if (bidInput){
    bidInput.placeholder = `입찰 금액(5점 단위) · ${g} 최소 ${minAllowed}점`;
  }
}

function renderBidStats(){
  if (highestAmountEl) highestAmountEl.textContent = roomState?.highestBid ?? "-";
  if (highestLeaderEl) highestLeaderEl.textContent = formatLeaderName(roomState?.highestLeaderId);
}

function renderBidLog(allBids){
  if (!bidLogEl || !roomState) return;
  bidLogEl.innerHTML = "";

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
  const soldPlayers = playersCache.filter(p=>p.status==="sold" && p.assignedTeamId);
  ["leader1","leader2","leader3","leader4"].forEach((leaderId,idx)=>{
    const el = teamEls[leaderId];
    if (!el) return;

    const t = teamsCache[leaderId] || {name:`TEAM ${idx+1}`, points:TEAM_START_POINTS};

    const list = soldPlayers
      .filter(p=>p.assignedTeamId===leaderId)
      .sort((a,b)=>(a.soldAtMs??0)-(b.soldAtMs??0));

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
  if (!rosterAEl || !rosterBEl) return;
  const cur = roomState?.currentPlayerId;

  const aList = playersCache
    .filter(p => normalizeGroup(p.group)==="A" && p.status!=="sold")
    .sort(byOrderIndex);

  const bList = playersCache
    .filter(p => normalizeGroup(p.group)==="B" && p.status!=="sold")
    .sort(byOrderIndex);

  rosterAEl.innerHTML = aList.map(p=>renderAvatar(p, cur)).join("");
  rosterBEl.innerHTML = bList.map(p=>renderAvatar(p, cur)).join("");
}

function renderAvatar(p, curId){
  const cls = [
    "avatar",
    p.id===curId ? "current" : "",
    p.status==="sold" ? "sold" : ""
  ].filter(Boolean).join(" ");

  return `
    <div class="${cls}">
      <img src="${resolvePhotoUrl(p.photoUrl)}" alt="${p.name}">
      <div class="name-tip">${p.name || p.id}</div>
    </div>
  `;
}

// ====== AUCTION FLOW ======
function pickFirstAvailableInGroup(group){
  const g = normalizeGroup(group);
  const list = playersCache
    .filter(p => normalizeGroup(p.group)===g && p.status==="available")
    .sort(byOrderIndex);
  return list[0] || null;
}

function getNextPlayer(currentGroup, currentId){
  const g = normalizeGroup(currentGroup);

  // 같은 그룹에서 다음
  const same = playersCache
    .filter(p => normalizeGroup(p.group)===g && p.status==="available" && p.id!==currentId)
    .sort(byOrderIndex);
  if (same.length>0) return { player: same[0], group: g };

  // A 끝나면 B로
  if (g==="A"){
    const b = playersCache
      .filter(p => normalizeGroup(p.group)==="B" && p.status==="available")
      .sort(byOrderIndex);
    if (b.length>0) return { player: b[0], group: "B" };
  }

  return { player: null, group: g };
}

async function startAuction(isTest){
  const firstA = pickFirstAvailableInGroup("A");
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
    lastSold:null,
    updatedAt: serverTimestamp()
  });

  // ✅ 운영자 시작 문구
  if (myRole==="operator"){
    alert(isTest ? "테스트 경매 시작!" : "본경매 시작!");
  }
}

async function startRemainingAuction(){
  const remains = playersCache.filter(p=>p.status==="unsold").sort(byOrderIndex);
  if (remains.length===0){
    alert("유찰된 선수가 없습니다.");
    return;
  }
  const next = remains[0];
  await updateDoc(roomRef,{
    status:"bidding",
    remainingAuction:true,
    currentPlayerId:next.id,
    currentGroup: normalizeGroup(next.group) || "A",
    endsAtMs: nowMs()+AUCTION_SECONDS*1000,
    highestBid:0,
    highestLeaderId:null,
    finalizing:false,
    lastSold:null,
    updatedAt: serverTimestamp()
  });
}

async function resetAll(){
  if (myRole!=="operator"){
    alert("운영자만 리셋할 수 있어요.");
    return;
  }

  const roundId = (roomState?.roundId ?? 0) + 1;

  // teams + players reset
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
    lastSold:null,
    updatedAt: serverTimestamp()
  }, {merge:true});

  await batch.commit();

  // bids 로그 삭제(가능한 만큼)
  try{
    const bidsSnap = await getDocs(bidsCol);
    const delBatch = writeBatch(db);
    bidsSnap.docs.forEach(d=>delBatch.delete(d.ref));
    await delBatch.commit();
  }catch(e){
    console.warn("bids clear failed:", e);
  }

  alert("전체 리셋 완료");
}

// ====== FINALIZE (sold or unsold) ======
async function tryFinalizeByTimeout() {
  if (!roomState || roomState.status !== "bidding" || !roomState.currentPlayerId) return;

  const cachedPlayers = playersCache.slice();
  const currentGroupLocal = normalizeGroup(roomState.currentGroup || "A");
  const currentIdLocal = roomState.currentPlayerId;

  try {
    await runTransaction(db, async (tx) => {
      // 1) READS FIRST
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
      const winnerId  = room.highestLeaderId || null;

      let teamRef = null, team = null;
      if (highestBid > 0 && winnerId){
        teamRef = doc(teamsCol, winnerId);
        const teamSnap = await tx.get(teamRef);
        team = teamSnap.data() || { points: TEAM_START_POINTS };
      }

      // next (cache)
      let nextPlayer = null;
      let nextGroup = currentGroupLocal;

      const same = cachedPlayers
        .filter(p => normalizeGroup(p.group)===currentGroupLocal && p.status==="available" && p.id!==curId)
        .sort(byOrderIndex);

      if (same.length>0){
        nextPlayer = same[0];
      } else if (currentGroupLocal==="A"){
        const b = cachedPlayers
          .filter(p => normalizeGroup(p.group)==="B" && p.status==="available")
          .sort(byOrderIndex);
        if (b.length>0){
          nextPlayer = b[0];
          nextGroup = "B";
        }
      }

      const endsAtMs = nextPlayer ? nowMs() + AUCTION_SECONDS*1000 : null;
      const newStatus = nextPlayer ? "bidding" : "finished";

      // 2) WRITES
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

      if (highestBid > 0 && winnerId && team && (team.points ?? TEAM_START_POINTS) >= highestBid){
        // SOLD
        tx.update(playerRef, {
          status: "sold",
          assignedTeamId: winnerId,
          finalPrice: highestBid,
          soldBy: winnerId,
          soldAtMs: nowMs(),
          updatedAt: serverTimestamp()
        });
        tx.update(teamRef, { points: increment(-highestBid) });
        roomPatch.lastSold = { playerId: curId, teamId: winnerId, price: highestBid };
      } else {
        // UNSOLD / no bid / points 부족
        tx.update(playerRef, {
          status: "unsold",
          finalPrice: null,
          updatedAt: serverTimestamp()
        });
        roomPatch.lastSold = null;
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

  let amt = Number(bidInput?.value || 0);
  if (!Number.isFinite(amt)) return;

  if (amt % BID_STEP !== 0){
    alert(`입찰은 ${BID_STEP}점 단위로만 가능합니다.`);
    return;
  }

  const g = normalizeGroup(p.group);
  const minByGroup = MIN_BID_BY_GROUP[g] ?? 0;
  const minAllowed = Math.max(minByGroup, p.basePrice ?? 0);

  if (amt < minAllowed){
    alert(`${g}그룹은 최소 ${minAllowed}점 이상부터 입찰 가능합니다.`);
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
      // READS FIRST
      const roomSnap = await tx.get(roomRef);
      const room = roomSnap.data();
      if (!room || room.status!=="bidding") throw new Error("not bidding");
      if (room.currentPlayerId !== p.id) throw new Error("player changed");

      const teamRef = doc(teamsCol, myRole);
      const teamSnap = await tx.get(teamRef);
      const team = teamSnap.data() || {points:TEAM_START_POINTS};

      const pts = team.points ?? TEAM_START_POINTS;
      if (pts < amt) throw new Error("points 부족");

      const minAllowed2 = Math.max(MIN_BID_BY_GROUP[g] ?? 0, p.basePrice ?? 0);
      if (amt < minAllowed2) throw new Error("하한가 미만");

      // WRITES
      tx.update(roomRef, {
        highestBid: amt,
        highestLeaderId: myRole,
        updatedAt: serverTimestamp()
      });

      const bidRef = doc(bidsCol);
      tx.set(bidRef, {
        roundId: room.roundId ?? 0,
        playerId: p.id,
        leaderId: myRole,
        amount: amt,
        createdAt: serverTimestamp()
      });
    });

    if (bidInput) bidInput.value = "";
  }catch(e){
    const msg = e.message || "";
    if (msg.includes("points")) alert("팀 포인트가 부족합니다.");
    else if (msg.includes("하한가")) alert("그룹 최소 입찰가 미만입니다.");
    else alert("입찰 실패(동시 갱신). 다시 시도!");
  }
}

if (bidBtn) bidBtn.addEventListener("click", placeBid);
if (bidInput){
  bidInput.addEventListener("keydown",(e)=>{
    if (e.key==="Enter") placeBid();
  });
}

// ====== ADMIN BUTTONS ======
if (btnStartTest)  btnStartTest.addEventListener("click", ()=> startAuction(true));
if (btnStartReal)  btnStartReal.addEventListener("click", ()=> startAuction(false));
if (btnStartRemain)btnStartRemain.addEventListener("click", startRemainingAuction);
if (btnReset)      btnReset.addEventListener("click", resetAll);

// ====== BOOT ======
(async function boot(){
  await ensureTeams();
  await ensureRoom();
  listenRoom();
  listenPlayers();
  listenTeams();
  listenBids();
})();
