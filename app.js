// app.js (ROOM1 FINAL FIXED: schema-robust + role-independent finalize)
// -------------------------------------------------------------------
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
const CANON_TEAMS = ["team1","team2","team3","team4"]; // 정규 팀 키(역할 무관)

// ====== FIRESTORE REFS ======
const roomRef    = doc(db, "rooms", ROOM_ID);
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const teamsCol   = collection(db, "rooms", ROOM_ID, "teams");
const logsCol    = collection(db, "rooms", ROOM_ID, "logs");

// ====== DOM ======
const el = (id)=>document.getElementById(id);
const text = (id,v)=>{ const n=el(id); if(n) n.textContent=v??""; };

// index.html ids
const $ = {
  roleSelect: el("role-select"),
  adminControls: el("admin-controls"),
  btnStartTest: el("btn-start-test"),
  btnStartReal: el("btn-start-real"),
  btnStartRemaining: el("btn-start-remaining"),
  btnReset: el("btn-reset"),

  statusDot: el("room-status-dot"),
  statusText: el("room-status-text"),
  modeBadge: el("mode-badge"),

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

  overlay: el("auction-overlay"),
  overlayTeam: el("auction-overlay-team"),
  overlayPhoto: el("auction-overlay-photo"),
  overlayName: el("auction-overlay-name"),
  overlayPrice: el("auction-overlay-price"),

  teamBox: {
    team1: el("team-leader1"),
    team2: el("team-leader2"),
    team3: el("team-leader3"),
    team4: el("team-leader4"),
  },

  rosterA: el("roster-A"),
  rosterB: el("roster-B"),
};

// ====== STATE ======
let roomState = null, prevRoomState = null;
let players = [];
let teams = [];
let myRole = "viewer";
let tickTimer = null;

// timeout 중복 방지
let timeoutFiredForEndsAt = null;

// ====== HELPERS ======
const normGroup  = (g)=>String(g||"A").trim().toUpperCase();
const normStatus = (s)=>String(s||"available").trim().toLowerCase();
const numOrder   = (v)=>Number.isFinite(Number(v))?Number(v):9999;
const photoOf    = (p)=>p?.photoUrl||p?.photoURL||p?.imageUrl||p?.image||p?.img||"";

const isOperator = ()=>myRole==="operator";
const myTeamId   = ()=>String(myRole).startsWith("leader")?myRole:null;

// ✅ room의 endsAt 필드명/단위가 뭐든 ms로 정규화
function getEndsAtMs(r){
  if(!r) return null;
  let v =
    r.endsAtMs ??
    r.endsAt ??
    r.endsAtS ??
    r.endsAtSec ??
    null;
  if(v == null) return null;
  const n = Number(v);
  if(!Number.isFinite(n)) return null;
  // 1e12보다 작으면 "초 단위"로 보고 ms로 변환
  return n < 1e12 ? n*1000 : n;
}

// anyId -> teamN 파싱 (leader/role 무시)
function canonicalKeyFromAnyId(anyId){
  if(!anyId) return null;
  const s = String(anyId).toLowerCase();
  const m = s.match(/([1-4])$/); // leader1/team2/"3" -> team3
  if(m) return `team${m[1]}`;
  return null;
}

// teams snapshot -> canonical(team1~4) 맵
function buildTeamMaps(){
  const byDocId = new Map();
  const byCanon = new Map();

  teams.forEach(t=>{
    byDocId.set(t.id, t);

    const oi = Number(t.orderIndex);
    if(oi>=1 && oi<=4){
      byCanon.set(`team${oi}`, t);
      return;
    }
    const c = canonicalKeyFromAnyId(t.id);
    if(c && !byCanon.has(c)) byCanon.set(c, t);
  });

  return { byDocId, byCanon };
}

function resolveBidderToTeam(bidderId){
  const { byDocId, byCanon } = buildTeamMaps();

  if(byDocId.has(bidderId)){
    const t = byDocId.get(bidderId);
    const oi = Number(t.orderIndex);
    const canon = (oi>=1 && oi<=4) ? `team${oi}` : canonicalKeyFromAnyId(t.id);
    return { canonKey: canon, docId: t.id };
  }

  const parsedCanon = canonicalKeyFromAnyId(bidderId);
  if(parsedCanon){
    const t = byCanon.get(parsedCanon);
    return { canonKey: parsedCanon, docId: t?.id || null };
  }

  return { canonKey: null, docId: null };
}

