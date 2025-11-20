// app.js (REAL-TIME AUCTION + REMAINING RE-AUCTION)
import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, onSnapshot,
  collection, addDoc, query, orderBy, where, limit,
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
const ROLES = ["TOP","JGL","MID","BOT","SUP"];

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

/* ===================== 상태 ===================== */
let selectedRole = "viewer";
let roomData = null;
let currentPlayerId = null;
let playersMap = new Map();
let allPlayers = [];
let teamsMap = new Map();
let allBids = [];

/* ===================== 역할 선택 ===================== */
roleSelect.addEventListener("change", () => {
  selectedRole = roleSelect.value;
  adminControls.style.display = (selectedRole === "operator") ? "flex" : "none";
  updateBidButtonState();
});

/* ===================== 운영자 버튼 ===================== */
btnStartTest.addEventListener("click", ()=> adminStartMainAuction(true));
btnStartReal.addEventListener("click", ()=> adminStartMainAuction(false));
btnStartRemaining.addEventListener("click", adminStartRemainingAuction);
btnReset.addEventListener("click", adminResetAll);

/* ---- 1차 경매 시작(A→B→C 자동 진행) ---- */
async function adminStartMainAuction(testMode){
  try{
    const roomRef = doc(db,"rooms",ROOM_ID);
    const roomSnap = await getDoc(roomRef);
    if(!roomSnap.exists()){
      alert("rooms/room1 문서가 없습니다.");
      return;
    }
    const room = roomSnap.data();
    const group = (room.currentGroup || "A").toUpperCase();

    const firstPlayer = await findFirstAvailablePlayerInGroup(group);
    await updateDoc(roomRef,{
      status:"bidding",
      testMode: !!testMode,
      remainingAuction: false,
      remainingQueue: [],
      remainingIndex: 0,
      currentGroup: group,
      currentPlayerId: firstPlayer?.id || null,
      roundId: (room.roundId ?? 0) + 1,
      roundEndsAt: Date.now() + ROUND_SECONDS*1000,
    });

    alert(testMode ? "테스트 시작(낙찰 없음)" : "1차 경매 시작");
  }catch(e){
    console.error(e);
    alert("시작 오류. 콘솔 확인.");
  }
}

/* ---- 잔여 선수 재경매 시작(sold 안 된 선수만) ---- */
async function adminStartRemainingAuction(){
  try{
    const roomRef = doc(db,"rooms",ROOM_ID);
    const roomSnap = await getDoc(roomRef);
    if(!roomSnap.exists()){
      alert("rooms/room1 문서가 없습니다.");
      return;
    }
    const room = roomSnap.data();

    const playersSnap = await getDocs(collection(db,"rooms",ROOM_ID,"players"));
    const remain = playersSnap.docs
      .map(d=>({id:d.id, ...d.data()}))
      .filter(p => p.status !== "sold")
      .sort((a,b)=>{
        const ga=(a.group||"A").toUpperCase();
        const gb=(b.group||"A").toUpperCase();
        if(ga!==gb) return GROUP_ORDER.indexOf(ga)-GROUP_ORDER.indexOf(gb);
        const oa=a.order ?? 9999, ob=b.order ?? 9999;
        if(oa!==ob) return oa-ob;
        return a.id.localeCompare(b.id);
      });

    if(remain.length === 0){
      alert("잔여 선수가 없습니다!");
      return;
    }

    await updateDoc(roomRef,{
      status:"bidding",
      testMode:false,
      remainingAuction:true,
      remainingQueue: remain.map(p=>p.id),
      remainingIndex: 0,
      currentGroup: "REMAIN",
      currentPlayerId: remain[0].id,
      roundId: (room.roundId ?? 0) + 1,
      roundEndsAt: Date.now() + ROUND_SECONDS*1000,
    });

    alert("잔여 선수 재경매 시작!");
  }catch(e){
    console.error(e);
    alert("잔여 재경매 시작 오류. 콘솔 확인.");
  }
}

