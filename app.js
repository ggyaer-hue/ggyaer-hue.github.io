// app.js (ROOM1 FINAL, matches new index.html)
// -------------------------------------------
import { app, db } from "./firebase-config.js";
import {
  collection, doc, getDocs, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

console.log("[app.js] loaded OK", app?.name);

// ====== CONSTANTS ======
const ROOM_ID = "room1";
const AUCTION_SECONDS = 15;
const BID_STEP = 5;
const TEAM_START_POINTS = 1000;
const MIN_BID_BY_GROUP = { A: 300, B: 0 };

const LEADERS = ["leader1","leader2","leader3","leader4"];

// ====== FIRESTORE REFS ======
const roomRef = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol   = collection(db, "rooms", ROOM_ID, "teams");
const logsCol    = collection(db, "rooms", ROOM_ID, "logs");

// ====== DOM HELPERS ======
const el = (id) => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);
const text = (id, v) => { const n = el(id); if(n) n.textContent = v ?? ""; };
const html = (id, v) => { const n = el(id); if(n) n.innerHTML = v ?? ""; };

// index.html IDs
const $ = {
  roleSelect: el("role-select"),
  adminControls: el("admin-controls"),
  btnStartTest: el("btn-start-test"),
  btnStartReal: el("btn-start-real"),
  btnStartRemaining: el("btn-start-remaining"),
  btnReset: el("btn-reset"),

  // top
  statusDot: el("room-status-dot"),
  statusText: el("room-status-text"),
  modeBadge: el("mode-badge"),

  // current
  curPhoto: el("current-player-photo"),
  curName: el("current-player-name"),
  curRole: el("current-player-role"),
  curGroup: el("current-player-group"),
  curBase: el("current-player-base"),
  curBio: el("current-player-bio"),
  curStatusBadge: el("current-player-status"),

  bidAmount: el("bid-amount"),
  bidBtn: el("bid-button"),

  highestAmount: el("highest-amount"),
  highestLeader: el("highest-leader"),

  timerPlayerName: el("timer-player-name"),
  timer: el("timer"),
  bidLog: el("bid-log"),

  // overlay
  overlay: el("auction-overlay"),
  overlayTeam: el("auction-overlay-team"),
  overlayPhoto: el("auction-overlay-photo"),
  overlayName: el("auction-overlay-name"),
  overlayPrice: el("auction-overlay-price"),

  // teams containers
  teamBox: {
    leader1: el("team-leader1"),
    leader2: el("team-leader2"),
    leader3: el("team-leader3"),
    leader4: el("team-leader4"),
  },

  // group rosters
  rosterA: el("roster-A"),
  rosterB: el("roster-B"),
};

// ====== STATE ======
let roomState = null;
let prevRoomState = null;
let players = [];
let teams = [];
let myRole = "viewer";
let tickTimer = null;

// ====== NORMALIZE / HELPERS ======
const normGroup  = (g) => String(g || "A").trim().toUpperCase();
const normStatus = (s) => String(s || "available").trim().toLowerCase();
const numOrder   = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 9999;
};
const photoOf = (p) => p?.photoUrl || p?.photoURL || p?.imageUrl || p?.image || p?.img || "";

const isOperator = () => myRole === "operator";
const myTeamId   = () => (String(myRole).startsWith("leader") ? myRole : null);

// 팀 색상(overlay 등)
const teamColorVar = (leaderKey) => `var(--c-${leaderKey})`;

// teams 컬렉션 doc을 leader1~4로 매핑
function leaderKeyFromTeamDoc(t){
  if(!t) return null;
  const id = String(t.id || "").toLowerCase();
  if(id.startsWith("leader")) return id; // leader1~4
  const m = id.match(/team\s*([1-4])$/) || id.match(/team([1-4])$/);
  if(m) return `leader${m[1]}`;
  const oi = Number(t.orderIndex);
  if(oi>=1 && oi<=4) return `leader${oi}`;
  if(t.leaderId && String(t.leaderId).startsWith("leader")) return String(t.leaderId);
  return null;
}

// 플레이어 assignedTeamId(혹은 bidderId)를 leader1~4로 정규화
function leaderKeyFromAssigned(raw){
  if(!raw) return null;
  const id = String(raw).toLowerCase();
  if(id.startsWith("leader")) return id;
  const m = id.match(/team\s*([1-4])$/) || id.match(/team([1-4])$/);
  if(m) return `leader${m[1]}`;
  return null;
}

