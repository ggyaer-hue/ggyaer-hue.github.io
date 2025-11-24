// app.js (ROOM1 FINAL, GROUP A/B only)
// -----------------------------------
import { app, db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, onSnapshot, query, orderBy,
  runTransaction, updateDoc, setDoc, serverTimestamp,
  writeBatch, increment, where, addDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;
const BID_STEP = 5;
const TEAM_START_POINTS = 1000;

// 그룹별 최소 입찰 하한가
const MIN_BID_BY_GROUP = { A: 300, B: 0 };

// ====== FIRESTORE REFS ======
const roomRef = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol   = collection(db, "rooms", ROOM_ID, "teams");
const logsCol    = collection(db, "rooms", ROOM_ID, "logs");

// ====== DOM HELPERS ======
const el = (id) => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);

function text(id, v) { const n = el(id); if (n) n.textContent = v ?? ""; }
function show(id, on=true){ const n=el(id); if(n) n.style.display=on?"":"none"; }

// 유연한 컨테이너 찾기(인덱스 id명이 달라도 최대한 잡아줌)
function getGroupContainer(g){
  return el(`group${g}List`)
      || qs(`#group${g}List`)
      || qs(`[data-group="${g}"]`)
      || qs(`#group-${g.toLowerCase()}`)
      || null;
}
function getTeamContainer(i){
  return el(`team${i}Roster`)
      || qs(`#team${i}Roster`)
      || qs(`[data-team="${i}"] .team-roster`)
      || qs(`#team-${i} .team-roster`)
      || qs(`#team${i} .team-roster`)
      || null;
}
function getTeamPointsEl(i){
  return el(`team${i}Points`) || qs(`#team${i}Points`) || qs(`[data-team="${i}"] .team-points`);
}

// ====== STATE ======
let roomState = null;
let players = [];    // all players
let teams = [];      // teams array [{id,data}]
let myRole = "viewer"; // leader1..leader4 / operator / viewer
let tickTimer = null;

// ====== NORMALIZE ======
const normGroup = (g) => String(g || "A").trim().toUpperCase();
const normStatus= (s) => String(s || "available").trim().toLowerCase();

function isOperator(){
  return myRole === "operator";
}
function myTeamId(){
  if (myRole.startsWith("leader")) return myRole; // leader1..leader4
  return null;
}

// ====== LISTENERS ======
onSnapshot(roomRef, (snap) => {
  roomState = snap.exists() ? snap.data() : null;
  renderAll();
  syncTick();
});

onSnapshot(query(teamsCol, orderBy("orderIndex")), (snap) => {
  teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderTeams();
});

onSnapshot(query(playersCol, orderBy("orderIndex")), (snap) => {
  players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderGroups();
  renderTeams();
  renderCurrent();
});

// ====== RENDER ======
function renderAll(){
  renderCurrent();
  renderGroups();
  renderTeams();
  renderLogsPreview();
  renderStatus();
}

function renderStatus(){
  if(!roomState) return;
  text("roomTitle", roomState.title || "ROOM1");
  text("phaseLabel", roomState.currentGroup ? `GROUP ${roomState.currentGroup}` : "");
  // 안내 문구(본경매 시작 등)
  const ann = roomState.announcement;
  const annBox = el("announcementBox") || el("announcement");
  if (annBox){
    if (ann){
      annBox.textContent = ann;
      annBox.style.display = "";
      // 로컬에서만 3초 후 숨김(DB는 유지)
      setTimeout(() => { annBox.style.display="none"; }, 3000);
    } else {
      annBox.style.display = "none";
    }
  }
}

function renderCurrent(){
  if(!roomState){
    text("currentName","-");
    text("currentRole","-");
    text("currentGroup","-");
    text("currentBase","-");
    const img=el("currentImg"); if(img) img.src="";
    return;
  }
  const curId = roomState.currentPlayerId;
  const cur = players.find(p => p.id === curId);

  text("currentName", cur?.name || "-");
  text("currentRole", cur?.role || "-");
  text("currentGroup", normGroup(cur?.group) || "-");
  text("currentBase", cur?.basePrice ?? 0);

  const img = el("currentImg");
  if(img){
    const u = cur?.photoUrl || "";
    img.src = u;
    img.alt = cur?.name || "current player";
  }

  text("highestBid", roomState.highestBid ?? 0);
  text("highestBidder", roomState.highestBidderName || "-");

  // TIME COUNT에 현재 선수 이름 같이 표시
  const tcName = el("timeCountName");
  if(tcName) tcName.textContent = cur?.name || "-";
}

