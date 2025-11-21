// app.js (FINAL ONE-PASTE VERSION)
// NO-index finalize + transaction order OK
// ✅ team colors + sold roster border + win overlay animation

import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, onSnapshot,
  collection, addDoc, query, orderBy,
  serverTimestamp, runTransaction,
  updateDoc, setDoc, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

/* ===================== 설정 ===================== */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const ROOM_ID = "room1";
const ROUND_SECONDS = 30;
const GROUP_ORDER = ["A","B","C"];

/* 팀장 정보 */
const LEADERS = {
  leader1: { id:"leader1", name:"팀장1", startPoints:1000, teamName:"팀장1 팀" },
  leader2: { id:"leader2", name:"팀장2", startPoints:1000, teamName:"팀장2 팀" },
  leader3: { id:"leader3", name:"팀장3", startPoints:1000, teamName:"팀장3 팀" },
  leader4: { id:"leader4", name:"팀장4", startPoints:1000, teamName:"팀장4 팀" }
};
const TEAM_COLORS = {
  leader1: "#7aa2ff",
  leader2: "#ff7ad6",
  leader3: "#62e7a7",
  leader4: "#ffcc66"
};

const ROLES = ["TOP","JGL","MID","BOT","SUP"];

/* ===================== 역할 표준화 ===================== */
function normalizeRole(r){
  const s = String(r || "").trim().toUpperCase();
  if (["TOP","T","탑","탑솔","탑라이너"].includes(s)) return "TOP";
  if (["JGL","JG","JUNGLE","정글","정글러"].includes(s)) return "JGL";
  if (["MID","M","미드","미드라이너"].includes(s)) return "MID";
  if (["BOT","B","ADC","AD","원딜","바텀","봇"].includes(s)) return "BOT";
  if (["SUP","S","SUPPORT","서폿","서포터","서포트"].includes(s)) return "SUP";
  return s || "TOP";
}