// leader별 팀 문서 확보(없으면 placeholder)
function buildLeaderTeamMap(){
  const map = {};
  LEADERS.forEach(k => map[k] = null);

  teams.forEach(t=>{
    const lk = leaderKeyFromTeamDoc(t);
    if(!lk) return;
    // leader 문서가 있으면 우선, 없으면 첫 매핑
    if(!map[lk] || String(t.id).startsWith("leader")) map[lk] = t;
  });

  LEADERS.forEach((lk, idx)=>{
    if(!map[lk]){
      map[lk] = { id: lk, name: `TEAM ${idx+1}`, orderIndex: idx+1, pointsRemaining: TEAM_START_POINTS };
    }
  });
  return map;
}

// ====== LISTENERS ======
onSnapshot(
  roomRef,
  (snap)=>{
    prevRoomState = roomState;
    roomState = snap.exists() ? snap.data() : null;

    // 현재 선수 바뀌는 순간(= 직전 선수 낙찰/유찰) overlay 표시
    maybeShowOverlay(prevRoomState, roomState);

    renderAll();
    syncTick();
  },
  (err)=>console.error("[room snapshot error]", err)
);

// teams: orderBy 제거(타입 섞여도 죽지 않게) + 클라 정렬
onSnapshot(
  teamsCol,
  (snap)=>{
    teams = snap.docs.map(d=>({ id:d.id, ...d.data() }))
      .sort((a,b)=> numOrder(a.orderIndex) - numOrder(b.orderIndex));
    renderTeams();
  },
  (err)=>console.error("[teams snapshot error]", err)
);

// players: orderBy 제거 + 클라 정렬
onSnapshot(
  playersCol,
  (snap)=>{
    players = snap.docs.map(d=>({ id:d.id, ...d.data() }))
      .sort((a,b)=> numOrder(a.orderIndex) - numOrder(b.orderIndex));

    renderGroups();
    renderTeams();
    renderCurrent();
  },
  (err)=>{
    console.error("[players snapshot error]", err);
    alert("players 로딩 에러! 콘솔 확인");
  }
);

// logs
onSnapshot(
  query(logsCol, orderBy("createdAt","asc")),
  (snap)=>{
    if(!$?.bidLog) return;
    $.bidLog.innerHTML = "";
    snap.docs.forEach(d=>{
      const x = d.data();
      const row = document.createElement("div");
      row.className = "item";
      row.textContent = `${x.teamName||x.teamId} - ${x.playerName} : ${x.amount}점`;
      $.bidLog.appendChild(row);
    });
    $.bidLog.scrollTop = $.bidLog.scrollHeight;
  },
  (err)=>console.error("[logs snapshot error]", err)
);

// ====== RENDER ======
function renderAll(){
  renderTop();
  renderCurrent();
  renderGroups();
  renderTeams();
  renderAdminControls();
}

function renderTop(){
  if(!roomState){
    $.statusText && ($.statusText.textContent="대기중");
    $.statusDot && ($.statusDot.className="dot");
    $.modeBadge && ($.modeBadge.textContent="ROOM1 · REAL · A");
    return;
  }

  const st = roomState.status || "waiting";
  if($.statusText){
    $.statusText.textContent =
      st==="running" ? "경매중" :
      st==="finished" ? "종료" :
      "대기중";
  }

  if($.statusDot){
    $.statusDot.className = "dot " + (st==="running" ? "bidding" : st==="finished" ? "finished" : "");
  }

  if($.modeBadge){
    const g = roomState.currentGroup || "A";
    $.modeBadge.textContent = `ROOM1 · REAL · ${g}`;
  }
}

function renderAdminControls(){
  if(!$.adminControls) return;
  $.adminControls.style.display = isOperator() ? "" : "none";
}

function renderCurrent(){
  const r = roomState;
  if(!r){
    text("current-player-name","-");
    text("current-player-role","-");
    text("current-player-group","-");
    text("current-player-base","-");
    text("current-player-bio","-");
    text("highest-amount","-");
    text("highest-leader","-");
    text("current-player-status","-");
    if($.curPhoto) $.curPhoto.src="";
    if($.timerPlayerName) $.timerPlayerName.textContent="-";
    return;
  }

  const cur = players.find(p=>p.id===r.currentPlayerId);

  text("current-player-name", cur?.name || "-");
  text("current-player-role", cur?.role || "-");
  text("current-player-group", normGroup(cur?.group) || "-");
  text("current-player-base", cur?.basePrice ?? 0);
  text("current-player-bio", cur?.bio || cur?.intro || "-");
  text("current-player-status", r.status || "-");

  if($.curPhoto){
    $.curPhoto.src = photoOf(cur);
    $.curPhoto.alt = cur?.name || "current";
  }

  text("highest-amount", r.highestBid ?? 0);
  text("highest-leader", r.highestBidderName || "-");

  if($.timerPlayerName) $.timerPlayerName.textContent = cur?.name || "-";
}