function renderGroups(){
  const aBox = getGroupContainer("A");
  const bBox = getGroupContainer("B");
  if(aBox) aBox.innerHTML = "";
  if(bBox) bBox.innerHTML = "";

  const avail = players.filter(p => normStatus(p.status)==="available");

  const groupA = avail.filter(p => normGroup(p.group)==="A");
  const groupB = avail.filter(p => normGroup(p.group)==="B"); // ✅ 공백/소문자도 다 잡힘

  if(aBox) groupA.forEach(p => aBox.appendChild(playerCard(p)));
  if(bBox) groupB.forEach(p => bBox.appendChild(playerCard(p)));

  // 혹시 그룹 값이 이상하면 콘솔에 경고 남김
  const weird = avail.filter(p => !["A","B"].includes(normGroup(p.group)));
  if (weird.length){
    console.warn("Unknown group players:", weird.map(w=>({id:w.id, group:w.group, name:w.name})));
  }
}

function playerCard(p){
  const card = document.createElement("div");
  card.className = "player-card";
  card.dataset.pid = p.id;

  const img = document.createElement("img");
  img.className = "player-img";
  img.src = p.photoUrl || "";
  img.alt = p.name;

  const name = document.createElement("div");
  name.className = "player-name";
  name.textContent = p.name || p.id;

  card.appendChild(img);
  card.appendChild(name);

  // 클릭 시 운영자가 현재경매로 올릴 수 있게(선택 기능)
  card.addEventListener("click", () => {
    if(!isOperator()) return;
    pickPlayerAsCurrent(p.id);
  });

  return card;
}

function renderTeams(){
  // sold players by assignedTeamId
  const sold = players.filter(p => normStatus(p.status)==="sold" && p.assignedTeamId);
  const soldByTeam = {};
  sold.forEach(p => {
    if(!soldByTeam[p.assignedTeamId]) soldByTeam[p.assignedTeamId] = [];
    soldByTeam[p.assignedTeamId].push(p);
  });

  // teams might not be ordered if no orderIndex
  const orderedTeams = teams.length ? teams : [
    {id:"leader1", name:"TEAM 1"},
    {id:"leader2", name:"TEAM 2"},
    {id:"leader3", name:"TEAM 3"},
    {id:"leader4", name:"TEAM 4"},
  ];

  orderedTeams.forEach((t, idx) => {
    const i = idx + 1;
    const box = getTeamContainer(i);
    if(!box) return;
    box.innerHTML = "";

    const roster = (soldByTeam[t.id] || []).sort((a,b)=>(a.orderIndex??999)-(b.orderIndex??999));
    for(let s=0; s<5; s++){
      const slot = document.createElement("div");
      slot.className = "roster-slot";
      if(roster[s]){
        slot.classList.add("filled");
        slot.innerHTML = `
          <img class="roster-img" src="${roster[s].photoUrl||""}" alt="${roster[s].name}">
          <div class="roster-name">${roster[s].name}</div>
          <div class="roster-price">${roster[s].finalPrice ?? 0}점</div>
        `;
      }else{
        slot.textContent = "EMPTY";
      }
      box.appendChild(slot);
    }

    const pEl = getTeamPointsEl(i);
    if(pEl){
      const remain = t.pointsRemaining ?? t.points ?? TEAM_START_POINTS;
      pEl.textContent = `${remain} / ${TEAM_START_POINTS}`;
    }
  });
}

function renderLogsPreview(){
  const logBox = el("logBox") || el("bidLog");
  if(!logBox) return;
  // 실시간 로그는 아래 listener에서 따로 렌더
}

let logUnsub = null;
function attachLogListener(){
  if(logUnsub) logUnsub();
  logUnsub = onSnapshot(query(logsCol, orderBy("createdAt","asc")), (snap)=>{
    const logBox = el("logBox") || el("bidLog");
    if(!logBox) return;
    logBox.innerHTML = "";
    snap.docs.forEach(d=>{
      const x = d.data();
      const row = document.createElement("div");
      row.className="log-row";
      row.textContent = `${x.teamName||x.teamId} - ${x.playerName} : ${x.amount}점`;
      logBox.appendChild(row);
    });
  });
}
attachLogListener();