/* ===================== roundEndsAt 변환 ===================== */
function toMillis(v){
  if(!v) return null;
  if(typeof v === "number") return v;
  if(v instanceof Date) return v.getTime();
  if(typeof v.toMillis === "function") return v.toMillis();
  if(v.seconds != null) return v.seconds*1000 + Math.floor((v.nanoseconds||0)/1e6);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ===================== DOM ===================== */
const roleSelect = document.getElementById("role-select");
const bidInput = document.getElementById("bid-amount");
const bidButton = document.getElementById("bid-button");
const bidLogDiv = document.getElementById("bid-log");
const highestAmountSpan = document.getElementById("highest-amount");
const highestLeaderSpan = document.getElementById("highest-leader");
const timerSpan = document.getElementById("timer");
const modeBadge = document.getElementById("mode-badge");

const roomStatusDot = document.getElementById("room-status-dot");
const roomStatusText = document.getElementById("room-status-text");

const currentPhoto = document.getElementById("current-player-photo");
const currentName = document.getElementById("current-player-name");
const currentRoleSpan = document.getElementById("current-player-role");
const currentGroupSpan = document.getElementById("current-player-group");
const currentBase = document.getElementById("current-player-base");
const currentStatus = document.getElementById("current-player-status");
const currentBio = document.getElementById("current-player-bio");

const adminControls = document.getElementById("admin-controls");
const btnStartTest = document.getElementById("btn-start-test");
const btnStartReal = document.getElementById("btn-start-real");
const btnStartRemaining = document.getElementById("btn-start-remaining");
const btnReset = document.getElementById("btn-reset");

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

/* ✅ 낙찰 오버레이 DOM */
const overlayEl = document.getElementById("auction-overlay");
const overlayTeamEl = document.getElementById("auction-overlay-team");
const overlayPhotoEl = document.getElementById("auction-overlay-photo");
const overlayNameEl = document.getElementById("auction-overlay-name");
const overlayPriceEl = document.getElementById("auction-overlay-price");

/* ===================== 상태 ===================== */
let selectedRole = "viewer";
let roomData = null;
let currentPlayerId = null;
let prevCurrentPlayerId = null;

let playersMap = new Map();
let allPlayers = [];
let teamsMap = new Map();
let allBids = [];

let finalizeInFlight = false;
let overlayTimer = null;

/* ===================== 역할 선택 ===================== */
roleSelect.addEventListener("change", () => {
  selectedRole = roleSelect.value;
  adminControls.style.display = (selectedRole === "operator") ? "flex" : "none";
  updateBidButtonState();
});

/* ===================== 운영자 버튼 ===================== */
btnStartTest?.addEventListener("click", ()=> adminStartMainAuction(true));
btnStartReal?.addEventListener("click", ()=> adminStartMainAuction(false));
btnStartRemaining?.addEventListener("click", adminStartRemainingAuction);
btnReset?.addEventListener("click", adminResetAll);

/* ---- 1차 경매 시작 ---- */
async function adminStartMainAuction(testMode){
  const roomRef = doc(db,"rooms",ROOM_ID);
  const roomSnap = await getDoc(roomRef);
  if(!roomSnap.exists()){ alert("rooms/room1 없음"); return; }

  const room = roomSnap.data();
  const group = (room.currentGroup || "A").toUpperCase();
  const firstPlayer = await findFirstAvailablePlayerInGroup(group);

  await updateDoc(roomRef,{
    status:"bidding",
    testMode: !!testMode,
    remainingAuction:false,
    remainingQueue:[],
    remainingIndex:0,
    currentGroup: group,
    currentPlayerId: firstPlayer?.id || null,
    roundId: (room.roundId ?? 0) + 1,
    roundEndsAt: Date.now()+ROUND_SECONDS*1000,
  });

  alert(testMode ? "테스트 시작" : "본경매 시작");
}

/* ---- 잔여 재경매 ---- */
async function adminStartRemainingAuction(){
  const roomRef = doc(db,"rooms",ROOM_ID);
  const roomSnap = await getDoc(roomRef);
  if(!roomSnap.exists()){ alert("rooms/room1 없음"); return; }

  const playersSnap = await getDocs(collection(db,"rooms",ROOM_ID,"players"));
  const remain = playersSnap.docs.map(d=>({id:d.id,...d.data()}))
    .filter(p=>p.status!=="sold")
    .sort((a,b)=>{
      const ga=(a.group||"A").toUpperCase();
      const gb=(b.group||"A").toUpperCase();
      if(ga!==gb) return GROUP_ORDER.indexOf(ga)-GROUP_ORDER.indexOf(gb);
      const oa=a.order??9999, ob=b.order??9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    });

  if(!remain.length){ alert("잔여 선수 없음"); return; }

  const room = roomSnap.data();
  await updateDoc(roomRef,{
    status:"bidding",
    testMode:false,
    remainingAuction:true,
    remainingQueue: remain.map(p=>p.id),
    remainingIndex:0,
    currentGroup:"REMAIN",
    currentPlayerId:remain[0].id,
    roundId:(room.roundId??0)+1,
    roundEndsAt:Date.now()+ROUND_SECONDS*1000,
  });

  alert("잔여 재경매 시작!");
}

/* ---- 전체 리셋 ---- */
async function adminResetAll(){
  if(!confirm("전체 리셋?")) return;

  const roomRef = doc(db,"rooms",ROOM_ID);

  const bidsSnap = await getDocs(collection(db,"rooms",ROOM_ID,"bids"));
  await Promise.all(bidsSnap.docs.map(d=>deleteDoc(d.ref)));

  const playersSnap = await getDocs(collection(db,"rooms",ROOM_ID,"players"));
  await Promise.all(playersSnap.docs.map(d=>updateDoc(d.ref,{
    status:"available", assignedTeamId:null, finalPrice:0
  })));

  const teamsSnap = await getDocs(collection(db,"rooms",ROOM_ID,"teams"));
  await Promise.all(teamsSnap.docs.map(d=>{
    const rosterReset={}; ROLES.forEach(r=>rosterReset[r]=null);
    return setDoc(d.ref,{
      ...d.data(),
      pointsStart:d.data().pointsStart??1000,
      pointsUsed:0,
      roster:rosterReset
    },{merge:true});
  }));

  await updateDoc(roomRef,{
    status:"waiting",
    testMode:false,
    remainingAuction:false,
    remainingQueue:[],
    remainingIndex:0,
    currentGroup:"A",
    currentPlayerId:null,
    roundId:1,
    roundEndsAt:null
  });

  alert("리셋 완료!");
}

/* ===================== 구독 ===================== */
const roomRef = doc(db,"rooms",ROOM_ID);

onSnapshot(roomRef, async (snap)=>{
  if(!snap.exists()){
    roomStatusText.textContent="rooms/room1 없음";
    roomStatusDot.className="dot finished";
    roomData=null; stopTimer(); updateBidButtonState();
    return;
  }

  roomData = snap.data();
  currentPlayerId = roomData.currentPlayerId || null;

  renderRoomStatus(roomData);
  renderModeBadge(roomData);
  updateBidButtonState();

  // ✅ 낙찰 오버레이: currentPlayerId가 바뀌면 이전 선수가 sold인지 체크
  if(prevCurrentPlayerId && currentPlayerId !== prevCurrentPlayerId){
    const prevP = playersMap.get(prevCurrentPlayerId);
    if(prevP?.status==="sold"){
      showWinOverlay(prevP);
    }
  }
  prevCurrentPlayerId = currentPlayerId;

  await renderCurrentPlayer(currentPlayerId);
  renderRosterByGroup(allPlayers, currentPlayerId);
  startTimerIfNeeded(roomData);

  const endsAtMs = toMillis(roomData.roundEndsAt);
  if (roomData.status==="bidding" && endsAtMs && endsAtMs<=Date.now()){
    safeFinalize();
  }
});

onSnapshot(collection(db,"rooms",ROOM_ID,"players"), (snap)=>{
  playersMap=new Map(); allPlayers=[];
  snap.forEach(d=>{
    const p={id:d.id, ...d.data()};
    playersMap.set(d.id,p);
    allPlayers.push(p);
  });
  renderRosterByGroup(allPlayers, currentPlayerId);
  renderTeams();
  renderCurrentPlayer(currentPlayerId);
});

onSnapshot(collection(db,"rooms",ROOM_ID,"teams"), (snap)=>{
  teamsMap=new Map();
  snap.forEach(d=>teamsMap.set(d.id,{id:d.id,...d.data()}));
  renderTeams();
  updateBidButtonState();
});

onSnapshot(query(collection(db,"rooms",ROOM_ID,"bids"), orderBy("createdAt","asc")), (snap)=>{
  allBids=[]; snap.forEach(d=>allBids.push({id:d.id,...d.data()}));
  renderBids();
});

/* ===================== 낙찰 오버레이 ===================== */
function showWinOverlay(player){
  if(!overlayEl) return;
  const teamId = player.assignedTeamId;
  const teamName =
    teamsMap.get(teamId)?.name ||
    LEADERS[teamId]?.teamName ||
    teamId;

  const color = TEAM_COLORS[teamId] || "#ffffff";

  overlayTeamEl.textContent = `${teamName} 낙찰!`;
  overlayTeamEl.style.color = color;
  overlayPhotoEl.src = player.photoUrl || "";
  overlayPhotoEl.style.color = color;
  overlayNameEl.textContent = player.name || player.id;
  overlayPriceEl.textContent = `${player.finalPrice||0}점`;

  overlayEl.classList.remove("show");
  void overlayEl.offsetWidth; // reflow for restart animation
  overlayEl.classList.add("show");

  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(()=>overlayEl.classList.remove("show"), 1500);
}

/* ===================== 렌더 ===================== */
function renderRoomStatus(d){
  const s=d.status||"waiting";
  roomStatusText.textContent =
    s==="bidding" ? (d.testMode?"테스트":"경매중")
    : s==="finished" ? "종료" : "대기중";
  roomStatusDot.className="dot "+(s==="bidding"?"bidding":s==="finished"?"finished":"");
}
function renderModeBadge(d){
  const group=d.currentGroup||"-";
  const mode=d.remainingAuction?"RE-AUCTION":"MAIN";
  const test=d.testMode?"TEST":"REAL";
  modeBadge.textContent=`${mode} · ${test} · ${group}`;
}

async function renderCurrentPlayer(pid){
  if(!pid){
    currentPhoto.src="";
    currentName.textContent="-";
    currentRoleSpan.textContent="-";
    currentGroupSpan.textContent="-";
    currentBase.textContent="-";
    currentStatus.textContent="-";
    currentBio.textContent="-";
    return;
  }
  const p=playersMap.get(pid);
  if(!p){
    const s=await getDoc(doc(db,"rooms",ROOM_ID,"players",pid));
    if(!s.exists()) return;
    playersMap.set(pid,{id:s.id,...s.data()});
    return renderCurrentPlayer(pid);
  }
  currentPhoto.src=p.photoUrl||"";
  currentName.textContent=p.name||p.id;
  currentRoleSpan.textContent=normalizeRole(p.role);
  currentGroupSpan.textContent=(p.group||"-").toUpperCase();
  currentBase.textContent=p.basePrice ?? "-";
  currentStatus.textContent=p.status || "available";
  currentBio.textContent=p.bio || "-";
}

/* ✅ 팀 컬러 주입 + 로스터 이름/낙찰가 */
function renderTeams(){
  const byId=(id)=>playersMap.get(id);

  Object.keys(teamCards).forEach(leaderId=>{
    const el=teamCards[leaderId];
    if(!el) return;

    // 카드 컬러 변수 주입
    el.style.setProperty("--team-color", TEAM_COLORS[leaderId] || "#7aa2ff");

    const info=LEADERS[leaderId];
    const team=teamsMap.get(leaderId);

    const start=team?.pointsStart ?? info.startPoints;
    const used=team?.pointsUsed ?? 0;
    const remain=start-used;

    const rawRoster = team?.roster || {};

    // ✅ assignedTeamId만으로 로스터 복구(혹시 status가 달라도 잡히게)
    const derivedRoster = {};
    allPlayers
      .filter(p => p.assignedTeamId === leaderId)
      .forEach(p=>{
        derivedRoster[normalizeRole(p.role)] = p.id;
      });

    const roster = { ...derivedRoster, ...rawRoster };

    const slotsHtml=ROLES.map(role=>{
      const pid=roster[role] || null;
      const p=pid ? byId(pid) : null;

      const hasPlayer=!!p;

      // ✅ 빈 슬롯은 역할을 큰 글씨로 안 보여줌
      const nameText = hasPlayer ? (p.name || pid) : "";
      const priceText = hasPlayer && p.finalPrice ? `${p.finalPrice}점` : "";
      const imgHtml = hasPlayer && p.photoUrl ? `<img src="${p.photoUrl}" />` : "";

      return `
        <div class="slot ${hasPlayer ? "" : "empty"}">
          ${imgHtml}
          <div class="slot-text">
            ${
              hasPlayer
                ? `<div class="slot-name">${nameText}</div>
                   ${priceText ? `<div class="slot-price">${priceText}</div>` : ""}`
                : `<div class="slot-name" style="opacity:.35;">EMPTY</div>`
            }
          </div>
          <!-- 역할은 항상 작은 라벨로만 -->
          <div class="slot-label">${role}</div>
        </div>
      `;
    }).join("");

    el.innerHTML=`
      <div class="team-header">
        <div class="team-name">${team?.name || info.teamName}</div>
        <div class="team-points">${remain} / ${start}</div>
      </div>
      <div class="team-row">${slotsHtml}</div>
    `;
  });
}


/* ✅ sold-by-team 클래스 부여 */
function renderRosterByGroup(players, currentPid){
  Object.values(rosterGroupContainers).forEach(el=>el&&(el.innerHTML=""));

  const groups={A:[],B:[],C:[]};
  players.forEach(p=>{
    const g=(p.group||"A").toUpperCase();
    (groups[g]??(groups[g]=[])).push(p);
  });

  ["A","B","C"].forEach(g=>{
    const box=rosterGroupContainers[g];
    if(!box) return;

    groups[g].sort((a,b)=>{
      const oa=a.order??9999, ob=b.order??9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    });

    groups[g].forEach(p=>{
      const avatar=document.createElement("div");
      avatar.className="avatar"
        + (p.status==="sold" ? " sold" : "")
        + (p.id===currentPid ? " current" : "");

      if(p.status==="sold" && p.assignedTeamId){
        avatar.classList.add(`sold-by-${p.assignedTeamId}`);
      }

      const img=document.createElement("img");
      img.src=p.photoUrl||"";
      img.alt=p.name||p.id;
      avatar.appendChild(img);

      if(p.tag){
        const badge=document.createElement("div");
        badge.className="badge "+(p.tag==="MVP"?"mvp":"new");
        badge.textContent=p.tag;
        avatar.appendChild(badge);
      }

      const tip=document.createElement("div");
      tip.className="name-tip";
      tip.textContent=p.name||p.id;
      avatar.appendChild(tip);

      box.appendChild(avatar);
    });
  });
}

function renderBids(){
  bidLogDiv.innerHTML="";
  if(!roomData || !currentPlayerId){
    highestAmountSpan.textContent="-";
    highestLeaderSpan.textContent="-";
    return;
  }
  const roundId=roomData.roundId ?? 0;
  const bids=allBids.filter(b=>b.roundId===roundId && b.playerId===currentPlayerId);

  let max=0, leader="-";
  bids.forEach(b=>{
    const div=document.createElement("div");
    div.className="item";
    div.textContent=`${b.leaderName} : ${b.amount}점`;
    bidLogDiv.appendChild(div);
    if(Number(b.amount)>max){ max=Number(b.amount); leader=b.leaderName; }
  });

  highestAmountSpan.textContent=bids.length?max:"-";
  highestLeaderSpan.textContent=bids.length?leader:"-";
}

/* ===================== 입찰 가능 여부 ===================== */
function updateBidButtonState(){
  const isLeader = selectedRole.startsWith("leader");
  if(!isLeader || !roomData || roomData.status!=="bidding"){
    bidButton.disabled=true; bidInput.disabled=true; return;
  }
  bidButton.disabled=false; bidInput.disabled=false;
}

/* ===================== 입찰 (그룹별 하한가 + C그룹 기본가 무시 + 5단위) ===================== */
bidButton.addEventListener("click", async ()=>{
  if(!roomData || roomData.status!=="bidding" || !currentPlayerId) return;

  const amount = Number(bidInput.value);

  // 0도 허용해야 하므로 !amount 체크 금지
  if(!Number.isFinite(amount) || amount < 0){
    alert("입찰 금액을 올바르게 입력하세요.");
    return;
  }

  // 5단위만 허용
  if (amount % 5 !== 0) {
    alert("입찰은 5점 단위로만 가능합니다. (예: 5, 10, 15...)");
    return;
  }

  const leaderInfo = LEADERS[selectedRole];
  if(!leaderInfo){
    alert("팀장을 선택하세요.");
    return;
  }

  // 포인트 부족 체크
  const team = teamsMap.get(selectedRole);
  const start = team?.pointsStart ?? leaderInfo.startPoints;
  const used  = team?.pointsUsed ?? 0;
  const remain = start - used;
  if(amount > remain){
    alert("포인트가 부족합니다.");
    return;
  }

  const p = playersMap.get(currentPlayerId);
  const baseRaw = Number(p?.basePrice ?? 0);
  const currentMax = Number(highestAmountSpan.textContent) || 0;

  // ✅ 그룹값 robust 파싱 ("A", "A그룹", "Group A" 등 대응)
  const gRaw = String(p?.group ?? "C").toUpperCase().trim();
  const groupLetter = (gRaw.match(/[ABC]/)?.[0]) || "C";

  // ✅ 그룹별 최소 하한가
  let groupMin = 0;
  if(groupLetter === "A") groupMin = 300;
  else if(groupLetter === "B") groupMin = 100;
  else groupMin = 0; // C는 제한 없음(0)

  // ✅ 기본가 5단위 올림
  let minBidByBase = baseRaw;
  if (minBidByBase % 5 !== 0) minBidByBase = Math.ceil(minBidByBase / 5) * 5;

  // ✅ 최종 최소입찰 계산
  // - A/B: max(그룹하한, 기본가)
  // - C: 그룹하한만 사용(=0), 기본가 무시
  const minBid = (groupLetter === "C")
    ? groupMin
    : Math.max(groupMin, minBidByBase);

  if(amount < minBid){
    alert(
      `${groupLetter}그룹 선수입니다.\n` +
      `- 그룹 최소: ${groupMin}점\n` +
      (groupLetter === "C"
        ? `- C그룹은 기본가 제한 없음\n`
        : `- 기본가: ${baseRaw}점\n`) +
      `→ 현재 최소 입찰 가능: ${minBid}점`
    );
    return;
  }

  // 최고가 + 5 규칙
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
      createdAt: serverTimestamp()
    });
    bidInput.value = "";
  }catch(e){
    console.error(e);
    alert("입찰 오류: " + (e.message || e.code));
  }
});