function renderGroups(){
  if(!$.rosterA || !$.rosterB) return;

  $.rosterA.innerHTML = "";
  $.rosterB.innerHTML = "";

  const groupA = players.filter(p=>normGroup(p.group)==="A");
  const groupB = players.filter(p=>normGroup(p.group)==="B");

  groupA.forEach(p=> $.rosterA.appendChild(avatarItem(p)));
  groupB.forEach(p=> $.rosterB.appendChild(avatarItem(p)));
}

function avatarItem(p){
  const wrap = document.createElement("div");
  wrap.className = "avatar";
  wrap.dataset.pid = p.id;

  const img = document.createElement("img");
  img.src = photoOf(p);
  img.alt = p.name || p.id;

  const name = document.createElement("div");
  name.className = "name-tip";
  name.textContent = p.name || p.id;

  const st = normStatus(p.status);
  if(roomState?.currentPlayerId === p.id){
    wrap.classList.add("current");
  }
  if(st==="sold" || st==="unsold"){
    wrap.classList.add("sold");
  }

  const lk = leaderKeyFromAssigned(p.assignedTeamId);
  if(lk){
    wrap.classList.add(`sold-by-${lk}`);
  }

  // 운영자만 클릭으로 현재 선수 지정
  wrap.addEventListener("click", ()=>{
    if(!isOperator()) return;
    pickPlayerAsCurrent(p.id);
  });

  wrap.appendChild(img);
  wrap.appendChild(name);
  return wrap;
}

