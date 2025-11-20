// app.js
import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, onSnapshot,
  collection, addDoc, query, orderBy,
  serverTimestamp, where, limit,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

/* ===================== 기본 설정 ===================== */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const ROOM_ID = "room1";

/* 팀장 정보(포인트 시작값) */
const LEADERS = {
  leader1: { id:"leader1", name:"팀장1", startPoints:1000, teamName:"플레임 팀" },
  leader2: { id:"leader2", name:"팀장2", startPoints:1000, teamName:"큐베 팀" },
  leader3: { id:"leader3", name:"팀장3", startPoints:1000, teamName:"씨액 팀" },
  leader4: { id:"leader4", name:"팀장4", startPoints:1000, teamName:"호진 팀" }
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
const currentTurnSpan = document.getElementById("current-turn");

const roomStatusDot = document.getElementById("room-status-dot");
const roomStatusText = document.getElementById("room-status-text");

const currentPhoto = document.getElementById("current-player-photo");
const currentName = document.getElementById("current-player-name");
const currentRole = document.getElementById("current-player-role");
const currentGroup = document.getElementById("current-player-group");
const currentBase = document.getElementById("current-player-base");
const currentStatus = document.getElement
