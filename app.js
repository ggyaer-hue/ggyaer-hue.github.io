// app.js (SELF-CONTAINED, ROOM1 FINAL, GROUP A/B only)
// ----------------------------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  collection, doc, getDoc, getDocs, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// ====== Firebase Config (네가 준 값 그대로) ======
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
const db = getFirestore(app);

console.log("[app.js] loaded OK");

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;
const BID_STEP = 5;
const TEAM_START_POINTS = 1000;
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
let players = [];
let teams = [];
let myRole = "viewer";
let tickTimer = null;

// ====== NORMALIZE ======
const normGroup = (g) => String(g || "A").trim().toUpperCase();
const normStatus= (s) => String(s || "available").trim().toLowerCase();
const isOperator = () => myRole === "operator";
const myTeamId = () => (myRole.startsWith("leader") ? myRole : null);

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

// logs
onSnapshot(query(logsCol, orderBy("createdAt","asc")), (snap)=>{
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

// ====== RENDER ======
function renderAll(){
  renderCurrent();
  renderGroups();
  renderTeams();
  renderStatus();
}

function renderStatus(){
  if(!roomState) return;
  text("roomTitle", roomState.title || "ROOM1");
  text("phaseLabel", roomState.currentGroup ? `GROUP ${roomState.currentGroup}` : "");

  const annBox = el("announcementBox") || el("announcement");
  if(annBox){
    const ann = roomState.announcement;
    if(ann){
      annBox.textContent = ann;
      annBox.style.display="";
      setTimeout(()=> annBox.style.display="none", 3000);
    }else{
      annBox.style.display="none";
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
    img.src = cur?.photoUrl || "";
    img.alt = cur?.name || "current player";
  }

  text("highestBid", roomState.highestBid ?? 0);
  text("highestBidder", roomState.highestBidderName || "-");

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
  const groupB = avail.filter(p => normGroup(p.group)==="B");

  if(aBox) groupA.forEach(p => aBox.appendChild(playerCard(p)));
  if(bBox) groupB.forEach(p => bBox.appendChild(playerCard(p)));
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

  card.addEventListener("click", () => {
    if(!isOperator()) return;
    pickPlayerAsCurrent(p.id);
  });

  return card;
}

function renderTeams(){
  const sold = players.filter(p => normStatus(p.status)==="sold" && p.assignedTeamId);
  const soldByTeam = {};
  sold.forEach(p => {
    if(!soldByTeam[p.assignedTeamId]) soldByTeam[p.assignedTeamId] = [];
    soldByTeam[p.assignedTeamId].push(p);
  });

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

// ====== TIMER ======
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
    if(leftSec<=0 && isOperator()){
      finalizeCurrentAuction("timeout").catch(console.error);
    }
  }, 250);
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
    currentGroup: normGroup(players.find(p=>p.id===pid)?.group || "A"),
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

    tx.update(roomRef,{finalizing:true});

    if(highestBid>0 && bidderId){
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
      tx.update(curRef,{
        status:"unsold",
        assignedTeamId:null,
        finalPrice:0,
        updatedAt: serverTimestamp(),
      });
    }

    let nextGroup = curGroup;
    let nextId = getNextPlayerId(nextGroup);

    if(!nextId && curGroup==="A"){
      nextGroup="B";
      nextId=getNextPlayerId("B");
    }

    if(!nextId){
      tx.update(roomRef,{
        status:"finished",
        currentPlayerId:null,
        currentGroup: nextGroup,
        highestBid:0,
        highestBidderId:null,
        highestBidderName:null,
        endsAtMs:null,
        finalizing:false,
        announcement: "경매 종료",
      });
      return;
    }

    tx.update(roomRef,{
      status:"running",
      currentGroup: nextGroup,
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
  if(!amount || amount<=0) return alert("입찰 금액을 입력해줘.");
  if(amount % BID_STEP !== 0) return alert(`입찰은 ${BID_STEP}점 단위만 가능해.`);

  const teamId = myTeamId();
  if(!teamId) return alert("팀장만 입찰 가능.");

  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    const r = roomSnap.data();
    const curId = r.currentPlayerId;
    if(!curId) throw new Error("no current player");

    const curRef = doc(playersCol, curId);
    const curSnap = await tx.get(curRef);
    const cur = curSnap.data();

    const g = normGroup(cur.group);
    const minBid = MIN_BID_BY_GROUP[g] ?? 0;
    if(amount < minBid) throw new Error(`GROUP ${g}는 최소 ${minBid}점부터`);

    const highest = r.highestBid ?? 0;
    if(amount < highest + BID_STEP) throw new Error("최소 5점 이상 높여야 함");

    const teamRef = doc(teamsCol, teamId);
    const teamSnap = await tx.get(teamRef);
    const t = teamSnap.data();
    const remain = t.pointsRemaining ?? t.points ?? TEAM_START_POINTS;
    if(amount > remain) throw new Error("잔여 포인트 부족");

    tx.update(roomRef,{
      highestBid: amount,
      highestBidderId: teamId,
      highestBidderName: t.name || teamId,
      lastBidAtMs: Date.now(),
    });

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

  batch.update(roomRef,{
    status:"waiting",
    currentGroup:"A",
    currentPlayerId:null,
    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,
    endsAtMs:null,
    announcement:"전체 리셋 완료",
    finalizing:false,
  });

  const pSnap = await getDocs(playersCol);
  pSnap.forEach(d=>{
    batch.update(d.ref,{
      status:"available",
      assignedTeamId:null,
      finalPrice:0,
      updatedAt: serverTimestamp(),
    });
  });

  const tSnap = await getDocs(teamsCol);
  tSnap.forEach(d=>{
    batch.update(d.ref,{ pointsRemaining: TEAM_START_POINTS });
  });

  await batch.commit();

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
    roleSel.addEventListener("change", ()=>{ myRole = roleSel.value; });
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