function renderTeams(){
  const leaderTeams = buildLeaderTeamMap();

  // sold players -> leaderKey 기준으로 묶기
  const sold = players.filter(p=>normStatus(p.status)==="sold" && p.assignedTeamId);
  const soldByLeader = { leader1:[], leader2:[], leader3:[], leader4:[] };
  sold.forEach(p=>{
    const lk = leaderKeyFromAssigned(p.assignedTeamId) || p.assignedTeamId;
    if(soldByLeader[lk]) soldByLeader[lk].push(p);
  });

  LEADERS.forEach((lk, idx)=>{
    const box = $.teamBox[lk];
    if(!box) return;

    const t = leaderTeams[lk];
    const roster = (soldByLeader[lk] || [])
      .sort((a,b)=> numOrder(a.orderIndex) - numOrder(b.orderIndex));

    // 팀 카드 내부 HTML 생성
    box.classList.add(`team-${lk}`);
    box.innerHTML = `
      <div class="team-header">
        <div class="team-name">
          <span>${t.name || `TEAM ${idx+1}`}</span>
        </div>
        <div class="team-points" id="points-${lk}">
          ${(t.pointsRemaining ?? t.points ?? TEAM_START_POINTS)} / ${TEAM_START_POINTS}
        </div>
      </div>
      <div class="team-row">
        ${["TOP","JGL","MID","BOT","SUP"].map((pos, sIdx)=>{
          const p = roster[sIdx];
          if(!p){
            return `
              <div class="slot empty">
                <div class="slot-label">${pos}</div>
              </div>
            `;
          }
          return `
            <div class="slot">
              <div class="slot-label">${pos}</div>
              <img src="${photoOf(p)}" alt="${p.name}">
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

// ====== TIMER ======
function syncTick(){
  if(tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(()=>{
    if(!roomState?.endsAtMs){
      if($.timer) $.timer.textContent = "-";
      return;
    }
    const leftMs = roomState.endsAtMs - Date.now();
    const leftSec = Math.max(0, Math.ceil(leftMs/1000));
    if($.timer) $.timer.textContent = leftSec;

    if(leftSec<=0 && isOperator()){
      finalizeCurrentAuction("timeout").catch(console.error);
    }
  }, 250);
}

// ====== AUCTION FLOW ======
function getNextPlayerId(group, excludeId=null){
  const g = normGroup(group);
  const avail = players
    .filter(p=>p.id!==excludeId)
    .filter(p=>normStatus(p.status)==="available" && normGroup(p.group)===g)
    .sort((a,b)=> numOrder(a.orderIndex)-numOrder(b.orderIndex));
  return avail[0]?.id || null;
}

async function pickPlayerAsCurrent(pid){
  if(!isOperator()) return;
  const p = players.find(x=>x.id===pid);
  await updateDoc(roomRef,{
    currentPlayerId: pid,
    highestBid: 0,
    highestBidderId: null,
    highestBidderName: null,
    endsAtMs: Date.now() + AUCTION_SECONDS*1000,
    status: "running",
    currentGroup: normGroup(p?.group || "A"),
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

// "잔여 재경매" 버튼용 간단 스타트
async function startRemainingAuction(){
  if(!isOperator()) return;
  let g = roomState?.currentGroup || "A";
  let pid = getNextPlayerId(g);
  if(!pid && g==="A"){ g="B"; pid=getNextPlayerId("B"); }
  if(!pid){
    alert("남은 선수가 없습니다.");
    return;
  }
  await updateDoc(roomRef,{
    status:"running",
    currentGroup:g,
    currentPlayerId:pid,
    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,
    endsAtMs: Date.now() + AUCTION_SECONDS*1000,
    announcement:"잔여 재경매 시작!",
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
        assignedTeamId: bidderId,      // ✅ leader1~4 저장
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

    // ✅ 다음 선수 선택 (curId 제외)
    let nextGroup = curGroup;
    let nextId = getNextPlayerId(nextGroup, curId);

    if(!nextId && curGroup==="A"){
      nextGroup="B";
      nextId=getNextPlayerId("B", curId);
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
  if(!$.bidAmount) return;
  const amount = Number($.bidAmount.value);
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
    if(amount < highest + BID_STEP) throw new Error(`최소 ${BID_STEP}점 이상 높여야 함`);

    const teamRef = doc(teamsCol, teamId);
    const teamSnap = await tx.get(teamRef);
    const t = teamSnap.exists() ? teamSnap.data() : {};
    const remain = t.pointsRemaining ?? t.points ?? TEAM_START_POINTS;
    if(amount > remain) throw new Error("잔여 포인트 부족");

    tx.update(roomRef,{
      highestBid: amount,
      highestBidderId: teamId,                 // ✅ leader1~4
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

  $.bidAmount.value = "";
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

// ====== OVERLAY ======
function maybeShowOverlay(prev, cur){
  if(!prev || !cur) return;
  if(prev.currentPlayerId && prev.currentPlayerId !== cur.currentPlayerId){
    const soldPlayer = players.find(p=>p.id===prev.currentPlayerId);
    if(!soldPlayer) return;

    const price = prev.highestBid ?? 0;
    const leaderKey = leaderKeyFromAssigned(prev.highestBidderId);
    const teamName = prev.highestBidderName || prev.highestBidderId || "유찰";

    showOverlay({
      leaderKey,
      teamName,
      player: soldPlayer,
      price,
      sold: price>0 && leaderKey
    });
  }
}

function showOverlay({leaderKey, teamName, player, price, sold}){
  if(!$.overlay) return;

  $.overlayTeam.textContent = sold ? teamName : "유찰";
  $.overlayName.textContent = player?.name || "-";
  $.overlayPrice.textContent = sold ? `${price}점 낙찰` : "유찰";
  $.overlayPhoto.src = photoOf(player);

  // 색상
  $.overlayTeam.style.color = leaderKey ? teamColorVar(leaderKey) : "#cbd7f7";
  $.overlayPhoto.style.borderColor = leaderKey ? teamColorVar(leaderKey) : "#cbd7f7";

  $.overlay.classList.remove("show");
  void $.overlay.offsetWidth; // reflow
  $.overlay.classList.add("show");
}

// ====== EVENTS ======
function bindEvents(){
  // role
  if($.roleSelect){
    $.roleSelect.addEventListener("change", ()=>{
      myRole = $.roleSelect.value;
      renderAdminControls();
      console.log("[role]", myRole);
    });
    myRole = $.roleSelect.value;
  }

  // bid
  $.bidBtn && $.bidBtn.addEventListener("click", placeBid);
  $.bidAmount && $.bidAmount.addEventListener("keydown",(e)=>{
    if(e.key==="Enter") placeBid();
  });

  // admin
  $.btnStartReal && $.btnStartReal.addEventListener("click", startMainAuction);
  $.btnStartTest && $.btnStartTest.addEventListener("click", startMainAuction);
  $.btnStartRemaining && $.btnStartRemaining.addEventListener("click", startRemainingAuction);
  $.btnReset && $.btnReset.addEventListener("click", resetAll);
}

bindEvents();