/* ---- 전체 리셋 ---- */
async function adminResetAll(){
  if(!confirm("모든 팀/선수/입찰을 초기화할까요?")) return;

  try{
    const roomRef = doc(db,"rooms",ROOM_ID);

    // bids 삭제
    const bidsSnap = await getDocs(collection(db,"rooms",ROOM_ID,"bids"));
    await Promise.all(bidsSnap.docs.map(d=> deleteDoc(d.ref)));

    // players 초기화
    const playersSnap = await getDocs(collection(db,"rooms",ROOM_ID,"players"));
    await Promise.all(playersSnap.docs.map(d=>{
      return updateDoc(d.ref,{
        status:"available",
        assignedTeamId:null,
        finalPrice:0
      });
    }));

    // teams 초기화
    const teamsSnap = await getDocs(collection(db,"rooms",ROOM_ID,"teams"));
    await Promise.all(teamsSnap.docs.map(d=>{
      const rosterReset = {};
      ROLES.forEach(r=> rosterReset[r]=null);
      return setDoc(d.ref,{
        ...d.data(),
        pointsStart: d.data().pointsStart ?? 1000,
        pointsUsed: 0,
        roster: rosterReset
      },{merge:true});
    }));

    // room 초기화
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
  }catch(e){
    console.error(e);
    alert("리셋 오류. 콘솔 확인.");
  }
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
  roomData=snap.data();
  currentPlayerId=roomData.currentPlayerId || null;

  renderRoomStatus(roomData);
  renderModeBadge(roomData);
  updateBidButtonState();
  await renderCurrentPlayer(currentPlayerId);
  renderRosterByGroup(allPlayers, currentPlayerId);
  startTimerIfNeeded(roomData);
});

onSnapshot(collection(db,"rooms",ROOM_ID,"players"), (snap)=>{
  playersMap=new Map(); allPlayers=[];
  snap.forEach(d=>{
    const p={id:d.id, ...d.data()};
    playersMap.set(d.id,p); allPlayers.push(p);
  });
  renderRosterByGroup(allPlayers, currentPlayerId);
  renderTeams();                 // ✅ TEAM ROSTER 갱신
  renderCurrentPlayer(currentPlayerId);
});

onSnapshot(collection(db,"rooms",ROOM_ID,"teams"), (snap)=>{
  teamsMap=new Map();
  snap.forEach(d=>teamsMap.set(d.id, {id:d.id, ...d.data()}));
  renderTeams();                 // ✅ TEAM ROSTER 갱신
  updateBidButtonState();
});

onSnapshot(query(collection(db,"rooms",ROOM_ID,"bids"), orderBy("createdAt","asc")), (snap)=>{
  allBids=[]; snap.forEach(d=>allBids.push({id:d.id, ...d.data()}));
  renderBids();
});

/* ===================== 렌더 ===================== */
function renderRoomStatus(d){
  const s=d.status || "waiting";
  roomStatusText.textContent =
    s==="bidding" ? (d.testMode ? "테스트 진행" : (d.remainingAuction ? "잔여 재경매" : "1차 진행"))
  : s==="finished" ? "종료"
  : "대기중";
  roomStatusDot.className="dot " + (s==="bidding"?"bidding": s==="finished"?"finished":"");
}

function renderModeBadge(d){
  const group = d.currentGroup || "-";
  const mode = d.remainingAuction ? "RE-AUCTION" : "MAIN";
  const test = d.testMode ? "TEST" : "REAL";
  modeBadge.textContent = `${mode} · ${test} · ${group}`;
}