/* ===================== 타이머 ===================== */
let timerInterval=null;

function startTimerFromEndsAt(ms){
  if(timerInterval) clearInterval(timerInterval);
  const tick=()=>{
    const left=Math.max(0, Math.ceil((ms-Date.now())/1000));
    timerSpan.textContent=left;
    if(left<=0){
      clearInterval(timerInterval); timerInterval=null;
      safeFinalize();
    }
  };
  tick();
  timerInterval=setInterval(tick,250);
}
function stopTimer(){
  if(timerInterval) clearInterval(timerInterval);
  timerInterval=null; timerSpan.textContent="-";
}
function startTimerIfNeeded(d){
  if(d.status!=="bidding" || !d.roundEndsAt){ stopTimer(); return; }
  const endsAtMs=toMillis(d.roundEndsAt);
  if(!endsAtMs){ stopTimer(); return; }
  startTimerFromEndsAt(endsAtMs);
}

/* ===================== finalize 안전 래퍼 ===================== */
async function safeFinalize(){
  if(finalizeInFlight) return;
  finalizeInFlight=true;
  try{ await finalizeRound(); }
  catch(e){ console.error(e); alert("Finalize 실패: "+(e.message||e.code)); }
  finally{ finalizeInFlight=false; }
}

/* ===================== 라운드 종료(인덱스 없음 + read-first OK) ===================== */
async function finalizeRound(){
  const roomRef = doc(db,"rooms",ROOM_ID);

  const roomSnap0=await getDoc(roomRef);
  if(!roomSnap0.exists()) return;
  const room0=roomSnap0.data();
  if(room0.status!=="bidding") return;

  const roundId0=room0.roundId??0;
  const playerId0=room0.currentPlayerId;
  if(!playerId0) return;

  const playerRef=doc(db,"rooms",ROOM_ID,"players",playerId0);
  const playerSnap0=await getDoc(playerRef);
  if(!playerSnap0.exists()) return;
  const player0=playerSnap0.data();

  // 최고 입찰 찾기(로컬 max)
  let topBid0=null;
  const localBids=allBids.filter(b=>b.roundId===roundId0 && b.playerId===playerId0);
  if(localBids.length){
    localBids.sort((a,b)=>Number(b.amount)-Number(a.amount));
    topBid0=localBids[0];
  }else{
    const allBidsSnap=await getDocs(collection(db,"rooms",ROOM_ID,"bids"));
    const arr=allBidsSnap.docs.map(d=>d.data());
    const roundBids=arr.filter(b=>b.roundId===roundId0 && b.playerId===playerId0);
    if(roundBids.length){
      roundBids.sort((a,b)=>Number(b.amount)-Number(a.amount));
      topBid0=roundBids[0];
    }
  }

  // 다음 선수
  let nextPlayer=null;
  let nextGroup=room0.currentGroup||"A";
  let nextRemainingIndex=room0.remainingIndex??0;

  if(room0.remainingAuction){
    const q=room0.remainingQueue||[];
    const idx=(room0.remainingIndex??0)+1;
    const nextId=q[idx]||null;
    nextRemainingIndex=idx;
    if(nextId){
      const ns=await getDoc(doc(db,"rooms",ROOM_ID,"players",nextId));
      if(ns.exists()) nextPlayer={id:ns.id,...ns.data()};
    }
  }else{
    const playersSnap0=await getDocs(collection(db,"rooms",ROOM_ID,"players"));
    const all0=playersSnap0.docs.map(d=>({id:d.id,...d.data()}));

    const findInGroup=(g)=>all0
      .filter(p=>(p.group||"A").toUpperCase()===g && p.status!=="sold")
      .sort((a,b)=> (a.order??9999)-(b.order??9999) || a.id.localeCompare(b.id))[0]||null;

    let group=(room0.currentGroup||"A").toUpperCase();
    let gi=GROUP_ORDER.indexOf(group); if(gi<0) gi=0;

    nextPlayer=findInGroup(group);
    while(!nextPlayer && gi<GROUP_ORDER.length-1){
      gi++; group=GROUP_ORDER[gi]; nextPlayer=findInGroup(group);
    }
    nextGroup=group;
  }

  await runTransaction(db, async(tx)=>{
    const roomSnap=await tx.get(roomRef);
    if(!roomSnap.exists()) return;
    const room=roomSnap.data();
    if(room.status!=="bidding") return;
    if((room.roundId??0)!==roundId0) return;
    if(room.currentPlayerId!==playerId0) return;

    if(room.testMode || !topBid0){
      tx.update(roomRef,{
        currentPlayerId: nextPlayer?.id||null,
        currentGroup: nextGroup,
        remainingIndex: room.remainingAuction?nextRemainingIndex:(room.remainingIndex??0),
        roundId: roundId0+1,
        roundEndsAt: nextPlayer?Date.now()+ROUND_SECONDS*1000:null,
        status: nextPlayer?"bidding":"waiting"
      });
      return;
    }

    const winnerLeaderId=topBid0.leaderId;
    const price=Number(topBid0.amount)||0;
    const role=normalizeRole(player0.role);

    const teamRef=doc(db,"rooms",ROOM_ID,"teams",winnerLeaderId);
    const teamSnap=await tx.get(teamRef);
    const team=teamSnap.exists()?teamSnap.data():{
      name:LEADERS[winnerLeaderId]?.teamName||winnerLeaderId,
      pointsStart:1000, pointsUsed:0, roster:{}
    };

    // writes
    tx.update(playerRef,{
      status:"sold",
      assignedTeamId:winnerLeaderId,
      finalPrice:price
    });

    const newRoster={...(team.roster||{})};
    newRoster[role]=playerId0;

    tx.set(teamRef,{
      ...team,
      pointsUsed:(team.pointsUsed||0)+price,
      roster:newRoster
    },{merge:true});

    tx.update(roomRef,{
      currentPlayerId: nextPlayer?.id||null,
      currentGroup: nextGroup,
      remainingIndex: room.remainingAuction?nextRemainingIndex:(room.remainingIndex??0),
      roundId: roundId0+1,
      roundEndsAt: nextPlayer?Date.now()+ROUND_SECONDS*1000:null,
      status: nextPlayer?"bidding":"waiting"
    });
  });
}

/* ===================== 유틸 ===================== */
async function findFirstAvailablePlayerInGroup(group){
  const snap=await getDocs(collection(db,"rooms",ROOM_ID,"players"));
  const arr=snap.docs.map(d=>({id:d.id,...d.data()}));
  return arr.filter(p=>(p.group||"A").toUpperCase()===group && p.status!=="sold")
    .sort((a,b)=>(a.order??9999)-(b.order??9999) || a.id.localeCompare(b.id))[0]||null;
}

/* 초기 */
adminControls.style.display="none";
updateBidButtonState();