// ====== LISTENERS ======
onSnapshot(roomRef, (snap)=>{
  prevRoomState = roomState;
  roomState = snap.exists()?snap.data():null;

  const endsMs = getEndsAtMs(roomState);
  if(endsMs && endsMs !== timeoutFiredForEndsAt){
    timeoutFiredForEndsAt = null; // 새 라운드
  }

  maybeShowOverlay(prevRoomState, roomState);
  renderAll();
  syncTick();
});

onSnapshot(teamsCol, (snap)=>{
  teams = snap.docs.map(d=>({id:d.id, ...d.data()}))
    .sort((a,b)=>numOrder(a.orderIndex)-numOrder(b.orderIndex));
  renderTeams();
});

onSnapshot(playersCol, (snap)=>{
  players = snap.docs.map(d=>({id:d.id, ...d.data()}))
    .sort((a,b)=>numOrder(a.orderIndex)-numOrder(b.orderIndex));
  renderGroups();
  renderTeams();
  renderCurrent();
});

onSnapshot(query(logsCol, orderBy("createdAt","asc")), (snap)=>{
  if(!$?.bidLog) return;
  $.bidLog.innerHTML="";
  snap.docs.forEach(d=>{
    const x=d.data();
    const row=document.createElement("div");
    row.className="item";
    row.textContent=`${x.teamName||x.teamId} - ${x.playerName} : ${x.amount}점`;
    $.bidLog.appendChild(row);
  });
  $.bidLog.scrollTop=$.bidLog.scrollHeight;
});

// ====== RENDER ======
function renderAll(){
  renderTop();
  renderCurrent();
  renderGroups();
  renderTeams();
  renderAdminControls();
}

function renderTop(){
  if(!roomState) return;
  const st=roomState.status||"running"; // status 없으면 running으로 취급
  if($.statusText){
    $.statusText.textContent = st==="running"?"경매중":st==="finished"?"종료":"대기중";
  }
  if($.statusDot){
    $.statusDot.className="dot "+(st==="running"?"bidding":st==="finished"?"finished":"");
  }
  if($.modeBadge){
    $.modeBadge.textContent=`ROOM1 · REAL · ${roomState.currentGroup||roomState.group||roomState.phase||"A"}`;
  }
}
function renderAdminControls(){
  if($.adminControls) $.adminControls.style.display=isOperator()?"":"none";
}

function renderCurrent(){
  if(!roomState){
    text("current-player-name","-");
    text("current-player-role","-");
    text("current-player-group","-");
    text("current-player-base","-");
    text("current-player-bio","-");
    text("highest-amount","-");
    text("highest-leader","-");
    if($.curPhoto) $.curPhoto.src="";
    if($.timerPlayerName) $.timerPlayerName.textContent="-";
    return;
  }
  const cur=players.find(p=>p.id===roomState.currentPlayerId);

  text("current-player-name",cur?.name||"-");
  text("current-player-role",cur?.role||"-");
  text("current-player-group",normGroup(cur?.group)||"-");
  text("current-player-base",cur?.basePrice??0);
  text("current-player-bio",cur?.bio||cur?.intro||"-");
  text("current-player-status",roomState.status||roomState.phase||"-");

  if($.curPhoto){
    $.curPhoto.src=photoOf(cur);
    $.curPhoto.alt=cur?.name||"current";
  }
  text("highest-amount",roomState.highestBid??0);
  text("highest-leader",roomState.highestBidderName||roomState.highestBidderId||"-");
  if($.timerPlayerName) $.timerPlayerName.textContent=cur?.name||"-";
}

function renderGroups(){
  if(!$.rosterA||!$.rosterB) return;
  $.rosterA.innerHTML="";
  $.rosterB.innerHTML="";

  const A=players.filter(p=>normGroup(p.group)==="A");
  const B=players.filter(p=>normGroup(p.group)==="B");
  A.forEach(p=>$.rosterA.appendChild(avatarItem(p)));
  B.forEach(p=>$.rosterB.appendChild(avatarItem(p)));
}

function avatarItem(p){
  const wrap=document.createElement("div");
  wrap.className="avatar";

  const img=document.createElement("img");
  img.src=photoOf(p);

  const name=document.createElement("div");
  name.className="name-tip";
  name.textContent=p.name||p.id;

  const st=normStatus(p.status);
  if(roomState?.currentPlayerId===p.id) wrap.classList.add("current");
  if(st==="sold"||st==="unsold") wrap.classList.add("sold");

  const canon = p.assignedTeamKey || canonicalKeyFromAnyId(p.assignedTeamId);
  if(canon){
    const leaderClass = canon.replace("team","leader");
    wrap.classList.add(`sold-by-${leaderClass}`);
  }

  wrap.addEventListener("click", ()=>{
    if(!isOperator()) return;
    pickPlayerAsCurrent(p.id);
  });

  wrap.appendChild(img);
  wrap.appendChild(name);
  return wrap;
}

