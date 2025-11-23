/* ===================== Firebase SDK (module) ===================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  onSnapshot, query, where, limit, serverTimestamp, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

/* ===================== Firebase Config ===================== */
const firebaseConfig = {
  apiKey: "AIzaSyDldhIELEidJQQck4ljtWznalakpXbAGQA",
  authDomain: "cwgauction-8ae37.firebaseapp.com",
  projectId: "cwgauction-8ae37",
  storageBucket: "cwgauction-8ae37.firebasestorage.app",
  messagingSenderId: "44783149326",
  appId: "1:44783149326:web:e6321e381f7ffc4864775f",
  measurementId: "G-48GXGZ32CW"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

/* ===================== ROOM / CONSTANTS ===================== */
const ROOM_ID = "room1";
const AUCTION_SECONDS = 20;
const ROLES = ["TOP","JGL","MID","BOT","SUP"];
const GROUPS = ["A","B"];

const LEADERS = {
  leader1:{ name:"팀장 1", teamName:"TEAM 1", startPoints:1000 },
  leader2:{ name:"팀장 2", teamName:"TEAM 2", startPoints:1000 },
  leader3:{ name:"팀장 3", teamName:"TEAM 3", startPoints:1000 },
  leader4:{ name:"팀장 4", teamName:"TEAM 4", startPoints:1000 },
};
const TEAM_COLORS = {
  leader1:"#7aa2ff", leader2:"#ff7ad6", leader3:"#62e7a7", leader4:"#ffcc66"
};

/* ===================== STATE ===================== */
let roomData = null;
let playersMap = new Map();
let teamsMap = new Map();
let allPlayers = [];
let currentPlayerId = null;
let selectedRole = "viewer";
let timerInterval = null;
let bidsUnsub = null;
let finalizeInProgress = false;

/* ===================== DOM ===================== */
const roleSelect = document.getElementById("role-select");
const adminControls = document.getElementById("admin-controls");
const btnStartTest = document.getElementById("btn-start-test");
const btnStartReal = document.getElementById("btn-start-real");
const btnStartRemaining = document.getElementById("btn-start-remaining");
const btnReset = document.getElementById("btn-reset");

const statusDot = document.getElementById("room-status-dot");
const statusText = document.getElementById("room-status-text");
const modeBadge = document.getElementById("mode-badge");

const currentPhoto = document.getElementById("current-player-photo");
const currentName = document.getElementById("current-player-name");
const currentRoleEl = document.getElementById("current-player-role");
const currentGroupEl = document.getElementById("current-player-group");
const currentBaseEl = document.getElementById("current-player-base");
const currentBioEl = document.getElementById("current-player-bio");
const currentStatusBadge = document.getElementById("current-player-status");

const bidInput = document.getElementById("bid-amount");
const bidButton = document.getElementById("bid-button");
const highestAmountSpan = document.getElementById("highest-amount");
const highestLeaderSpan = document.getElementById("highest-leader");
const bidLog = document.getElementById("bid-log");

const timerEl = document.getElementById("timer");
const timerPlayerNameEl = document.getElementById("timer-player-name");

const overlay = document.getElementById("auction-overlay");
const overlayTeam = document.getElementById("auction-overlay-team");
const overlayPhoto = document.getElementById("auction-overlay-photo");
const overlayName  = document.getElementById("auction-overlay-name");
const overlayPrice = document.getElementById("auction-overlay-price");

const teamCards = {
  leader1: document.getElementById("team-leader1"),
  leader2: document.getElementById("team-leader2"),
  leader3: document.getElementById("team-leader3"),
  leader4: document.getElementById("team-leader4"),
};

/* ===================== HELPERS ===================== */
const normalizeRole = (r)=>{
  const x = String(r||"").toUpperCase();
  if(x.includes("TOP")) return "TOP";
  if(x.includes("JGL") || x.includes("JG") || x.includes("JUNGLE")) return "JGL";
  if(x.includes("MID")) return "MID";
  if(x.includes("BOT") || x.includes("ADC")) return "BOT";
  if(x.includes("SUP") || x.includes("SUPPORT")) return "SUP";
  return x || "TOP";
};
const normalizeGroupAB = (gRaw)=>{
  const m = String(gRaw||"").toUpperCase().match(/[AB]/);
  return m ? m[0] : "B";
};
const roundUp5 = (n)=>{
  n = Number(n||0);
  return n % 5 === 0 ? n : Math.ceil(n/5)*5;
};
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

function stableOrderIndex(p){
  if (typeof p.orderIndex === "number") return p.orderIndex;
  const m = String(p.id || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 999999;
}
function sortCandidates(list){
  return list.slice().sort((a,b)=>{
    const ai = stableOrderIndex(a);
    const bi = stableOrderIndex(b);
    if(ai !== bi) return ai - bi;
    return String(a.name||"").localeCompare(String(b.name||""));
  });
}

/* ===================== LISTENERS ===================== */
function listenRoom(){
  const roomRef = doc(db,"rooms",ROOM_ID);
  onSnapshot(roomRef, snap=>{
    if(!snap.exists()) return;
    roomData = snap.data();
    currentPlayerId = roomData.currentPlayerId || null;
    updateStatusUI();
    updateCurrentPlayerUI();
    startCountdown(roomData.endsAtMs || null);
    listenBidsForCurrent();
  });
}

function listenPlayers(){
  const colRef = collection(db,"rooms",ROOM_ID,"players");
  onSnapshot(colRef, snap=>{
    playersMap.clear();
    snap.forEach(d=>{
      playersMap.set(d.id, {id:d.id, ...d.data()});
    });
    allPlayers = Array.from(playersMap.values());
    renderGroupRosters();
    renderTeams();
    updateCurrentPlayerUI();
  });
}

function listenTeams(){
  const colRef = collection(db,"rooms",ROOM_ID,"teams");
  onSnapshot(colRef, snap=>{
    teamsMap.clear();
    snap.forEach(d=>{
      teamsMap.set(d.id, {id:d.id, ...d.data()});
    });
    renderTeams();
  });
}

/* ===================== BID LOG (ROUND FILTER) ===================== */
function listenBidsForCurrent(){
  if(bidsUnsub) bidsUnsub();
  bidLog.innerHTML = "";
  highestAmountSpan.textContent = "-";
  highestLeaderSpan.textContent = "-";
  if(!currentPlayerId) return;

  const bidsRef = collection(db,"rooms",ROOM_ID,"bids");
  const qy = query(bidsRef, where("playerId","==",currentPlayerId), limit(200));
  const currentRoundId = roomData?.roundId ?? 0;

  bidsUnsub = onSnapshot(qy, (snap)=>{
    const bids = [];
    snap.forEach(d=>{
      const data = d.data();
      if((data.roundId ?? 0) !== currentRoundId) return;
      bids.push({ id:d.id, ...data, amount:Number(data.amount||0) });
    });

    bids.sort((a,b)=>{
      if(a.amount !== b.amount) return a.amount - b.amount;
      return (a.createdAtMs||0) - (b.createdAtMs||0);
    });

    if(bids.length){
      const top = bids[bids.length-1];
      highestAmountSpan.textContent = top.amount;
      highestLeaderSpan.textContent =
        LEADERS[top.leaderId]?.name || top.leaderName || top.leaderId;
    }else{
      highestAmountSpan.textContent = "-";
      highestLeaderSpan.textContent = "-";
    }

    const bidsByTime = bids.slice().sort((a,b)=>{
      const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAtMs||0);
      const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAtMs||0);
      return bt - at;
    });

    bidLog.innerHTML = bidsByTime.map(b=>{
      const leaderName = LEADERS[b.leaderId]?.name || b.leaderName || b.leaderId;
      const ts = b.createdAt?.toDate ? b.createdAt.toDate()
               : (b.createdAtMs ? new Date(b.createdAtMs) : null);
      const timeStr = ts ? ts.toLocaleTimeString("ko-KR",{hour12:false}) : "";
      return `<div class="item">${timeStr} ${leaderName}: <b>${b.amount}</b>점</div>`;
    }).join("");
  });
}

