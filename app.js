/* ===================== Firebase SDK (module) ===================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
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
const ROOM_ID = "room1";          // ✅ 최종 방 고정
const AUCTION_SECONDS = 20;
const ROLES = ["TOP","JGL","MID","BOT","SUP"];
const GROUPS = ["A","B"];         // ✅ A/B만

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

/* ===================== BID LOG (NO COMPOSITE INDEX + ROUND FILTER) ===================== */
function listenBidsForCurrent(){
  if(bidsUnsub) bidsUnsub();
  bidLog.innerHTML = "";
  highestAmountSpan.textContent = "-";
  highestLeaderSpan.textContent = "-";
  if(!currentPlayerId) return;

  const bidsRef = collection(db,"rooms",ROOM_ID,"bids");
  const qy = query(bidsRef, where("playerId","==",currentPlayerId), limit(200));
  const currentRoundId = roomData?.roundId ?? 0;  // ✅ 현재 라운드

  bidsUnsub = onSnapshot(qy, (snap)=>{
    const bids = [];
    snap.forEach(d=>{
      const data = d.data();
      // ✅ 현재 roundId 입찰만 사용 (이전 경기 최고가 섞임 방지)
      if((data.roundId ?? 0) !== currentRoundId) return;
      bids.push({ id:d.id, ...data, amount:Number(data.amount||0) });
    });

    // 최고가 계산
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

    // 로그 표시(시간 최신순)
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

  }, (err)=>{
    console.error("bids snapshot error:", err);
    bidLog.innerHTML =
      `<div style="color:#ff8a8a">입찰 로그 로딩 오류: ${err.message || err.code}</div>`;
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
  modeBadge.textContent = `${ROOM_ID.toUpperCase()} · ${test} · ${phase}`;

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

    const rawRoster = team?.roster || {};
    const derivedRoster = {};
    allPlayers
      .filter(p => p.assignedTeamId === leaderId)
      .forEach(p=>{
        derivedRoster[normalizeRole(p.role)] = p.id;
      });

    const roster = { ...derivedRoster, ...rawRoster };

    const slotsHtml = ROLES.map(role=>{
      const pid = roster[role] || null;
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
          <div class="slot-label">${role}</div>
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

/* ===================== COUNTDOWN ===================== */
function startCountdown(endsAtMs){
  if(timerInterval) clearInterval(timerInterval);
  if(!endsAtMs){
    timerEl.textContent = "-";
    return;
  }
  const tick = ()=>{
    const leftMs = endsAtMs - Date.now();
    const left = Math.max(0, Math.ceil(leftMs/1000));
    timerEl.textContent = left;

    if(left<=0){
      clearInterval(timerInterval);
      timerInterval=null;
      if(selectedRole==="operator"){
        finalizeCurrentAndNext().catch(console.error);
      }
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

/* ===================== AUCTION FLOW (A -> B -> REMAIN -> finish) ===================== */
function getPhaseCandidates(phase){
  if(phase==="A"){
    return allPlayers.filter(p=> normalizeGroupAB(p.group)==="A" && p.status!=="sold" && p.status!=="unsold");
  }
  if(phase==="B"){
    return allPlayers.filter(p=> normalizeGroupAB(p.group)==="B" && p.status!=="sold" && p.status!=="unsold");
  }
  return allPlayers.filter(p=> p.status!=="sold");
}

function sortCandidates(list){
  return list.slice().sort((a,b)=>{
    const ai = a.orderIndex ?? a.createdAt?.seconds ?? 0;
    const bi = b.orderIndex ?? b.createdAt?.seconds ?? 0;
    if(ai!==bi) return ai-bi;
    return String(a.name||"").localeCompare(String(b.name||""));
  });
}

async function pickNextPlayerId(phase){
  const cands = sortCandidates(getPhaseCandidates(phase));
  return cands[0]?.id || null;
}

async function startPhase(phase, isTest=false){
  const roomRef = doc(db,"rooms",ROOM_ID);
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
    roundId: (roomData?.roundId ?? 0) + 1,
    updatedAt: serverTimestamp()
  });
}

/* 최고가를 인덱스 없이 + 현재 라운드만 */
async function getTopBidNoIndex(playerId){
  const bidsRef = collection(db,"rooms",ROOM_ID,"bids");
  const qy = query(bidsRef, where("playerId","==",playerId), limit(200));
  const snap = await getDocs(qy);

  const currentRoundId = roomData?.roundId ?? 0; // ✅ 현재 라운드

  let top = null;
  snap.forEach(d=>{
    const b = d.data();
    if((b.roundId ?? 0) !== currentRoundId) return; // ✅ 라운드 필터

    const amt = Number(b.amount||0);
    const tms = b.createdAtMs || 0;
    if(!top || amt > top.amount || (amt === top.amount && tms > (top.createdAtMs||0))){
      top = { id:d.id, ...b, amount:amt, createdAtMs:tms };
    }
  });
  return top;
}

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
    const role = normalizeRole(p.role);

    if(topBid){
      const leaderId = topBid.leaderId;
      const amount   = Number(topBid.amount||0);

      const teamRef = doc(db,"rooms",ROOM_ID,"teams",leaderId);
      const tSnap = await tx.get(teamRef);
      const t = tSnap.exists()
        ? tSnap.data()
        : {pointsStart:1000,pointsUsed:0,roster:{}};

      const roster = {...(t.roster||{})};

      if(roster[role]){
        tx.update(playerRef,{
          status:"unsold",
          assignedTeamId:null,
          finalPrice:null,
          updatedAt:serverTimestamp()
        });
      }else{
        roster[role] = playerId;

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
          roster
        },{merge:true});
      }
    }else{
      tx.update(playerRef,{ status:"unsold", updatedAt:serverTimestamp() });
    }

    tx.update(roomRef,{
      currentPlayerId:null,
      endsAtMs:null,
      updatedAt: serverTimestamp()
    });
  });

  if(topBid){
    const leaderName = LEADERS[topBid.leaderId]?.name || topBid.leaderName || topBid.leaderId;
    const p = playersMap.get(playerId);
    showSoldOverlay(leaderName, p, topBid.amount);
    await sleep(600);
  }

  const nextId = await pickNextPlayerId(phase);
  if(nextId){
    await updateDoc(roomRef,{
      currentPlayerId: nextId,
      endsAtMs: Date.now() + AUCTION_SECONDS*1000,
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
    updatedAt: serverTimestamp()
  });
}

function showSoldOverlay(teamName, p, amount){
  overlayTeam.textContent = `SOLD · ${teamName}`;
  overlayTeam.style.color = TEAM_COLORS[p?.assignedTeamId] || "#fff";
  overlayPhoto.src = p?.photoUrl || "./assets/players/default.png";
  overlayName.textContent = p?.name || p?.id || "-";
  overlayPrice.textContent = `${amount}점`;
  overlay.classList.remove("show");
  void overlay.offsetWidth;
  overlay.classList.add("show");
}

/* ===================== FULL RESET (incl. bids) ===================== */
// ✅ bids 전체 삭제
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

// ✅ 운영자 리셋(확인창 있음)
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

  try{
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
        roster:{}
      },{merge:true});
    }

    await setDoc(roomRef,{
      status:"waiting",
      phase:"A",
      isTest:false,
      currentPlayerId:null,
      endsAtMs:null,
      roundId:0,
      updatedAt: serverTimestamp()
    },{merge:true});

    alert("✅ 전체 리셋 완료!");
  }catch(e){
    console.error(e);
    alert("리셋 오류: " + (e.message || e.code));
  }
}