function renderTeams(){
  const soldPlayers=players.filter(p=>normStatus(p.status)==="sold");

  const buckets={team1:[],team2:[],team3:[],team4:[]};
  soldPlayers.forEach(p=>{
    const canon = p.assignedTeamKey || canonicalKeyFromAnyId(p.assignedTeamId);
    if(canon && buckets[canon]) buckets[canon].push(p);
  });

  CANON_TEAMS.forEach((canon, idx)=>{
    const box=$.teamBox[canon];
    if(!box) return;

    const { byCanon } = buildTeamMaps();
    const t = byCanon.get(canon) || { name:`TEAM ${idx+1}`, pointsRemaining:TEAM_START_POINTS };

    const roster=buckets[canon]
      .sort((a,b)=>numOrder(a.orderIndex)-numOrder(b.orderIndex));

    box.innerHTML=`
      <div class="team-header">
        <div class="team-name"><span>${t.name||`TEAM ${idx+1}`}</span></div>
        <div class="team-points">${(t.pointsRemaining??t.points??TEAM_START_POINTS)} / ${TEAM_START_POINTS}</div>
      </div>
      <div class="team-row">
        ${["TOP","JGL","MID","BOT","SUP"].map((pos,i)=>{
          const p=roster[i];
          if(!p){
            return `<div class="slot empty"><div class="slot-label">${pos}</div></div>`;
          }
          return `
            <div class="slot">
              <div class="slot-label">${pos}</div>
              <img src="${photoOf(p)}" alt="${p.name}">
              <div class="slot-text">
                <div class="slot-name">${p.name}</div>
                <div class="slot-price">${p.finalPrice??0}점</div>
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
  tickTimer=setInterval(()=>{
    const endsMs = getEndsAtMs(roomState);
    if(!endsMs){
      if($.timer) $.timer.textContent="-";
      return;
    }

    const leftMs=endsMs-Date.now();
    const leftSec=Math.max(0,Math.ceil(leftMs/1000));
    if($.timer) $.timer.textContent=leftSec;

    // ✅ 운영자/관전자 상관없이 타임아웃이면 finalize 시도
    if(leftSec<=0 && timeoutFiredForEndsAt !== endsMs){
      timeoutFiredForEndsAt = endsMs;
      finalizeCurrentAuction("timeout").catch(console.error);
    }
  },250);
}

// ====== AUCTION FLOW ======
function getNextPlayerId(group, excludeId=null){
  const g=normGroup(group);
  const avail=players
    .filter(p=>p.id!==excludeId)
    .filter(p=>normStatus(p.status)==="available" && normGroup(p.group)===g)
    .sort((a,b)=>numOrder(a.orderIndex)-numOrder(b.orderIndex));
  return avail[0]?.id||null;
}

async function pickPlayerAsCurrent(pid){
  if(!isOperator()) return;
  const p=players.find(x=>x.id===pid);
  const g = normGroup(p?.group||"A");

  await updateDoc(roomRef,{
    currentPlayerId:pid,
    currentPlayerId:pid,           // 혹시 쓰는 스키마 대비 중복
    currentGroup:g,
    group:g,
    phase:g,

    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,

    endsAtMs:Date.now()+AUCTION_SECONDS*1000,
    status:"running",
    finalizing:false,
    announcement:null,
  });
}

async function startMainAuction(){
  if(!isOperator()) return;
  const firstA=getNextPlayerId("A");
  if(!firstA) return alert("GROUP A에 남은 선수가 없습니다.");

  await updateDoc(roomRef,{
    status:"running",
    currentGroup:"A",
    group:"A",
    phase:"A",
    currentPlayerId:firstA,

    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,

    endsAtMs:Date.now()+AUCTION_SECONDS*1000,
    announcement:"본경매 시작!",
    finalizing:false
  });
}

async function startRemainingAuction(){
  if(!isOperator()) return;
  let g=roomState?.currentGroup||roomState?.group||roomState?.phase||"A";
  let pid=getNextPlayerId(g);
  if(!pid && g==="A"){ g="B"; pid=getNextPlayerId("B"); }
  if(!pid) return alert("남은 선수가 없습니다.");

  await updateDoc(roomRef,{
    status:"running",
    currentGroup:g,
    group:g,
    phase:g,
    currentPlayerId:pid,

    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,

    endsAtMs:Date.now()+AUCTION_SECONDS*1000,
    announcement:"잔여 재경매 시작!",
    finalizing:false
  });
}

async function finalizeCurrentAuction(reason="sold"){
  await runTransaction(db, async (tx)=>{
    const roomSnap=await tx.get(roomRef);
    if(!roomSnap.exists()) throw new Error("room missing");
    const r=roomSnap.data();

    // ✅ status가 뭐든 상관없이 finalizing만 막음
    if(r.finalizing) return;

    const curId=r.currentPlayerId;
    if(!curId){ tx.update(roomRef,{finalizing:false}); return; }

    const curRef=doc(playersCol,curId);
    const curSnap=await tx.get(curRef);
    if(!curSnap.exists()){
      tx.update(roomRef,{currentPlayerId:null,finalizing:false});
      return;
    }

    const cur=curSnap.data();
    const curGroup=normGroup(cur.group);

    const highestBid=r.highestBid??0;
    const bidderId=r.highestBidderId||null;

    tx.update(roomRef,{finalizing:true});

    if(highestBid>0 && bidderId){
      const { canonKey, docId } = resolveBidderToTeam(bidderId);
      const assignedId = docId || bidderId;

      tx.update(curRef,{
        status:"sold",
        assignedTeamId: assignedId,
        assignedTeamKey: canonKey,   // team1~4 렌더 고정키
        soldBy: assignedId,          // 기존 스키마 대비
        soldAtMs: Date.now(),
        finalPrice: highestBid,
        updatedAt: serverTimestamp()
      });

      if(docId){
        const teamRef=doc(teamsCol,docId);
        const teamSnap=await tx.get(teamRef);
        if(teamSnap.exists()){
          const t=teamSnap.data();
          const remain=(t.pointsRemaining??t.points??TEAM_START_POINTS)-highestBid;
          tx.update(teamRef,{pointsRemaining:remain});
        }
      }
    }else{
      tx.update(curRef,{
        status:"unsold",
        assignedTeamId:null,
        assignedTeamKey:null,
        soldBy:null,
        soldAtMs: Date.now(),
        finalPrice:0,
        updatedAt: serverTimestamp()
      });
    }

    let nextGroup=curGroup;
    let nextId=getNextPlayerId(nextGroup,curId);
    if(!nextId && curGroup==="A"){
      nextGroup="B";
      nextId=getNextPlayerId("B",curId);
    }

    if(!nextId){
      tx.update(roomRef,{
        status:"finished",
        currentPlayerId:null,
        currentGroup:nextGroup,
        group:nextGroup,
        phase:nextGroup,
        highestBid:0,
        highestBidderId:null,
        highestBidderName:null,
        endsAtMs:null,
        finalizing:false,
        announcement:"경매 종료"
      });
      return;
    }

    tx.update(roomRef,{
      status:"running",
      currentGroup:nextGroup,
      group:nextGroup,
      phase:nextGroup,
      currentPlayerId:nextId,

      highestBid:0,
      highestBidderId:null,
      highestBidderName:null,

      endsAtMs:Date.now()+AUCTION_SECONDS*1000,
      finalizing:false,
      announcement: reason==="timeout" ? "유찰 → 다음 선수" : "낙찰 완료!"
    });
  });
}

// ====== BID ======
async function placeBid(){
  const amount=Number($.bidAmount?.value);
  if(!amount||amount<=0) return alert("입찰 금액을 입력해줘.");
  if(amount%BID_STEP!==0) return alert(`입찰은 ${BID_STEP}점 단위만 가능해.`);

  const teamId=myTeamId();
  if(!teamId) return alert("팀장만 입찰 가능.");

  await runTransaction(db, async (tx)=>{
    const roomSnap=await tx.get(roomRef);
    const r=roomSnap.data();
    const curId=r.currentPlayerId;
    if(!curId) throw new Error("no current player");

    const curRef=doc(playersCol,curId);
    const curSnap=await tx.get(curRef);
    const cur=curSnap.data();

    const g=normGroup(cur.group);
    const minBid=MIN_BID_BY_GROUP[g]??0;
    if(amount<minBid) throw new Error(`GROUP ${g}는 최소 ${minBid}점부터`);

    const highest=r.highestBid??0;
    if(amount<highest+BID_STEP) throw new Error(`최소 ${BID_STEP}점 이상 높여야 함`);

    const { docId } = resolveBidderToTeam(teamId);
    if(docId){
      const teamRef=doc(teamsCol,docId);
      const teamSnap=await tx.get(teamRef);
      const t=teamSnap.exists()?teamSnap.data():{};
      const remain=t.pointsRemaining??t.points??TEAM_START_POINTS;
      if(amount>remain) throw new Error("잔여 포인트 부족");
    }

    tx.update(roomRef,{
      highestBid:amount,
      highestBidderId: teamId,
      highestBidderName: teamId,
      lastBidAtMs:Date.now()
    });

    const logRef=doc(logsCol);
    tx.set(logRef,{
      createdAt:serverTimestamp(),
      teamId:teamId,
      teamName:teamId,
      playerId:curId,
      playerName:cur.name||curId,
      amount,
      group:g
    });
  });

  $.bidAmount.value="";
}

// ====== RESET ======
async function resetAll(){
  if(!isOperator()) return;

  const batch=writeBatch(db);

  batch.update(roomRef,{
    status:"waiting",
    currentGroup:"A",
    group:"A",
    phase:"A",
    currentPlayerId:null,

    highestBid:0,
    highestBidderId:null,
    highestBidderName:null,

    endsAtMs:null,
    announcement:"전체 리셋 완료",
    finalizing:false
  });

  const pSnap=await getDocs(playersCol);
  pSnap.forEach(d=>{
    batch.update(d.ref,{
      status:"available",
      assignedTeamId:null,
      assignedTeamKey:null,
      soldBy:null,
      soldAtMs:null,
      finalPrice:0,
      updatedAt:serverTimestamp()
    });
  });

  const tSnap=await getDocs(teamsCol);
  tSnap.forEach(d=>batch.update(d.ref,{pointsRemaining:TEAM_START_POINTS}));

  await batch.commit();

  const lSnap=await getDocs(logsCol);
  const delBatch=writeBatch(db);
  lSnap.forEach(d=>delBatch.delete(d.ref));
  await delBatch.commit();
}

// ====== OVERLAY ======
function maybeShowOverlay(prev, cur){
  if(!prev||!cur) return;
  if(prev.currentPlayerId && prev.currentPlayerId!==cur.currentPlayerId){
    const soldPlayer=players.find(p=>p.id===prev.currentPlayerId);
    if(!soldPlayer) return;

    const price=prev.highestBid??0;
    const { canonKey } = resolveBidderToTeam(prev.highestBidderId);
    const leaderClass = canonKey ? canonKey.replace("team","leader") : null;
    const teamName=prev.highestBidderName||prev.highestBidderId||"유찰";

    showOverlay({leaderClass, teamName, player:soldPlayer, price, sold:price>0});
  }
}
function showOverlay({leaderClass, teamName, player, price, sold}){
  if(!$.overlay) return;

  $.overlayTeam.textContent = sold ? teamName : "유찰";
  $.overlayName.textContent = player?.name || "-";
  $.overlayPrice.textContent = sold ? `${price}점 낙찰` : "유찰";
  $.overlayPhoto.src = photoOf(player);

  $.overlayTeam.style.color = leaderClass ? `var(--c-${leaderClass})` : "#cbd7f7";
  $.overlayPhoto.style.borderColor = leaderClass ? `var(--c-${leaderClass})` : "#cbd7f7";

  $.overlay.classList.remove("show");
  void $.overlay.offsetWidth;
  $.overlay.classList.add("show");
}

// ====== EVENTS ======
function bindEvents(){
  if($.roleSelect){
    $.roleSelect.addEventListener("change", ()=>{
      myRole=$.roleSelect.value;
      renderAdminControls();
    });
    myRole=$.roleSelect.value;
  }

  $.bidBtn && $.bidBtn.addEventListener("click", placeBid);
  $.bidAmount && $.bidAmount.addEventListener("keydown",(e)=>{
    if(e.key==="Enter") placeBid();
  });

  $.btnStartReal && $.btnStartReal.addEventListener("click", startMainAuction);
  $.btnStartTest && $.btnStartTest.addEventListener("click", startMainAuction);
  $.btnStartRemaining && $.btnStartRemaining.addEventListener("click", startRemainingAuction);
  $.btnReset && $.btnReset.addEventListener("click", resetAll);
}
bindEvents();
