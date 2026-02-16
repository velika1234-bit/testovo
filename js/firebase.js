// ============================================
// Firebase конфигурация и инициализация
// ============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getFirestore, collection, doc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

// --- ВАШАТА КОНФИГУРАЦИЯ (вече я имате) ---
const firebaseConfig = {
    apiKey: "AIzaSyA0WhbnxygznaGCcdxLBHweZZThezUO314",
    authDomain: "videoquiz-ultimate.firebaseapp.com",
    projectId: "videoquiz-ultimate",
    storageBucket: "videoquiz-ultimate.firebasestorage.app",
    messagingSenderId: "793138692820",
    appId: "1:793138692820:web:8ee2418d28d47fca6bf141"
};

// --- Инициализация ---
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const functions = getFunctions(app, 'us-central1');

// --- Константи, които се ползват навсякъде ---
export const finalAppId = 'videoquiz-ultimate-live';

// --- Помощни функции за пътища във Firestore (също ги местим тук) ---
export const getTeacherSoloResultsCollection = (teacherId) => 
    collection(db, 'artifacts', finalAppId, 'users', teacherId, 'solo_results');

export const getSessionRefById = (id) => 
    doc(db, 'artifacts', finalAppId, 'public', 'data', 'sessions', id);

export const getParticipantsCollection = (id) => 
    collection(db, 'artifacts', finalAppId, 'public', 'data', 'sessions', id, 'participants');

export const getParticipantRef = (sessionId, participantId) => 
    doc(db, 'artifacts', finalAppId, 'public', 'data', 'sessions', sessionId, 'participants', participantId);

export const getLegacyParticipantsCollection = () => 
    collection(db, 'artifacts', finalAppId, 'public', 'data', 'participants');

export const getLegacyParticipantRef = (participantId) => 
    doc(db, 'artifacts', finalAppId, 'public', 'data', 'participants', participantId);