// ✅ 본경매 시작용 “조용한” 완전 리셋(확인창 없음)
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
      roster:{}
    },{merge:true});
  }

  await setDoc(roomRef,{
    status:"waiting",
    phase:"A",
    isTest:false,
    currentPlayerId:null,
    endsAtMs:null,
    roundId:0,
    updatedAt: serverTimestamp()
  },{merge:true});
}

/* ===================== BIDDING (A>=400, B>=100 + basePrice, 5단위, 최고가+5) ===================== */
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

  const role = normalizeRole(p.role);
  const roster = team?.roster || {};
  if(roster[role]){
    alert(`이미 ${role} 자리가 찼습니다.`);
    return;
  }

  const group = normalizeGroupAB(p.group);
  const groupMin = (group==="A") ? 400 : 100;

  const baseRaw = Number(p.basePrice ?? 0);
  const minBase = roundUp5(baseRaw);
  const minBid = Math.max(groupMin, minBase);

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
    await addDoc(collection(db,"rooms",ROOM_ID,"bids"),{
      roundId: roomData.roundId ?? 0,
      playerId: currentPlayerId,
      leaderId: selectedRole,
      leaderName: leaderInfo.name,
      amount,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now()
    });
    bidInput.value = "";
  }catch(e){
    console.error(e);
    alert("입찰 오류: " + (e.message || e.code));
  }
});

/* ===================== ROLE SELECT ===================== */
roleSelect.addEventListener("change", ()=>{
  selectedRole = roleSelect.value;
  adminControls.style.display = (selectedRole==="operator") ? "flex" : "none";
  updateStatusUI();
});

/* ===================== ADMIN BUTTONS ===================== */
// 테스트 시작(A부터)
btnStartTest?.addEventListener("click", ()=> startPhase("A", true));

// ✅ 본경매 시작: “본 경매 시작” 전용 안내창 → OK면 silentResetAll 후 시작
btnStartReal?.addEventListener("click", async ()=>{
  const ok = confirm(
    "【본 경매 시작】\n\n" +
    "지금부터 본 경매를 시작합니다.\n" +
    "• 기존 테스트/입찰 로그/낙찰 결과/포인트가 전부 초기화됩니다.\n" +
    "• A그룹부터 순서대로 진행됩니다.\n\n" +
    "계속할까요?"
  );
  if(!ok) return;

  try{
    await silentResetAll();
    await startPhase("A", false);
    alert("✅ 본 경매가 시작되었습니다!");
  }catch(e){
    console.error(e);
    alert("본경매 시작 오류: " + (e.message || e.code));
  }
});

// 잔여 재경매 시작
btnStartRemaining?.addEventListener("click", ()=> startPhase("REMAIN", roomData?.isTest));

// 운영자 리셋(확인창 포함)
btnReset?.addEventListener("click", resetAll);

/* ===================== INIT ===================== */
(async function init(){
  // teams 기본 생성
  for(const leaderId of Object.keys(LEADERS)){
    const tRef = doc(db,"rooms",ROOM_ID,"teams",leaderId);
    const tSnap = await getDoc(tRef);
    if(!tSnap.exists()){
      await setDoc(tRef,{
        name: LEADERS[leaderId].teamName,
        pointsStart: LEADERS[leaderId].startPoints,
        pointsUsed:0,
        roster:{}
      });
    }
  }

  // room 기본 생성
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
      createdAt: serverTimestamp()
    });
  }

  listenRoom();
  listenPlayers();
  listenTeams();
})();