/* ===================== UI RENDER ===================== */
function updateStatusUI(){
  const st = roomData?.status || "waiting";
  statusDot.className = "dot " + (st==="bidding"?"bidding": st==="finished"?"finished":"");
  statusText.textContent =
    st==="bidding" ? "경매중" :
    st==="finished" ? "종료" : "대기중";

  const phase = roomData?.phase || "A";
  const test  = roomData?.isTest ? "TEST" : "REAL";
  if(modeBadge) modeBadge.textContent = `${ROOM_ID.toUpperCase()} · ${test} · ${phase}`;

  bidButton.disabled = !(st==="bidding" && selectedRole.startsWith("leader"));
}

function updateCurrentPlayerUI(){
  const p = currentPlayerId ? playersMap.get(currentPlayerId) : null;
  if(!p){
    currentPhoto.src = "";
    currentName.textContent = "-";
    currentRoleEl.textContent = "-";
    currentGroupEl.textContent = "-";
    currentBaseEl.textContent = "-";
    currentBioEl.textContent = "-";
    currentStatusBadge.textContent = "대기";
    if(timerPlayerNameEl) timerPlayerNameEl.textContent = "-";
    return;
  }

  currentPhoto.src = p.photoUrl || "./assets/players/default.png";
  currentName.textContent = p.name || p.id;
  currentRoleEl.textContent = normalizeRole(p.role);
  currentGroupEl.textContent = normalizeGroupAB(p.group);
  currentBaseEl.textContent = p.basePrice ?? 0;
  currentBioEl.textContent = p.bio || "";
  currentStatusBadge.textContent =
    roomData?.status==="bidding" ? "입찰중" :
    p.status==="sold" ? "SOLD" : "대기";

  if(timerPlayerNameEl) timerPlayerNameEl.textContent = p.name || p.id || "-";
  renderGroupRosters();
}