async function renderCurrentPlayer(pid){
  if(!pid){
    currentPhoto.src=""; currentName.textContent="-";
    currentRoleSpan.textContent="-"; currentGroupSpan.textContent="-";
    currentBase.textContent="-"; currentStatus.textContent="-"; currentBio.textContent="-";
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
  currentRoleSpan.textContent=(p.role||"-").toUpperCase();
  currentGroupSpan.textContent=(p.group||"-").toUpperCase();
  currentBase.textContent=p.basePrice ?? "-";
  currentStatus.textContent=p.status || "available";
  currentBio.textContent=p.bio || "-";
}

/* ✅ TEAM ROSTER: 이름 + 낙찰가 표시 */
function renderTeams(){
  const byId=(id)=>playersMap.get(id);

  Object.keys(teamCards).forEach(leaderId=>{
    const el=teamCards[leaderId]; if(!el) return;
    const info=LEADERS[leaderId];
    const team=teamsMap.get(leaderId);

    const start=team?.pointsStart ?? info.startPoints;
    const used=team?.pointsUsed ?? 0;
    const remain=start-used;

    const roster=team?.roster || {};

    const slotsHtml=ROLES.map(role=>{
      const pid=roster[role] || null;
      const p=pid ? byId(pid) : null;

      const hasPlayer = !!p;
      const nameText = hasPlayer ? (p.name || pid) : role;
      const priceText = hasPlayer && p.finalPrice ? `${p.finalPrice}점` : "";

      const imgHtml = p?.photoUrl ? `<img src="${p.photoUrl}" />` : "";

      return `
        <div class="slot ${hasPlayer ? "" : "empty"}" title="${p?.name||role}">
          ${imgHtml}
          <div class="slot-text">
            <div class="slot-name">${nameText}</div>
            ${priceText ? `<div class="slot-price">${priceText}</div>` : ""}
          </div>
          <div class="slot-label">${role}</div>
        </div>
      `;
    }).join("");

    el.innerHTML=`
      <div class="team-header">
        <div>${team?.name || info.teamName}</div>
        <div class="team-points">${remain} / ${start}</div>
      </div>
      <div class="team-row">${slotsHtml}</div>
    `;
  });
}

function renderRosterByGroup(players, currentPid){
  Object.values(rosterGroupContainers).forEach(el=>el&&(el.innerHTML=""));
  const groups={A:[],B:[],C:[]};
  players.forEach(p=>{
    const g=(p.group||"A").toUpperCase();
    (groups[g]??(groups[g]=[])).push(p);
  });

  ["A","B","C"].forEach(g=>{
    const box=rosterGroupContainers[g]; if(!box) return;

    groups[g].sort((a,b)=>{
      const ra=(a.role||"").toUpperCase(), rb=(b.role||"").toUpperCase();
      if(ra!==rb) return ra.localeCompare(rb);
      const oa=a.order??9999, ob=b.order??9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    });

    groups[g].forEach(p=>{
      const avatar=document.createElement("div");
      avatar.className="avatar"+(p.status==="sold"?" sold":"")+(p.id===currentPid?" current":"");
      const img=document.createElement("img");
      img.src=p.photoUrl||""; img.alt=p.name||p.id;
      avatar.appendChild(img);

      if(p.tag){
        const badge=document.createElement("div");
        badge.className="badge "+(p.tag==="MVP"?"mvp":"new");
        badge.textContent=p.tag;
        avatar.appendChild(badge);
      }

      const tip=document.createElement("div");
      tip.className="name-tip";
      tip.textContent=`${p.name||p.id} · ${(p.role||"-").toUpperCase()}`;
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

/* ===================== 실시간 경매 입찰 가능 ===================== */
function updateBidButtonState(){
  const isLeader = selectedRole.startsWith("leader");
  if(!isLeader || !roomData || roomData.status!=="bidding"){
    bidButton.disabled=true; bidInput.disabled=true; return;
  }
  bidButton.disabled=false; bidInput.disabled=false; // TURN 없음
}

/* ===================== 입찰 ===================== */
bidButton.addEventListener("click", async ()=>{
  if(!roomData || roomData.status!=="bidding" || !currentPlayerId) return;

  const amount=Number(bidInput.value);
  if(!amount || amount<=0){ alert("입찰 금액 입력"); return; }

  const leaderInfo=LEADERS[selectedRole];
  if(!leaderInfo){ alert("팀장 선택"); return; }

  const team=teamsMap.get(selectedRole);
  const start=team?.pointsStart ?? leaderInfo.startPoints;
  const used=team?.pointsUsed ?? 0;
  const remain=start-used;
  if(amount>remain){ alert("포인트 부족"); return; }

  const p=playersMap.get(currentPlayerId);
  const base=p?.basePrice ?? 0;
  const currentMax=Number(highestAmountSpan.textContent)||0;

  if(amount<base){ alert(`기본가(${base}) 이상으로`); return; }
  if(currentMax && amount<=currentMax){ alert(`최고가(${currentMax})보다 높게`); return; }

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
      finalizeRound();
    }
  };
  tick(); timerInterval=setInterval(tick,250);
}
function stopTimer(){
  if(timerInterval) clearInterval(timerInterval);
  timerInterval=null; timerSpan.textContent="-";
}
function startTimerIfNeeded(d){
  if(d.status!=="bidding" || !d.roundEndsAt){ stopTimer(); return; }
  startTimerFromEndsAt(d.roundEndsAt);
}

/* ===================== 라운드 종료 처리 ===================== */
async function finalizeRound(){
  const roomRef=doc(db,"rooms",ROOM_ID);

  await runTransaction(db, async (tx)=>{
    const roomSnap=await tx.get(roomRef);
    if(!roomSnap.exists()) return;
    const room=roomSnap.data();
    if(room.status!=="bidding") return;

    const roundId=room.roundId ?? 0;
    const playerId=room.currentPlayerId;
    if(!playerId) return;

    // TEST 모드: 낙찰/포인트 변경 없이 다음 선수로
    if(room.testMode){
      const next = await getNextPlayer(tx, room);
      tx.update(roomRef,{
        currentPlayerId: next?.id || null,
        roundId: roundId+1,
        roundEndsAt: next ? Date.now()+ROUND_SECONDS*1000 : null,
        status: next ? "bidding" : "waiting"
      });
      return;
    }

    // 최고가 1건
    const bidsQ=query(
      collection(db,"rooms",ROOM_ID,"bids"),
      where("roundId","==",roundId),
      where("playerId","==",playerId),
      orderBy("amount","desc"),
      limit(1)
    );
    const bidsSnap=await tx.get(bidsQ);

    if(bidsSnap.empty){
      // 입찰 없음 → sold 처리 안 하고 다음 선수로
      const next = await getNextPlayer(tx, room);
      tx.update(roomRef,{
        currentPlayerId: next?.id || null,
        roundId: roundId+1,
        roundEndsAt: next ? Date.now()+ROUND_SECONDS*1000 : null,
        status: next ? "bidding" : "waiting"
      });
      return;
    }

    const topBid=bidsSnap.docs[0].data();
    const winnerLeaderId=topBid.leaderId;
    const price=Number(topBid.amount)||0;

    const playerRef=doc(db,"rooms",ROOM_ID,"players",playerId);
    const playerSnap=await tx.get(playerRef);
    if(!playerSnap.exists()) return;
    const player=playerSnap.data();
    const role=(player.role||"TOP").toUpperCase();

    // 선수 sold + finalPrice 저장
    tx.update(playerRef,{
      status:"sold",
      assignedTeamId:winnerLeaderId,
      finalPrice:price
    });

    // 팀 포인트/로스터
    const teamRef=doc(db,"rooms",ROOM_ID,"teams",winnerLeaderId);
    const teamSnap=await tx.get(teamRef);
    const team=teamSnap.exists()? teamSnap.data() : {
      name: LEADERS[winnerLeaderId]?.teamName || winnerLeaderId,
      pointsStart:1000, pointsUsed:0, roster:{}
    };
    const newRoster={...(team.roster||{})};
    newRoster[role]=playerId;

    tx.set(teamRef,{
      ...team,
      pointsUsed:(team.pointsUsed||0)+price,
      roster:newRoster
    },{merge:true});

    // 다음 선수
    const next = await getNextPlayer(tx, room);
    tx.update(roomRef,{
      currentPlayerId: next?.id || null,
      roundId: roundId+1,
      roundEndsAt: next ? Date.now()+ROUND_SECONDS*1000 : null,
      status: next ? "bidding" : "waiting"
    });
  });
}

/* ===================== 다음 선수 선택 ===================== */
async function getNextPlayer(tx, room){
  const isRemain = !!room.remainingAuction;
  if(isRemain){
    const queue = room.remainingQueue || [];
    const idx = (room.remainingIndex ?? 0) + 1;
    const nextId = queue[idx];

    if(!nextId) return null;
    tx.update(doc(db,"rooms",ROOM_ID),{ remainingIndex: idx });
    const snap = await tx.get(doc(db,"rooms",ROOM_ID,"players",nextId));
    if(!snap.exists()) return null;
    return { id:snap.id, ...snap.data() };
  }

  let group = (room.currentGroup || "A").toUpperCase();
  let groupIdx = GROUP_ORDER.indexOf(group);
  if(groupIdx<0) groupIdx=0;

  const playersSnap = await tx.get(collection(db,"rooms",ROOM_ID,"players"));
  const all = playersSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const findInGroup = (g)=> all
    .filter(p => (p.group||"A").toUpperCase()===g && p.status!=="sold")
    .sort((a,b)=>{
      const oa=a.order??9999, ob=b.order??9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    })[0] || null;

  let next = findInGroup(group);

  while(!next && groupIdx < GROUP_ORDER.length-1){
    groupIdx++;
    group = GROUP_ORDER[groupIdx];
    next = findInGroup(group);
  }

  if(next){
    tx.update(doc(db,"rooms",ROOM_ID),{ currentGroup: group });
  }
  return next;
}

async function findFirstAvailablePlayerInGroup(group){
  const snap = await getDocs(collection(db,"rooms",ROOM_ID,"players"));
  const arr = snap.docs.map(d=>({id:d.id, ...d.data()}));
  return arr
    .filter(p => (p.group||"A").toUpperCase()===group && p.status!=="sold")
    .sort((a,b)=>{
      const oa=a.order??9999, ob=b.order??9999;
      if(oa!==ob) return oa-ob;
      return a.id.localeCompare(b.id);
    })[0] || null;
}

/* 초기 */
adminControls.style.display="none";
updateBidButtonState();