// ====== TICK / TIMER ======
function syncTick(){
  if(tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(()=>{
    if(!roomState?.endsAtMs){
      text("timeLeft","-");
      return;
    }
    const leftMs = roomState.endsAtMs - Date.now();
    const leftSec = Math.max(0, Math.ceil(leftMs/1000));
    text("timeLeft", leftSec);

    // 0초 되면 운영자가 유찰/낙찰 처리 후 다음 선수
    if(leftSec<=0 && isOperator()){
      autoFinalizeByTimeout();
    }
  }, 250);
}

async function autoFinalizeByTimeout(){
  if(roomState?.finalizing) return;
  try{
    await finalizeCurrentAuction("timeout");
  }catch(e){
    console.error("autoFinalizeByTimeout error:", e);
  }
}

// ====== AUCTION FLOW ======
function getNextPlayerId(group){
  const g = normGroup(group);
  const avail = players
    .filter(p => normStatus(p.status)==="available" && normGroup(p.group)===g)
    .sort((a,b)=>(a.orderIndex??999)-(b.orderIndex??999));
  return avail[0]?.id || null;
}

async function pickPlayerAsCurrent(pid){
  if(!isOperator()) return;
  await updateDoc(roomRef,{
    currentPlayerId: pid,
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    endsAtMs: Date.now() + AUCTION_SECONDS*1000,
    status: "running",
    phase: normGroup(players.find(p=>p.id===pid)?.group || "A"),
    announcement: null,
    finalizing: false,
  });
}

async function startMainAuction(){
  if(!isOperator()) return;
  const firstA = getNextPlayerId("A");
  if(!firstA){
    alert("GROUP A에 남은 선수가 없습니다.");
    return;
  }
  await updateDoc(roomRef,{
    status:"running",
    currentGroup:"A",
    phase:"A",
    currentPlayerId:firstA,
    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,
    endsAtMs: Date.now() + AUCTION_SECONDS*1000,
    announcement: "본경매 시작!",
    finalizing:false,
  });
}

async function finalizeCurrentAuction(reason="sold"){
  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    if(!roomSnap.exists()) throw new Error("room missing");
    const r = roomSnap.data();
    if(r.finalizing) return;
    const curId = r.currentPlayerId;
    if(!curId){
      tx.update(roomRef,{finalizing:false});
      return;
    }

    const curRef = doc(playersCol, curId);
    const curSnap = await tx.get(curRef);
    if(!curSnap.exists()){
      tx.update(roomRef,{currentPlayerId:null, finalizing:false});
      return;
    }
    const cur = curSnap.data();
    const curGroup = normGroup(cur.group);

    const highestBid = r.highestBid ?? 0;
    const bidderId = r.highestBidderId || null;

    // ✅ 먼저 finalizing 락
    tx.update(roomRef,{finalizing:true});

    if(highestBid>0 && bidderId){
      // sold
      tx.update(curRef,{
        status:"sold",
        assignedTeamId: bidderId,
        finalPrice: highestBid,
        updatedAt: serverTimestamp(),
      });

      const teamRef = doc(teamsCol, bidderId);
      const teamSnap = await tx.get(teamRef);
      if(teamSnap.exists()){
        const t = teamSnap.data();
        const remain = (t.pointsRemaining ?? t.points ?? TEAM_START_POINTS) - highestBid;
        tx.update(teamRef,{ pointsRemaining: remain });
      }
    }else{
      // unsold (유찰)
      tx.update(curRef,{
        status:"unsold",
        assignedTeamId:null,
        finalPrice:0,
        updatedAt: serverTimestamp(),
      });
    }

    // 다음 선수 선택
    let nextGroup = curGroup;
    let nextId = getNextPlayerId(nextGroup);

    if(!nextId && curGroup==="A"){
      nextGroup="B";
      nextId=getNextPlayerId("B");
    }

    if(!nextId){
      // 끝
      tx.update(roomRef,{
        status:"finished",
        currentPlayerId:null,
        currentGroup: nextGroup,
        highestBid:0,
        highestBidderId:null,
        highestBidderName:null,
        endsAtMs:null,
        finalizing:false,
        announcement: r.announcement || "경매 종료",
      });
      return;
    }

    tx.update(roomRef,{
      status:"running",
      currentGroup: nextGroup,
      phase: nextGroup,
      currentPlayerId: nextId,
      highestBid:0,
      highestBidderId:null,
      highestBidderName:null,
      endsAtMs: Date.now() + AUCTION_SECONDS*1000,
      finalizing:false,
      announcement: reason==="timeout" ? "유찰 → 다음 선수" : "낙찰 완료!",
    });
  });
}