/* ✅ rosterList 우선 표시(역할 무관) */
function renderTeams(){
  const byId=(id)=>playersMap.get(id);

  Object.keys(teamCards).forEach(leaderId=>{
    const el = teamCards[leaderId];
    if(!el) return;

    el.style.setProperty("--team-color", TEAM_COLORS[leaderId] || "#7aa2ff");

    const info = LEADERS[leaderId];
    const team = teamsMap.get(leaderId);

    const start  = team?.pointsStart ?? info.startPoints;
    const used   = team?.pointsUsed ?? 0;
    const remain = start - used;

    let orderIds = [];
    if(Array.isArray(team?.rosterList) && team.rosterList.length){
      orderIds = team.rosterList.map(x=>x.playerId);
    }else{
      const assigned = allPlayers.filter(p=>p.assignedTeamId===leaderId);
      assigned.sort((a,b)=>stableOrderIndex(a)-stableOrderIndex(b));
      orderIds = assigned.map(p=>p.id);
    }

    const slotsHtml = ROLES.map((slotRole, idx)=>{
      const pid = orderIds[idx] || null;
      const p = pid ? byId(pid) : null;
      const has = !!p;

      const nameText  = has ? (p.name || pid) : "";
      const priceText = has && p.finalPrice ? `${p.finalPrice}점` : "";
      const imgHtml   = has ? `<img src="${p.photoUrl || "./assets/players/default.png"}" />` : "";

      return `
        <div class="slot ${has ? "" : "empty"}">
          ${imgHtml}
          <div class="slot-text">
            ${has
              ? `<div class="slot-name">${nameText}</div>${priceText ? `<div class="slot-price">${priceText}</div>` : ""}`
              : `<div class="slot-name" style="opacity:.35;">EMPTY</div>`
            }
          </div>
          <div class="slot-label">${slotRole}</div>
        </div>
      `;
    }).join("");

    el.innerHTML = `
      <div class="team-header">
        <div class="team-name">${team?.name || info.teamName}</div>
        <div class="team-points">${remain} / ${start}</div>
      </div>
      <div class="team-row">${slotsHtml}</div>
    `;
  });
}

