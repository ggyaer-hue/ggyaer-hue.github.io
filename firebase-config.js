// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDldhIELEidJQQck4ljtWznalakpXbAGQA",
  authDomain: "cwgauction-8ae37.firebaseapp.com",
  projectId: "cwgauction-8ae37",
  storageBucket: "cwgauction-8ae37.firebasestorage.app",
  messagingSenderId: "44783149326",
  appId: "1:44783149326:web:e6321e381f7ffc4864775f",
  measurementId: "G-48GXGZ32CW"
};

// ✅ named export로 app, db 내보내기
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