// ====== BID ======
async function placeBid(){
  const bidInput = el("bidInput");
  if(!bidInput) return;

  const amount = Number(bidInput.value);
  if(!amount || amount<=0){
    alert("입찰 금액을 입력해줘.");
    return;
  }
  if(amount % BID_STEP !== 0){
    alert(`입찰은 ${BID_STEP}점 단위만 가능해.`);
    return;
  }

  const teamId = myTeamId();
  if(!teamId){
    alert("팀장만 입찰할 수 있어.");
    return;
  }

  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    if(!roomSnap.exists()) throw new Error("room missing");
    const r = roomSnap.data();
    const curId = r.currentPlayerId;
    if(!curId) throw new Error("no current player");

    const curRef = doc(playersCol, curId);
    const curSnap = await tx.get(curRef);
    if(!curSnap.exists()) throw new Error("player missing");
    const cur = curSnap.data();
    const g = normGroup(cur.group);

    const minBid = MIN_BID_BY_GROUP[g] ?? 0;
    if(amount < minBid){
      throw new Error(`GROUP ${g}는 최소 ${minBid}점부터 입찰 가능`);
    }

    const highest = r.highestBid ?? 0;
    if(amount < highest + BID_STEP){
      throw new Error(`현재 최고가(${highest})보다 최소 ${BID_STEP}점 이상 높아야 함`);
    }

    const teamRef = doc(teamsCol, teamId);
    const teamSnap = await tx.get(teamRef);
    if(!teamSnap.exists()) throw new Error("team missing");
    const t = teamSnap.data();
    const remain = t.pointsRemaining ?? t.points ?? TEAM_START_POINTS;
    if(amount > remain){
      throw new Error("팀 잔여 포인트가 부족해.");
    }

    // 최고가 갱신
    tx.update(roomRef,{
      highestBid: amount,
      highestBidderId: teamId,
      highestBidderName: t.name || teamId,
      lastBidAtMs: Date.now(),
    });

    // 로그 기록(트랜잭션 안에서 doc()로 자동ID 생성)
    const logRef = doc(logsCol);
    tx.set(logRef,{
      createdAt: serverTimestamp(),
      teamId,
      teamName: t.name || teamId,
      playerId: curId,
      playerName: cur.name || curId,
      amount,
      group: g,
    });
  });

  bidInput.value = "";
}

// ====== RESET ======
async function resetAll(){
  if(!isOperator()) return;

  const batch = writeBatch(db);

  // room reset
  batch.update(roomRef,{
    status:"waiting",
    currentGroup:"A",
    phase:"A",
    currentPlayerId:null,
    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,
    endsAtMs:null,
    announcement:"전체 리셋 완료",
    finalizing:false,
  });

  // players reset
  const pSnap = await getDocs(playersCol);
  pSnap.forEach(d=>{
    batch.update(d.ref,{
      status:"available",
      assignedTeamId:null,
      finalPrice:0,
      updatedAt: serverTimestamp(),
    });
  });

  // teams reset
  const tSnap = await getDocs(teamsCol);
  tSnap.forEach(d=>{
    batch.update(d.ref,{
      pointsRemaining: TEAM_START_POINTS,
    });
  });

  await batch.commit();

  // logs delete (별도 배치)
  const lSnap = await getDocs(logsCol);
  const delBatch = writeBatch(db);
  lSnap.forEach(d=> delBatch.delete(d.ref));
  await delBatch.commit();
}

async function resetPointsOnly(){
  if(!isOperator()) return;
  const tSnap = await getDocs(teamsCol);
  const batch = writeBatch(db);
  tSnap.forEach(d=>{
    batch.update(d.ref,{ pointsRemaining: TEAM_START_POINTS });
  });
  batch.update(roomRef,{ announcement:"포인트 리셋 완료" });
  await batch.commit();
}

// ====== EVENTS ======
function bindEvents(){
  const roleSel = el("roleSelect");
  if(roleSel){
    roleSel.addEventListener("change", ()=>{
      myRole = roleSel.value;
    });
    myRole = roleSel.value;
  }

  const bidBtn = el("bidBtn");
  if(bidBtn) bidBtn.addEventListener("click", placeBid);

  const bidInput = el("bidInput");
  if(bidInput){
    bidInput.addEventListener("keydown",(e)=>{
      if(e.key==="Enter") placeBid();
    });
  }

  const btnMain = el("btnMainStart");
  if(btnMain) btnMain.addEventListener("click", startMainAuction);

  const btnFinalize = el("btnFinalize");
  if(btnFinalize) btnFinalize.addEventListener("click", ()=>finalizeCurrentAuction("sold"));

  const btnResetAll = el("btnResetAll");
  if(btnResetAll) btnResetAll.addEventListener("click", resetAll);

  const btnResetPts = el("btnResetPoints");
  if(btnResetPts) btnResetPts.addEventListener("click", resetPointsOnly);
}
bindEvents();