function renderGroupRosters(){
  const rosterA = document.getElementById("roster-A");
  const rosterB = document.getElementById("roster-B");
  if(!rosterA || !rosterB) return;
  rosterA.innerHTML = "";
  rosterB.innerHTML = "";

  const list = allPlayers || Array.from(playersMap.values());

  list.forEach(p=>{
    const g = normalizeGroupAB(p.group);
    if(!GROUPS.includes(g)) return;

    const wrap = document.createElement("div");
    wrap.className = "avatar";
    if(currentPlayerId && p.id === currentPlayerId) wrap.classList.add("current");
    if(p.status === "sold" && p.assignedTeamId){
      wrap.classList.add("sold");
      wrap.classList.add(`sold-by-${p.assignedTeamId}`);
    }

    wrap.innerHTML = `
      <img src="${p.photoUrl || "./assets/players/default.png"}" alt="${p.name}">
      <div class="name-tip">${p.name || p.id}</div>
    `;
    if(g==="A") rosterA.appendChild(wrap);
    if(g==="B") rosterB.appendChild(wrap);
  });
}

/* ===================== FINALIZE CLAIM ===================== */
async function claimFinalizeIfExpired(){
  const roomRef = doc(db, "rooms", ROOM_ID);
  let claimed = false;

  await runTransaction(db, async (tx)=>{
    const snap = await tx.get(roomRef);
    if(!snap.exists()) return;
    const r = snap.data();

    if(r.status !== "bidding") return;
    if(!r.endsAtMs || r.endsAtMs > Date.now()) return;
    if(r.finalizing) return;

    tx.update(roomRef, { finalizing: true });
    claimed = true;
  });

  return claimed;
}

/* ===================== COUNTDOWN (0초 자동 유찰/다음) ===================== */
function startCountdown(endsAtMs){
  if(timerInterval) clearInterval(timerInterval);
  if(!endsAtMs){
    timerEl.textContent = "-";
    return;
  }

  const tick = async ()=>{
    const leftMs = endsAtMs - Date.now();
    const left = Math.max(0, Math.ceil(leftMs/1000));
    timerEl.textContent = left;

    if(left <= 0){
      clearInterval(timerInterval);
      timerInterval = null;

      if(finalizeInProgress) return;
      finalizeInProgress = true;

      try{
        const claimed = await claimFinalizeIfExpired();
        if(claimed){
          await finalizeCurrentAndNext();
        }
      }catch(e){
        console.error("finalize on 0s error:", e);
      }finally{
        finalizeInProgress = false;
      }
    }
  };

  tick();
  timerInterval = setInterval(tick, 250);
}

/* ===================== AUCTION FLOW ===================== */
function getPhaseCandidates(phase){
  if(phase==="A"){
    return allPlayers.filter(p=> normalizeGroupAB(p.group)==="A" && p.status!=="sold" && p.status!=="unsold");
  }
  if(phase==="B"){
    return allPlayers.filter(p=> normalizeGroupAB(p.group)==="B" && p.status!=="sold" && p.status!=="unsold");
  }
  return allPlayers.filter(p=> p.status!=="sold");
}

async function pickNextPlayerId(phase){
  const cands = sortCandidates(getPhaseCandidates(phase));
  return cands[0]?.id || null;
}

async function startPhase(phase, isTest=false){
  const roomRef = doc(db,"rooms",ROOM_ID);
  const rSnap = await getDoc(roomRef);
  const r = rSnap.exists() ? rSnap.data() : {};
  const nextId = await pickNextPlayerId(phase);

  if(!nextId){
    if(phase==="A") return startPhase("B", isTest);
    if(phase==="B") return startPhase("REMAIN", isTest);
    return finishAuction();
  }

  await updateDoc(roomRef,{
    status:"bidding",
    phase,
    isTest,
    currentPlayerId: nextId,
    endsAtMs: Date.now() + AUCTION_SECONDS*1000,
    roundId: (r.roundId ?? 0) + 1,
    finalizing:false,
    updatedAt: serverTimestamp()
  });
}

/* === index 없이 최고 입찰 찾기 === */
async function getTopBidNoIndex(playerId){
  const roomRef = doc(db,"rooms",ROOM_ID);
  const rSnap = await getDoc(roomRef);
  const currentRoundId = rSnap.exists() ? (rSnap.data().roundId ?? 0) : (roomData?.roundId ?? 0);

  const bidsRef = collection(db,"rooms",ROOM_ID,"bids");
  const qy = query(bidsRef, where("playerId","==",playerId), limit(200));
  const snap = await getDocs(qy);

  let top = null;
  snap.forEach(d=>{
    const b = d.data();
    if((b.roundId ?? 0) !== currentRoundId) return;

    const amt = Number(b.amount||0);
    const tms = b.createdAtMs || 0;
    if(!top || amt > top.amount || (amt === top.amount && tms > (top.createdAtMs||0))){
      top = { id:d.id, ...b, amount:amt, createdAtMs:tms };
    }
  });
  return top;
}

/* ✅ role 무시: 낙찰되면 무조건 팀으로 */
async function finalizeCurrentAndNext(){
  const phase = roomData?.phase || "A";
  const playerId = roomData?.currentPlayerId;
  if(!playerId) return;

  const roomRef   = doc(db,"rooms",ROOM_ID);
  const playerRef = doc(db,"rooms",ROOM_ID,"players",playerId);

  const topBid = await getTopBidNoIndex(playerId);

  await runTransaction(db, async (tx)=>{
    const pSnap = await tx.get(playerRef);
    const rSnap = await tx.get(roomRef);
    if(!pSnap.exists() || !rSnap.exists()) return;

    const p = {id:pSnap.id, ...pSnap.data()};

    if(topBid){
      const leaderId = topBid.leaderId;
      const amount   = Number(topBid.amount||0);

      const teamRef = doc(db,"rooms",ROOM_ID,"teams",leaderId);
      const tSnap = await tx.get(teamRef);
      const t = tSnap.exists()
        ? tSnap.data()
        : {pointsStart:1000,pointsUsed:0,roster:{},rosterList:[]};

      const roster = {...(t.roster||{})};
      const rosterList = Array.isArray(t.rosterList) ? [...t.rosterList] : [];

      if(!rosterList.some(x=>x.playerId===playerId)){
        rosterList.push({
          playerId,
          amount,
          role: p.role || null,
          group: p.group || null
        });
      }

      const firstEmpty = ROLES.find(r=>!roster[r]);
      if(firstEmpty) roster[firstEmpty] = playerId;

      tx.update(playerRef,{
        status:"sold",
        assignedTeamId: leaderId,
        finalPrice: amount,
        updatedAt: serverTimestamp()
      });

      tx.set(teamRef,{
        ...t,
        name: t.name || LEADERS[leaderId]?.teamName,
        pointsStart: t.pointsStart ?? LEADERS[leaderId]?.startPoints ?? 1000,
        pointsUsed: (t.pointsUsed||0) + amount,
        roster,
        rosterList
      },{merge:true});

    }else{
      tx.update(playerRef,{ status:"unsold", updatedAt:serverTimestamp() });
    }

    tx.update(roomRef,{
      currentPlayerId:null,
      endsAtMs:null,
      finalizing:false,
      updatedAt: serverTimestamp()
    });
  });

  if(topBid){
    const leaderId = topBid.leaderId;
    const leaderName = LEADERS[leaderId]?.name || topBid.leaderName || leaderId;
    const p = playersMap.get(playerId);
    showSoldOverlay(leaderId, leaderName, p, topBid.amount);
    await sleep(600);
  }

  const nextId = await pickNextPlayerId(phase);
  if(nextId){
    await updateDoc(roomRef,{
      currentPlayerId: nextId,
      endsAtMs: Date.now() + AUCTION_SECONDS*1000,
      finalizing:false,
      updatedAt: serverTimestamp()
    });
    return;
  }

  if(phase==="A") return startPhase("B", roomData?.isTest);
  if(phase==="B") return startPhase("REMAIN", roomData?.isTest);
  return finishAuction();
}

async function finishAuction(){
  await updateDoc(doc(db,"rooms",ROOM_ID),{
    status:"finished",
    phase:"REMAIN",
    currentPlayerId:null,
    endsAtMs:null,
    finalizing:false,
    updatedAt: serverTimestamp()
  });
}

/* ✅ 낙찰 팝업 자동 종료 포함 버전 */
let overlayHideTimer = null;
function showSoldOverlay(leaderId, teamName, p, amount){
  overlayTeam.textContent = `SOLD · ${teamName}`;
  overlayTeam.style.color = TEAM_COLORS[leaderId] || "#fff";
  overlayPhoto.src = p?.photoUrl || "./assets/players/default.png";
  overlayName.textContent = p?.name || p?.id || "-";
  overlayPrice.textContent = `${amount}점`;

  overlay.classList.remove("show");
  void overlay.offsetWidth;
  overlay.classList.add("show");

  if(overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(()=>{
    overlay.classList.remove("show");
  }, 1200);
}

/* ===================== RESET (incl. bids) ===================== */
async function deleteAllBids(){
  const bidsCol = collection(db, "rooms", ROOM_ID, "bids");
  const snap = await getDocs(bidsCol);
  const docs = snap.docs;

  for(let i=0; i<docs.length; i+=450){
    const batch = writeBatch(db);
    docs.slice(i, i+450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

async function resetAll(){
  const ok = confirm(
    "【포인트/전체 리셋】\n\n" +
    "• 모든 입찰 로그가 삭제됩니다.\n" +
    "• 모든 낙찰/미낙찰 결과가 초기화됩니다.\n" +
    "• 팀 포인트/로스터가 초기화됩니다.\n\n" +
    "계속할까요?"
  );
  if(!ok) return;

  const roomRef    = doc(db,"rooms",ROOM_ID);
  const playersCol = collection(db,"rooms",ROOM_ID,"players");
  const teamsCol   = collection(db,"rooms",ROOM_ID,"teams");

  await deleteAllBids();

  const pSnap = await getDocs(playersCol);
  for (const d of pSnap.docs){
    await updateDoc(d.ref,{
      status:"available",
      assignedTeamId:null,
      finalPrice:null
    });
  }

  const tSnap = await getDocs(teamsCol);
  for (const d of tSnap.docs){
    await setDoc(d.ref,{
      name: LEADERS[d.id]?.teamName || d.id,
      pointsStart: LEADERS[d.id]?.startPoints || 1000,
      pointsUsed:0,
      roster:{},
      rosterList:[]
    },{merge:true});
  }

  await setDoc(roomRef,{
    status:"waiting",
    phase:"A",
    isTest:false,
    currentPlayerId:null,
    endsAtMs:null,
    roundId:0,
    finalizing:false,
    updatedAt: serverTimestamp()
  },{merge:true});

  alert("✅ 전체 리셋 완료!");
}

async function silentResetAll(){
  const roomRef    = doc(db,"rooms",ROOM_ID);
  const playersCol = collection(db,"rooms",ROOM_ID,"players");
  const teamsCol   = collection(db,"rooms",ROOM_ID,"teams");

  await deleteAllBids();

  const pSnap = await getDocs(playersCol);
  for (const d of pSnap.docs){
    await updateDoc(d.ref,{
      status:"available",
      assignedTeamId:null,
      finalPrice:null
    });
  }

  const tSnap = await getDocs(teamsCol);
  for (const d of tSnap.docs){
    await setDoc(d.ref,{
      name: LEADERS[d.id]?.teamName || d.id,
      pointsStart: LEADERS[d.id]?.startPoints || 1000,
      pointsUsed:0,
      roster:{},
      rosterList:[]
    },{merge:true});
  }

  await setDoc(roomRef,{
    status:"waiting",
    phase:"A",
    isTest:false,
    currentPlayerId:null,
    endsAtMs:null,
    roundId:0,
    finalizing:false,
    updatedAt: serverTimestamp()
  },{merge:true});
}

/* ===================== BIDDING (transactional) ===================== */
async function placeBidTransactional(amount){
  const roomRef = doc(db,"rooms",ROOM_ID);
  const bidsCol = collection(db,"rooms",ROOM_ID,"bids");
  const bidRef  = doc(bidsCol);

  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    if(!roomSnap.exists()) throw new Error("room not found");
    const room = roomSnap.data();

    if(room.status !== "bidding") throw new Error("not bidding");
    const playerId = room.currentPlayerId;
    if(!playerId) throw new Error("no current player");

    const roundId = room.roundId ?? 0;

    tx.set(bidRef,{
      roundId,
      playerId,
      leaderId: selectedRole,
      leaderName: LEADERS[selectedRole]?.name || selectedRole,
      amount,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now()
    });
  });
}

bidButton.addEventListener("click", async ()=>{
  if(!roomData || roomData.status!=="bidding" || !currentPlayerId) return;
  if(!selectedRole.startsWith("leader")) return;

  const amount = Number(bidInput.value);
  if(Number.isNaN(amount) || amount < 0){
    alert("입찰 금액을 입력해 주세요.");
    return;
  }
  if(amount % 5 !== 0){
    alert("입찰은 5점 단위로만 가능합니다.");
    return;
  }

  const leaderInfo = LEADERS[selectedRole];
  const team = teamsMap.get(selectedRole);
  const start = team?.pointsStart ?? leaderInfo.startPoints;
  const used  = team?.pointsUsed ?? 0;
  const remain = start - used;
  if(amount > remain){
    alert("포인트가 부족합니다.");
    return;
  }

  const p = playersMap.get(currentPlayerId);
  if(!p){
    alert("현재 선수 정보가 없습니다.");
    return;
  }

  const group = normalizeGroupAB(p.group);
  const groupMin = (group==="A") ? 400 : 100;

  const baseRaw = Number(p.basePrice ?? 0);
  const minBase = roundUp5(baseRaw);
  const minBid  = Math.max(groupMin, minBase);

  if(amount < minBid){
    alert(`${group}그룹 선수는 최소 ${groupMin}점 이상 + 기본가(${baseRaw}) 이상 입찰해야 합니다.\n→ 최소 입찰 가능: ${minBid}점`);
    return;
  }

  const currentMax = Number(highestAmountSpan.textContent) || 0;
  if(currentMax && amount < currentMax + 5){
    alert(`최고가(${currentMax})보다 최소 5점 높게 입찰해야 합니다.`);
    return;
  }

  try{
    await placeBidTransactional(amount);
    bidInput.value = "";
  }catch(e){
    console.error(e);
    alert("입찰 오류: " + (e.message || e.code));
  }
});

/* ===================== ROLE SELECT ===================== */
roleSelect.addEventListener("change", ()=>{
  selectedRole = roleSelect.value;
  if(adminControls) adminControls.style.display = (selectedRole==="operator") ? "flex" : "none";
  updateStatusUI();
});

/* ===================== ADMIN BUTTONS ===================== */
btnStartTest?.addEventListener("click", ()=> startPhase("A", true));

btnStartReal?.addEventListener("click", async ()=>{
  const ok = confirm(
    "【본 경매 시작】\n\n" +
    "지금부터 본 경매를 시작합니다.\n" +
    "• 기존 테스트/입찰 로그/낙찰 결과/포인트가 전부 초기화됩니다.\n" +
    "• A그룹부터 순서대로 진행됩니다.\n\n" +
    "계속할까요?"
  );
  if(!ok) return;

  await silentResetAll();
  await startPhase("A", false);
  alert("✅ 본 경매가 시작되었습니다!");
});

btnStartRemaining?.addEventListener("click", ()=> startPhase("REMAIN", roomData?.isTest));
btnReset?.addEventListener("click", resetAll);

/* ===================== INIT ===================== */
(async function init(){
  for(const leaderId of Object.keys(LEADERS)){
    const tRef = doc(db,"rooms",ROOM_ID,"teams",leaderId);
    const tSnap = await getDoc(tRef);
    if(!tSnap.exists()){
      await setDoc(tRef,{
        name: LEADERS[leaderId].teamName,
        pointsStart: LEADERS[leaderId].startPoints,
        pointsUsed:0,
        roster:{},
        rosterList:[]
      });
    }
  }

  const rRef = doc(db,"rooms",ROOM_ID);
  const rSnap = await getDoc(rRef);
  if(!rSnap.exists()){
    await setDoc(rRef,{
      status:"waiting",
      phase:"A",
      isTest:false,
      currentPlayerId:null,
      endsAtMs:null,
      roundId:0,
      finalizing:false,
      createdAt: serverTimestamp()
    });
  }

  listenRoom();
  listenPlayers();
  listenTeams();
})();
