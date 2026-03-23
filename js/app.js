import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, serverTimestamp, updateDoc, deleteDoc, addDoc, query, where, limit, getDocs, collectionGroup } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
// --- Импортиране на helper функции от utils.js ---
import { formatTime, formatDate, parseScoreValue, decodeQuizCode, AVATARS, getTimestampMs } from './utils.js';

// Backward-compatible globals (за стари извиквания window.formatDate/window.formatTime)
window.formatDate = formatDate;
window.formatTime = formatTime;
window.decodeQuizCode = decodeQuizCode;

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyA0WhbnxygznaGCcdxLBHweZZThezUO314",
    authDomain: "videoquiz-ultimate.firebaseapp.com",
    projectId: "videoquiz-ultimate",
    storageBucket: "videoquiz-ultimate.firebasestorage.app",
    messagingSenderId: "793138692820",
    appId: "1:793138692820:web:8ee2418d28d47fca6bf141"
};

const finalAppId = 'videoquiz-ultimate-live';
const legacyAppId = 'videoquiz-ultimate';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'us-central1');
// --- GLOBAL STATE ---
let user = null;
let lastAuthUid = null;
let isTeacher = false;
let editingQuizId = null;
let editingQuestionIndex = null;
const MASTER_TEACHER_CODE = "vilidaf76";

let player, solvePlayer, hostPlayer;
let questions = [], currentQuiz = null, studentNameValue = "";
let sessionID = "", liveActiveQIdx = -1;
let sessionDocId = "";
let lastAnsweredIdx = -1;
let currentVideoId = "";
let unsubscribes = [];
let activeIntervals = [];
let liveScore = 0;
let scoreCount = 0, currentQIndex = -1;
let lastFetchedParticipants = [];
let soloResults = [];
let myQuizzes = [];
let isYTReady = false;
let authMode = 'login';
let soloGameFinished = false;
let currentQuizOwnerId = null;
let currentParticipantRef = null;
let participantStorageMode = 'legacy';
let rulesModalShown = false;
let sopModeEnabled = false;
let isDiscussionMode = false;
const RISK_THRESHOLDS = {
    minEngagementPct: 60,
    minAccuracyPct: 50,
    minScorePct: 40
};

// Helper functions for Firestore paths
const getTeacherSoloResultsCollection = (teacherId) => collection(db, 'artifacts', finalAppId, 'users', teacherId, 'solo_results');
const getTeacherQuizzesCollection = (teacherId, appId = finalAppId) => collection(db, 'artifacts', appId, 'users', teacherId, 'my_quizzes');
const getSessionRefById = (id) => doc(db, 'artifacts', finalAppId, 'public', 'data', 'sessions', id);
const getParticipantsCollection = (id) => collection(db, 'artifacts', finalAppId, 'public', 'data', 'sessions', id, 'participants');
const getParticipantRef = (sessionId, participantId) => doc(db, 'artifacts', finalAppId, 'public', 'data', 'sessions', sessionId, 'participants', participantId);
const getLegacyParticipantsCollection = () => collection(db, 'artifacts', finalAppId, 'public', 'data', 'participants');
const getLegacyParticipantRef = (participantId) => doc(db, 'artifacts', finalAppId, 'public', 'data', 'participants', participantId);
const getActiveParticipantRef = (sessionId, participantId) => participantStorageMode === 'legacy' ? getLegacyParticipantRef(participantId) : getParticipantRef(sessionId, participantId);

window.tempLiveSelection = null;



// --- ANSWER CHECK (shared for SOLO + LIVE) ---
// ВАЖНО: функцията трябва да е в глобалния (module) scope, за да работят всички типове въпроси.
// Boolean FIX: приема коректно true/false, 1/0, "true"/"false", "ДА"/"НЕ", "Вярно"/"Грешно".
const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true','1','yes','y','t','да','вярно'].includes(s)) return true;
  if (['false','0','no','n','f','не','грешно'].includes(s)) return false;
  return null;
};

const isAnswerCorrect = (q, value) => {
  if (!q) return false;

  const type = (q.type || 'single').toLowerCase();
  const correct = q.correct ?? q.answer ?? q.correctIndex ?? q.correctIndices;

  // ✅ BOOLEAN (Вярно/Грешно) — работи с true/false, 1/0, "ДА/НЕ", "ВЯРНО/ГРЕШНО"
  if (type === 'boolean' || type === 'tf' || type === 'truefalse') {
    const u = toBool(value);
    const c = toBool(correct);
    if (u === null || c === null) return false;
    return u === c;
  }

  // SINGLE (един верен)
  if (type === 'single') {
    const v = String(value ?? '');

    // correct може да е индекс (0..), буква ('A'), или текст на отговор
    if (typeof correct === 'number') return Number(v) === correct;
    if (typeof correct === 'string') return v.trim().toLowerCase() === correct.trim().toLowerCase();
    if (Array.isArray(correct) && correct.length === 1) return v === String(correct[0]);
    return false;
  }

  // MULTIPLE (множество верни) – очакваме масив от индекси/стойности
  if (type === 'multiple') {
    const arr = Array.isArray(value) ? value.map(String) : [];
    if (Array.isArray(correct)) {
      const c = correct.map(String).sort().join('|');
      const a = arr.sort().join('|');
      return a === c;
    }
    return false;
  }

  // OPEN (свободен) – приема за вярно ако има текст (оценяването е “учителско”)
  if (type === 'open') {
    return String(value ?? '').trim().length > 0;
  }

  // SLIDER / NUMERIC
  if (type === 'numeric' || type === 'slider') {
    const num = Number(value);
    const cnum = Number(correct);
    if (!Number.isFinite(num) || !Number.isFinite(cnum)) return false;
    const tol = Number(q.tolerance ?? 0);
    return Math.abs(num - cnum) <= tol;
  }

  return false;
};

window.isAnswerCorrect = isAnswerCorrect;

// --- SAFE DOM HELPERS ---
const safeSetText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
};

const safeSetHTML = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
};

// --- AUTH LOGIC ---
onAuthStateChanged(auth, async (u) => {
    const incomingUid = u?.uid || null;
    if (lastAuthUid !== incomingUid) {
        myQuizzes = [];
        soloResults = [];
        if (document.getElementById('my-quizzes-list')) renderMyQuizzes();
        if (document.getElementById('solo-results-body')) renderSoloResults();
        // --- ПОКАЗВАНЕ НА АДМИН БУТОН (само за администратор) ---
const ADMIN_UID = 'uNdGTBsgatZX4uOPTZqKG9qLJVZ2';
const adminBtn = document.getElementById('admin-panel-btn');
if (adminBtn) {
  if (incomingUid === ADMIN_UID) {
    adminBtn.classList.remove('hidden');
  } else {
    adminBtn.classList.add('hidden');
  }
}
    }
    lastAuthUid = incomingUid;
    user = u;
    document.getElementById('auth-loader')?.classList.add('hidden');

    if (user) {
        const isAnon = user.isAnonymous;
        const uidDisplay = isAnon ? `Анонимен (${user.uid.substring(0,5)}...)` : user.email;
        const debugUidEl = document.getElementById('debug-uid');
        if(debugUidEl) debugUidEl.innerText = uidDisplay;

        const profileRef = doc(db, 'artifacts', finalAppId, 'users', user.uid, 'settings', 'profile');
        try {
            const profileSnap = await getDoc(profileRef);
            if (profileSnap.exists() && profileSnap.data().role === 'teacher') {
                isTeacher = true;
                window.loadMyQuizzes();
                window.loadSoloResults();
                if (!document.getElementById('screen-welcome').classList.contains('hidden')) {
                    window.switchScreen('teacher-dashboard');
                }
            } else if (!isAnon) {
                window.switchScreen('welcome');
            }
        } catch (e) {
            console.error("Cloud Access Error:", e);
            if (e.code === 'permission-denied') window.showRulesHelpModal();
        }
    } else {
        window.switchScreen('welcome');
    }
});

const initAuth = async () => {
    await setPersistence(auth, browserLocalPersistence);

    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        try {
            await signInWithCustomToken(auth, __initial_auth_token);
        } catch (e) {
            if (e.code === 'auth/custom-token-mismatch') {
                console.warn("Служебният токен е игнориран (Private Config).");
            } else {
                console.error("Custom token auth failed", e);
            }
        }
    }
};

setTimeout(() => {
    const loader = document.getElementById('auth-loader');
    if (loader && !loader.classList.contains('hidden')) loader.classList.add('hidden');
}, 4000);

initAuth();

setTimeout(() => {
    const anyVisible = Array.from(document.querySelectorAll('#app > div')).some(div => !div.classList.contains('hidden'));
    if (!anyVisible) {
        console.warn('No visible screen detected. Recovering to welcome screen.');
        window.switchScreen('welcome');
    }
}, 1200);

// --- HELPER FUNCTIONS ---
window.resolveTeacherUidFromCode = async (decoded) => {
    if (!decoded) return null;
    const explicitOwnerId = decoded.ownerId || decoded.teacherId || null;
    if (explicitOwnerId) return explicitOwnerId;
    const ownerEmail = (decoded.ownerEmailNormalized || decoded.ownerEmail || decoded.teacherEmail || '').trim().toLowerCase();
    if (!ownerEmail) return null;
    try {
        const normalizedQ = query(
            collectionGroup(db, 'profile'),
            where('role', '==', 'teacher'),
            where('emailNormalized', '==', ownerEmail)
        );
        const normalizedSnap = await getDocs(normalizedQ);
        if (normalizedSnap.size === 1) {
            return normalizedSnap.docs[0].ref.parent.parent?.id || null;
        }
        if (normalizedSnap.size > 1) {
            console.error('Ambiguous teacher match by emailNormalized:', ownerEmail);
            return null;
        }
        const fallbackQ = query(
            collectionGroup(db, 'profile'),
            where('role', '==', 'teacher'),
            where('email', '==', ownerEmail)
        );
        const fallbackSnap = await getDocs(fallbackQ);
        if (fallbackSnap.size === 1) {
            return fallbackSnap.docs[0].ref.parent.parent?.id || null;
        }
        if (fallbackSnap.size > 1) {
            console.error('Ambiguous teacher match by email:', ownerEmail);
            return null;
        }
    } catch (e) {
        console.error('Owner email lookup failed:', e);
    }
    return null;
};



const normalizeQuizPayload = (rawQuiz) => {
    if (!rawQuiz || typeof rawQuiz !== 'object') return null;
    const videoId = rawQuiz.v || rawQuiz.videoId || rawQuiz.youtubeId || null;
    const questionList = Array.isArray(rawQuiz.q)
        ? rawQuiz.q
        : (Array.isArray(rawQuiz.questions) ? rawQuiz.questions : []);

    if (!videoId || questionList.length === 0) return null;

    return {
        ...rawQuiz,
        v: videoId,
        q: questionList,
        questions: questionList,
        title: rawQuiz.title || rawQuiz.name || 'Без име'
    };
};

window.switchScreen = (name) => {

    document.querySelectorAll('#app > div').forEach(div => div.classList.add('hidden'));
    const target = document.getElementById('screen-' + name);
    if (target) {
        target.classList.remove('hidden');
    } else {
        const fallback = document.getElementById('screen-welcome');
        fallback?.classList.remove('hidden');
        console.warn(`Unknown screen: ${name}. Falling back to welcome.`);
    }

    if (player) { try { player.destroy(); } catch(e) {} player = null; }
    if (solvePlayer) { try { solvePlayer.destroy(); } catch(e) {} solvePlayer = null; }
    if (hostPlayer) { try { hostPlayer.destroy(); } catch(e) {} hostPlayer = null; }

    unsubscribes.forEach(unsub => unsub());
    unsubscribes = [];
    activeIntervals.forEach(i => clearInterval(i));
    activeIntervals = [];
    currentParticipantRef = null;

    if (name === 'teacher-dashboard' && user) {
        window.loadMyQuizzes();
        window.loadSoloResults();
    }
    if (window.lucide) lucide.createIcons();
    window.scrollTo(0, 0);
};

window.showMessage = (text, type = 'info') => {
    const container = document.getElementById('msg-container');
    if (!container) return;
    const msg = document.createElement('div');
    msg.className = `p-4 rounded-2xl shadow-2xl font-black text-white animate-pop mb-3 flex items-center gap-3 ${type === 'error' ? 'bg-rose-500' : 'bg-indigo-600'}`;
    msg.innerHTML = `<i data-lucide="${type === 'error' ? 'alert-circle' : 'info'}" class="w-5 h-5"></i><span>${text}</span>`;
    container.appendChild(msg);
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
        msg.classList.add('opacity-0');
        setTimeout(() => msg.remove(), 500);
    }, 4000);
};

window.quitHostSession = () => {
    if (confirm("Това ще прекъсне сесията и ще спре таймерите. Сигурни ли сте?")) {
        window.switchScreen('teacher-dashboard');
    }
};

// --- PERMISSION ERROR HANDLER ---
window.showRulesHelpModal = () => {
    if (rulesModalShown) return;
    rulesModalShown = true;
    document.getElementById('modal-rules-help').classList.remove('hidden');
    document.getElementById('modal-rules-help').classList.add('flex');
};

// --- AUTH HANDLERS ---
window.toggleAuthMode = () => {
    authMode = authMode === 'login' ? 'register' : 'login';
    const title = document.getElementById('auth-title');
    const btn = document.getElementById('auth-submit-btn');
    const toggleText = document.getElementById('auth-toggle-text');
    const codeField = document.getElementById('auth-teacher-code-container');

    if (authMode === 'register') {
        if (title) title.innerText = "Регистрация на Учител";
        if (btn) btn.innerText = "Регистрирай се";
        if (toggleText) toggleText.innerHTML = 'Вече имате акаунт? <span class="underline font-black cursor-pointer">Влезте тук</span>';
        codeField?.classList.remove('hidden');
    } else {
        if (title) title.innerText = "Вход за Учители";
        if (btn) btn.innerText = "Влез";
        if (toggleText) toggleText.innerHTML = 'Нямате акаунт? <span class="underline font-black cursor-pointer">Регистрирайте се</span>';
        codeField?.classList.add('hidden');
    }
};

window.handleAuthSubmit = async () => {
    const email = document.getElementById('auth-email').value.trim();
    const pass = document.getElementById('auth-password').value.trim();

    if (!email || !pass) return window.showMessage("Попълнете всички полета!", "error");
    if (pass.length < 6) return window.showMessage("Паролата трябва да е поне 6 символа.", "error");

    if (auth.currentUser && auth.currentUser.isAnonymous) {
        await signOut(auth);
    }

    window.showMessage("Обработка...", "info");

    try {
        if (authMode === 'register') {
            const code = document.getElementById('auth-teacher-code').value.trim();
            if (code !== MASTER_TEACHER_CODE) return window.showMessage("Грешен код за учител!", "error");

            try {
                const cred = await createUserWithEmailAndPassword(auth, email, pass);
                await setDoc(doc(db, 'artifacts', finalAppId, 'users', cred.user.uid, 'settings', 'profile'), {
                    role: 'teacher',
                    email: email,
                    emailNormalized: email.toLowerCase(),
                    activatedAt: serverTimestamp()
                });
                window.showMessage("Успешна регистрация!");
                window.switchScreen('teacher-dashboard');
            } catch (innerError) {
                if (innerError.code === 'auth/operation-not-allowed') {
                    console.warn("Email auth disabled, falling back to anonymous teacher profile.");
                    let anonUser = auth.currentUser;
                    if (!anonUser) {
                        const anonCred = await signInAnonymously(auth);
                        anonUser = anonCred.user;
                    }
                    await setDoc(doc(db, 'artifacts', finalAppId, 'users', anonUser.uid, 'settings', 'profile'), {
                        role: 'teacher',
                        email: email + " (Guest)",
                        emailNormalized: email.toLowerCase(),
                        activatedAt: serverTimestamp(),
                        isFallback: true
                    });
                    window.showMessage("Режим 'Гост-Учител' (Операцията не е позволена, проверете Settings).", "info");
                    window.switchScreen('teacher-dashboard');
                } else if (innerError.code === 'permission-denied') {
                    window.showRulesHelpModal();
                } else {
                    throw innerError;
                }
            }
        } else {
            try {
                await signInWithEmailAndPassword(auth, email, pass);
                window.showMessage("Добре дошли отново!");
                window.switchScreen('teacher-dashboard');
            } catch (innerError) {
                if (innerError.code === 'auth/operation-not-allowed') {
                    window.showMessage("Грешка в конфигурацията на Firebase (Auth not allowed).", "error");
                } else if (innerError.code === 'permission-denied') {
                    window.showRulesHelpModal();
                } else {
                    throw innerError;
                }
            }
        }
    } catch (error) {
        console.error(error);
        if (error.code === 'auth/email-already-in-use') window.showMessage("Този имейл вече се използва.", "error");
        else window.showMessage("Грешка при вход: " + error.message, "error");
    }
};

window.handleLogout = async () => {
    await signOut(auth);
    window.myQuizzes = [];
    soloResults = [];
    window.showMessage("Излязохте успешно. Презареждане...");
    setTimeout(() => {
        location.reload();
    }, 1000);
};

// --- IMPORT / EXPORT LOGIC ---
window.openImportModal = () => {
    document.getElementById('import-code-input').value = "";
    document.getElementById('modal-import').classList.remove('hidden');
    document.getElementById('modal-import').classList.add('flex');
};

window.submitImport = () => {
    const code = document.getElementById('import-code-input').value;
    if (!code) return window.showMessage("Моля поставете код.", "error");

    const decoded = window.decodeQuizCode(code);
    if (!decoded || (!decoded.v || (!decoded.q && !decoded.questions))) {
        return window.showMessage("Кодът е невалиден.", "error");
    }

    const quizData = {
        title: decoded.title || "Без име",
        v: decoded.v,
        q: decoded.q || decoded.questions || []
    };

    window.saveImportedQuiz(quizData);
    document.getElementById('modal-import').classList.add('hidden');
};

window.saveImportedQuiz = async (data) => {
    if (!user) return;
    window.showMessage("Импортиране...");
    try {
        await addDoc(getTeacherQuizzesCollection(user.uid), {
            title: data.title + " (Импортиран)", v: data.v, questions: data.q, createdAt: serverTimestamp()
        });
        window.showMessage("Урокът е добавен!", "info");
    } catch (e) {
        if (e.code === 'permission-denied') window.showRulesHelpModal();
        else window.showMessage("Грешка при импорт!", "error");
    }
};

// --- FIREBASE DATA OPS ---
window.loadMyQuizzes = async () => {
    if (!user) return;

    const normalizeStoredQuizSafe = typeof normalizeStoredQuiz === 'function'
        ? normalizeStoredQuiz
        : (rawQuiz) => {
            if (!rawQuiz || typeof rawQuiz !== 'object') return null;
            const videoId = rawQuiz.v || rawQuiz.videoId || rawQuiz.youtubeId || null;
            const questionList = Array.isArray(rawQuiz.questions)
                ? rawQuiz.questions
                : (Array.isArray(rawQuiz.q) ? rawQuiz.q : []);
            return {
                ...rawQuiz,
                id: rawQuiz.id,
                title: rawQuiz.title || rawQuiz.name || 'Без име',
                v: videoId,
                questions: questionList,
                q: questionList
            };
        };

    const snapshotsBySource = new Map();
    const rebuildAndRender = () => {
        const mergedByKey = new Map();
        snapshotsBySource.forEach((docs, sourceAppId) => {
            docs.forEach((quizDoc) => {
                const normalized = normalizeStoredQuizSafe(quizDoc);
                if (!normalized?.id) return;
                mergedByKey.set(`${sourceAppId}:${normalized.id}`, normalized);
            });
        });
        myQuizzes = Array.from(mergedByKey.values());
        renderMyQuizzes();
    };

    const attachListener = (appId) => {
        const q = getTeacherQuizzesCollection(user.uid, appId);
        const unsub = onSnapshot(q, (snap) => {
            snapshotsBySource.set(appId, snap.docs.map((d) => ({ ...d.data(), id: d.id })));
            rebuildAndRender();
        }, (error) => {
            console.error(`My quizzes error (${appId}):`, error);
            if (error.code === 'permission-denied') {
                if (appId === legacyAppId) {
                    console.warn('Legacy app scope is not readable with current Firestore rules. Continuing with current scope only.');
                    return;
                }
                window.showRulesHelpModal();
            }
        });
        unsubscribes.push(unsub);
    };

    attachListener(finalAppId);
    if (legacyAppId !== finalAppId) {
        attachListener(legacyAppId);
    }
};

window.loadSoloResults = async () => {
    if (!user) return;
    soloResults = [];
    renderSoloResults();
    const q = getTeacherSoloResultsCollection(user.uid);
    const unsub = onSnapshot(q, (snap) => {
        soloResults = snap.docs.map(d => ({...d.data(), id: d.id}));
        renderSoloResults();
    }, (error) => {
        console.error("Solo results error:", error);
        if (error.code === 'permission-denied') window.showRulesHelpModal();
        soloResults = [];
        renderSoloResults();
    });
    unsubscribes.push(unsub);
};

window.deleteSoloResult = async (id) => {
    if (!user) return;
    if (confirm("Сигурни ли сте, че искате да изтриете този запис?")) {
        try {
            await deleteDoc(doc(getTeacherSoloResultsCollection(user.uid), id));
            window.showMessage("Записът е изтрит.", "info");
        } catch (e) {
            console.error(e);
            if (e.code === 'permission-denied') window.showRulesHelpModal();
            else window.showMessage("Грешка при изтриване.", "error");
        }
    }
};

function renderMyQuizzes() {
    const container = document.getElementById('my-quizzes-list');
    if (!container) return;
    container.innerHTML = myQuizzes.map(q => `
        <div class="bg-white p-5 rounded-[1.5rem] border shadow-sm flex flex-col sm:flex-row justify-between items-center hover:border-indigo-600 transition-all gap-4">
            <div class="truncate flex-1 w-full text-center sm:text-left">
                <h4 class="font-black text-slate-800 truncate pr-4 text-base sm:text-lg">${q.title}</h4>
                <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest">${q.questions?.length || 0} въпроса</p>
            </div>
            <div class="flex items-center gap-2">
                <button onclick="window.startHostFromLibrary('${q.id}')" title="Старт на живо" class="p-3 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-600 hover:text-white transition-all"><i data-lucide="play" class="w-4 h-4 sm:w-5 sm:h-5"></i></button>
                <button onclick="window.editQuiz('${q.id}')" title="Редактирай" class="p-3 bg-white text-indigo-600 rounded-xl hover:bg-indigo-600 hover:text-white transition-all border-2 border-indigo-100"><i data-lucide="pencil" class="w-4 h-4 sm:w-5 sm:h-5"></i></button>
                <button onclick="window.showShareCode('${q.id}')" title="Вземи код" class="p-3 bg-amber-50 text-amber-600 rounded-xl hover:bg-amber-600 hover:text-white transition-all"><i data-lucide="link" class="w-4 h-4 sm:w-5 sm:h-5"></i></button>
                <button onclick="window.deleteQuiz('${q.id}')" title="Изтрий" class="p-3 bg-rose-50 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white transition-all"><i data-lucide="trash-2" class="w-4 h-4 sm:w-5 sm:h-5"></i></button>
            </div>
        </div>
    `).join('') || '<div class="col-span-full text-center py-10 opacity-30 italic">Библиотеката е празна.</div>';
    if (window.lucide) lucide.createIcons();
}

function renderSoloResults() {
    const body = document.getElementById('solo-results-body');
    if (!body) return;

    const sortedResults = [...soloResults].sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));
    const summaryEl = document.getElementById('solo-results-summary');
    if (summaryEl) {
        const totalAttempts = sortedResults.length;
        const totals = sortedResults.reduce((acc, r) => {
            const parsed = parseScoreValue(r.score);
            acc.score += parsed.score;
            acc.total += parsed.total;
            return acc;
        }, { score: 0, total: 0 });
        const pct = totals.total > 0 ? Math.round((totals.score / totals.total) * 100) : 0;
        summaryEl.innerText = totalAttempts > 0
            ? `Опити: ${totalAttempts} • Среден успех: ${pct}% (${totals.score}/${totals.total})`
            : 'Все още няма резултати за този профил.';
    }

    body.innerHTML = sortedResults.map(r => `
        <tr class="border-b text-[10px] sm:text-xs hover:bg-slate-50">
            <td class="py-3 px-4 font-black text-slate-700">${r.studentName}</td>
            <td class="py-3 px-4 text-slate-500 truncate max-w-[120px]">${r.quizTitle}</td>
            <td class="py-3 px-4 text-slate-400 font-mono">${formatDate(r.timestamp)}</td>
            <td class="py-3 px-4 text-right"><span class="bg-indigo-100 text-indigo-600 px-2 py-1 rounded-lg font-black">${r.score}</span></td>
            <td class="py-3 px-4 text-center">
                <button onclick="window.deleteSoloResult('${r.id}')" class="text-rose-400 hover:text-rose-600 p-2 rounded-lg hover:bg-rose-50 transition-all" title="Изтрий резултат">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="5" class="py-6 text-center text-slate-300 italic">Няма данни</td></tr>';
    if (window.lucide) lucide.createIcons();
}

// --- LIVE HOST LOGIC ---
window.startHostFromLibrary = async (id) => {
    const quiz = myQuizzes.find(q => q.id === id);
    if (!quiz) return window.showMessage("Грешка при зареждане на урока.", "error");
    if (!quiz.v || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
        return window.showMessage("Този урок е в стар/непълен формат. Отворете Редакция и запазете отново.", "error");
    }
    currentQuiz = { v: quiz.v, q: quiz.questions, title: quiz.title };
    currentQuizOwnerId = user?.uid || null;
    await window.openLiveHost();
};

const generateNumericPin = (length = 3) => {
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return Math.floor(min + Math.random() * (max - min + 1)).toString();
};

const createUniqueSessionPin = async () => {
    for (let i = 0; i < 20; i++) {
        const candidate = i < 15 ? generateNumericPin(3) : generateNumericPin(4);
        const existingSnap = await getDoc(getSessionRefById(candidate));
        if (!existingSnap.exists()) return candidate;
    }
    return generateNumericPin(4);
};

window.openLiveHost = async () => {
    if (!user) return;
    sessionID = await createUniqueSessionPin();
    sessionDocId = sessionID;
    window.switchScreen('live-host');
    document.getElementById('host-pin').innerText = sessionID;

    const totalPoints = currentQuiz.q.reduce((a, q) => a + (q.points || 1), 0);

    try {
        await setDoc(getSessionRefById(sessionDocId), {
            activeQ: -1, status: 'waiting', hostId: user.uid, pin: sessionID, timestamp: serverTimestamp(),
            totalPoints: totalPoints
        });
    } catch(e) {
        console.error(e);
        if(e.code === 'permission-denied') window.showRulesHelpModal();
    }

    participantStorageMode = 'session';
    let sessionParticipants = [];
    let legacyParticipants = [];

    const mergeAndRenderParticipants = () => {
        const map = new Map();
        sessionParticipants.forEach((part) => {
            map.set(part.id, { ...part, _source: 'session' });
        });
        legacyParticipants.forEach((part) => {
            if (!map.has(part.id)) map.set(part.id, { ...part, _source: 'legacy' });
        });
        lastFetchedParticipants = Array.from(map.values());
        renderHostDashboard();
    };

    const unsubSession = onSnapshot(getParticipantsCollection(sessionDocId), (snap) => {
        sessionParticipants = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        mergeAndRenderParticipants();
    }, (error) => {
        console.error('Session participants snapshot error:', error);
        if (error.code === 'permission-denied') window.showRulesHelpModal();
    });

    const unsubLegacy = onSnapshot(getLegacyParticipantsCollection(), (snap) => {
        legacyParticipants = snap.docs
            .map(d => ({ ...d.data(), id: d.id }))
            .filter(p => p.sessionId === sessionID);
        mergeAndRenderParticipants();
    }, (error) => {
        console.error('Legacy participants snapshot error:', error);
        if (error.code === 'permission-denied') window.showRulesHelpModal();
    });

    unsubscribes.push(unsubSession, unsubLegacy);
};

window.initHostPlayer = () => {
    if (!window.YT || !window.YT.Player) {
        window.showMessage("Изчакайте YouTube API...", "error");
        setTimeout(window.initHostPlayer, 1000);
        return;
    }

    document.getElementById('host-video-container').innerHTML = '<div id="host-video"></div>';
    hostPlayer = new YT.Player('host-video', {
        videoId: currentQuiz.v,
        playerVars: { 'autoplay': 1, 'modestbranding': 1, 'rel': 0, 'playsinline': 1, 'origin': window.location.origin },
        events: {
            'onReady': (event) => event.target.playVideo(),
            'onStateChange': async (e) => {
                if (e.data === YT.PlayerState.PLAYING) {
                    const i = setInterval(async () => {
                        if (!hostPlayer?.getCurrentTime) return;
                        const cur = Math.floor(hostPlayer.getCurrentTime());
                        document.getElementById('host-timer').innerText = formatTime(cur);
                        const qIdx = currentQuiz.q.findIndex(q => Math.abs(q.time - cur) <= 1);
                        if (qIdx !== -1 && qIdx !== liveActiveQIdx) {
                            liveActiveQIdx = qIdx;
                            hostPlayer.pauseVideo();
                            await updateDoc(getSessionRefById(sessionDocId), {
                                activeQ: qIdx, qData: JSON.parse(JSON.stringify(currentQuiz.q[qIdx])), status: 'active', qStartedAt: serverTimestamp()
                            });
                        }
                    }, 1000);
                    activeIntervals.push(i);
                }
            }
        }
    });
    document.getElementById('host-setup-area').classList.add('hidden');
    document.getElementById('host-player-area').classList.remove('hidden');
};

window.deleteParticipant = async (id) => {
    if (!confirm("Сигурни ли сте, че искате да премахнете този участник?")) return;
    try {
        await Promise.allSettled([
            deleteDoc(getParticipantRef(sessionDocId, id)),
            deleteDoc(getLegacyParticipantRef(id))
        ]);
        window.showMessage("Участникът е премахнат.", "info");
    } catch (e) {
        console.error(e);
        if(e.code === 'permission-denied') window.showRulesHelpModal();
        else window.showMessage("Грешка при изтриване.", "error");
    }
};

function renderHostDashboard() {
    const participantsCount = lastFetchedParticipants.length;
    const countEl = document.getElementById('host-participant-count');
    if (countEl) countEl.innerText = participantsCount;

    const quizQuestions = currentQuiz?.q || [];
    const totalMax = quizQuestions.reduce((a, b) => a + (b.points || 1), 0);

    let totalAnswers = 0;
    let totalCorrect = 0;

    lastFetchedParticipants.forEach(p => {
        const answersObj = p.answers || {};
        const values = Object.values(answersObj);
        totalAnswers += values.length;
        totalCorrect += values.filter(a => a === true).length;
    });

    const progressBar = document.getElementById('class-progress-bar');
    const progressCorrect = document.getElementById('progress-correct');
    const progressWrong = document.getElementById('progress-wrong');
    const progressStatsText = document.getElementById('progress-stats-text');
    const progressPercent = document.getElementById('progress-percent');

    if (progressBar) {
        const correctPct = totalAnswers > 0 ? (totalCorrect / totalAnswers) * 100 : 0;
        const wrongPct = totalAnswers > 0 ? 100 - correctPct : 0;
        if (progressCorrect) progressCorrect.style.width = correctPct + '%';
        if (progressWrong) progressWrong.style.width = wrongPct + '%';

        if (progressStatsText) {
            progressStatsText.innerText = totalAnswers > 0
                ? `В: ${totalCorrect} (${Math.round(correctPct)}%) / Г: ${totalAnswers - totalCorrect} (${Math.round(wrongPct)}%) / П: ${Math.max(0, (participantsCount * quizQuestions.length) - totalAnswers)}`
                : 'Очакват се отговори...';
        }
        if (progressPercent) progressPercent.innerText = Math.round(correctPct) + '%';
        progressBar.classList.remove('opacity-0');
    }

    let fastestOverallMs = null;
    let fastestOverallName = null;
    lastFetchedParticipants.forEach((p) => {
        const r = p.reactionMs || {};
        Object.values(r).forEach((ms) => {
            if (typeof ms === 'number' && ms >= 0 && (fastestOverallMs === null || ms < fastestOverallMs)) {
                fastestOverallMs = ms;
                fastestOverallName = p.name || 'Участник';
            }
        });
    });
    const fastestEl = document.getElementById('fastest-reaction-text');
    if (fastestEl) {
        fastestEl.innerText = fastestOverallMs !== null
            ? `⚡ Най-бърз отговор: ${fastestOverallName} (${(fastestOverallMs / 1000).toFixed(2)}s)`
            : '⚡ Най-бърз отговор: няма данни';
    }

    const leaderboard = [...lastFetchedParticipants].map((p) => {
        const answersObj = p.answers || {};
        const givenAnswers = Object.values(answersObj).filter(v => v === true || v === false).length;
        const correctAnswers = Object.values(answersObj).filter(v => v === true).length;
        const accuracy = givenAnswers > 0 ? Math.round((correctAnswers / givenAnswers) * 100) : 0;
        const engagementPct = quizQuestions.length > 0 ? Math.round((givenAnswers / quizQuestions.length) * 100) : 0;
        const scorePct = totalMax > 0 ? Math.round(((p.score || 0) / totalMax) * 100) : 0;

        const reactionValues = Object.values(p.reactionMs || {}).filter(v => typeof v === 'number' && v >= 0);
        const bestReactionMs = reactionValues.length ? Math.min(...reactionValues) : null;
        const riskSignals = [];
        if (engagementPct < RISK_THRESHOLDS.minEngagementPct) riskSignals.push('ниска активност');
        if (accuracy < RISK_THRESHOLDS.minAccuracyPct) riskSignals.push('ниска точност');
        if (scorePct < RISK_THRESHOLDS.minScorePct) riskSignals.push('нисък резултат');
        return { ...p, givenAnswers, correctAnswers, accuracy, bestReactionMs, riskSignals };
    }).sort((a, b) => (b.score - a.score) || (b.accuracy - a.accuracy));

    document.getElementById('host-results-body').innerHTML = leaderboard
        .map((p, idx) => `
        <tr class="border-b transition-all hover:bg-slate-50 animate-pop">
            <td class="py-3 px-3 font-black text-xs sm:text-sm">
                <div class="flex items-center gap-2">
                    <span class="text-slate-300 w-5">${idx+1}.</span>
                    <span class="text-lg">${p.avatar || '👤'}</span>
                    <span class="truncate">${p.name}</span>
                    ${p.riskSignals.length > 0 ? `<span class="text-[9px] font-black uppercase bg-amber-100 text-amber-700 px-2 py-1 rounded-lg">⚠ Риск</span>` : ''}
                </div>
                <div class="mt-1 text-[10px] text-slate-400 font-bold">Отг.: ${p.givenAnswers}/${quizQuestions.length || 0} · Точност: ${p.accuracy}%${p.bestReactionMs !== null ? ` · ⚡ ${(p.bestReactionMs / 1000).toFixed(2)}s` : ''}</div>
                ${p.riskSignals.length > 0 ? `<div class="mt-1 text-[10px] text-amber-600 font-bold">Рискови сигнали: ${p.riskSignals.join(', ')}</div>` : ''}
            </td>
            <td class="py-3 px-3 text-right"><span class="bg-indigo-100 text-indigo-600 px-3 py-1 rounded-xl font-black text-xs sm:text-sm">${p.score} / ${totalMax || 0}</span></td>
            <td class="py-3 px-2 text-center">
                <button onclick="window.deleteParticipant('${p.id}')" class="text-slate-300 hover:text-rose-500 transition-colors p-1 rounded-lg" title="Премахни участник">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
            </td>
        </tr>`).join('');
    if (window.lucide) lucide.createIcons();
}

window.finishLiveSession = async () => {
    if (!sessionID) return;
    try {
        await updateDoc(getSessionRefById(sessionDocId), { status: 'finished' });
        document.getElementById('export-buttons-container').classList.remove('hidden');
        document.getElementById('export-buttons-container').classList.add('flex');
        window.showMessage("Сесията приключи!");
    } catch(e) {
        if(e.code === 'permission-denied') window.showRulesHelpModal();
    }
};

// --- EXCEL & PRINT LOGIC ---
function getResultsData() {
    if (!currentQuiz || !lastFetchedParticipants) return [];

    const totalMax = currentQuiz.q.reduce((a, b) => a + (b.points || 1), 0);
    const totalQuestions = currentQuiz.q.length || 0;

    const getReactionSummary = (participant) => {
        const reactionMs = participant?.reactionMs || {};
        const values = Object.values(reactionMs).filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
        if (values.length === 0) {
            return { answeredCount: 0, avgReactionSeconds: '-' };
        }
        const avgMs = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
        return {
            answeredCount: values.length,
            avgReactionSeconds: (avgMs / 1000).toFixed(2)
        };
    };

    let data = [];
    let header = ["Позиция", "Име", `Точки (Макс: ${totalMax})`, "Отговорени", "Средна реакция (s)"];
    currentQuiz.q.forEach((_, idx) => header.push(`Въпрос ${idx + 1}`));
    data.push(header);

    [...lastFetchedParticipants].sort((a,b)=>b.score-a.score).forEach((p,i) => {
        const reactionSummary = getReactionSummary(p);
        let row = [
            (i+1),
            p.name,
            p.score,
            `${reactionSummary.answeredCount}/${totalQuestions}`,
            reactionSummary.avgReactionSeconds
        ];

        currentQuiz.q.forEach((_, qIdx) => {
            let ans = undefined;
            if (p.answers) {
                ans = p.answers[qIdx];
                if (ans === undefined) ans = p.answers[String(qIdx)];
            }

            let cell = "-";
            if (ans === true) cell = "ВЯРНО";
            else if (ans === false) cell = "ГРЕШНО";

            row.push(cell);
        });
        data.push(row);
    });
    return data;
}

function getClassQuestionStats() {
    if (!currentQuiz || !Array.isArray(currentQuiz.q)) return { rows: [], summary: null };

    const participants = [...lastFetchedParticipants];
    const participantsCount = participants.length;
    const stats = currentQuiz.q.map((q, qIdx) => {
        let correct = 0;
        let wrong = 0;
        let answered = 0;
        let firstCorrectName = '-';
        let firstCorrectMs = null;

        participants.forEach((p) => {
            const answers = p.answers || {};
            let ans = answers[qIdx];
            if (ans === undefined) ans = answers[String(qIdx)];

            if (ans === true) {
                correct += 1;
                answered += 1;
                const r = p.reactionMs || {};
                let ms = r[qIdx];
                if (ms === undefined) ms = r[String(qIdx)];
                if (typeof ms === 'number' && ms >= 0 && (firstCorrectMs === null || ms < firstCorrectMs)) {
                    firstCorrectMs = ms;
                    firstCorrectName = p.name || 'Участник';
                }
            } else if (ans === false) {
                wrong += 1;
                answered += 1;
            }
        });

        const missing = Math.max(0, participantsCount - answered);
        const correctPct = answered > 0 ? Math.round((correct / answered) * 100) : 0;
        const wrongPct = answered > 0 ? Math.round((wrong / answered) * 100) : 0;
        const responseRatePct = participantsCount > 0 ? Math.round((answered / participantsCount) * 100) : 0;
        const classCorrectPct = participantsCount > 0 ? Math.round((correct / participantsCount) * 100) : 0;
        const classWrongPct = participantsCount > 0 ? Math.round((wrong / participantsCount) * 100) : 0;

        return {
            qIdx,
            questionText: q?.text || `Въпрос ${qIdx + 1}`,
            correct,
            wrong,
            missing,
            answered,
            participantsCount,
            correctPct,
            wrongPct,
            responseRatePct,
            classCorrectPct,
            classWrongPct,
            firstCorrectName,
            firstCorrectSeconds: firstCorrectMs !== null ? (firstCorrectMs / 1000).toFixed(2) : '-'
        };
    });

    const totalCorrect = stats.reduce((a, r) => a + r.correct, 0);
    const totalWrong = stats.reduce((a, r) => a + r.wrong, 0);
    const totalMissing = stats.reduce((a, r) => a + r.missing, 0);
    const totalAnswered = totalCorrect + totalWrong;
    const classCorrectPct = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
    const classWrongPct = totalAnswered > 0 ? Math.round((totalWrong / totalAnswered) * 100) : 0;
    const expectedAnswers = participantsCount * stats.length;
    const answerCoveragePct = expectedAnswers > 0 ? Math.round((totalAnswered / expectedAnswers) * 100) : 0;

    return {
        rows: stats,
        summary: {
            participantsCount,
            questionsCount: stats.length,
            expectedAnswers,
            totalAnswered,
            totalMissing,
            totalCorrect,
            totalWrong,
            classCorrectPct,
            classWrongPct,
            answerCoveragePct
        }
    };
}

function getLiveSessionTeacherHighlights() {
    const participants = [...(lastFetchedParticipants || [])];
    if (!participants.length) {
        return {
            topScorer: '-',
            mostActive: '-',
            atRiskCount: 0,
            atRiskList: ''
        };
    }

    const sortedByScore = [...participants].sort((a, b) => (b.score || 0) - (a.score || 0));
    const topScorer = sortedByScore[0]?.name || 'Участник';

    const getAnsweredCount = (participant) => {
        const answers = participant?.answers || {};
        return Object.values(answers).filter((v) => v === true || v === false).length;
    };
    const sortedByActivity = [...participants].sort((a, b) => getAnsweredCount(b) - getAnsweredCount(a));
    const mostActiveName = sortedByActivity[0]?.name || 'Участник';
    const mostActiveCount = getAnsweredCount(sortedByActivity[0]);

    const totalQuestions = currentQuiz?.q?.length || 0;
    const totalMaxPoints = (currentQuiz?.q || []).reduce((sum, q) => sum + (q.points || 1), 0);
    const atRisk = participants
        .map((participant) => {
            const answers = participant?.answers || {};
            const givenAnswers = Object.values(answers).filter((v) => v === true || v === false).length;
            const correctAnswers = Object.values(answers).filter((v) => v === true).length;
            const engagementPct = totalQuestions > 0 ? Math.round((givenAnswers / totalQuestions) * 100) : 0;
            const accuracyPct = givenAnswers > 0 ? Math.round((correctAnswers / givenAnswers) * 100) : 0;
            const scorePct = totalMaxPoints > 0 ? Math.round(((participant.score || 0) / totalMaxPoints) * 100) : 0;
            const flags = [];
            if (engagementPct < RISK_THRESHOLDS.minEngagementPct) flags.push('активност');
            if (accuracyPct < RISK_THRESHOLDS.minAccuracyPct) flags.push('точност');
            if (scorePct < RISK_THRESHOLDS.minScorePct) flags.push('резултат');
            return flags.length > 0 ? `${participant.name || 'Участник'} (${flags.join('/')})` : null;
        })
        .filter(Boolean);

    return {
        topScorer,
        mostActive: `${mostActiveName} (${mostActiveCount})`,
        atRiskCount: atRisk.length,
        atRiskList: atRisk.slice(0, 5).join(', ')
    };
}

function getSoloResultsExportModel() {
    const sortedResults = [...soloResults].sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));
    const attempts = sortedResults.map((r, idx) => {
        const parsed = parseScoreValue(r.score);
        const pct = parsed.total > 0 ? Math.round((parsed.score / parsed.total) * 100) : 0;
        return {
            idx: idx + 1,
            studentName: r.studentName || '-',
            quizTitle: r.quizTitle || '-',
            dateTime: formatDate(r.timestamp),
            scoreLabel: r.score || '-',
            score: parsed.score,
            total: parsed.total,
            pct
        };
    });

    const totalAttempts = attempts.length;
    const totalScore = attempts.reduce((a, r) => a + r.score, 0);
    const totalMax = attempts.reduce((a, r) => a + r.total, 0);
    const avgPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;

    const byStudent = new Map();
    attempts.forEach((r) => {
        const prev = byStudent.get(r.studentName) || { attempts: 0, score: 0, total: 0 };
        prev.attempts += 1;
        prev.score += r.score;
        prev.total += r.total;
        byStudent.set(r.studentName, prev);
    });

    const studentSummary = Array.from(byStudent.entries()).map(([name, v]) => ({
        name,
        attempts: v.attempts,
        scoreLabel: `${v.score}/${v.total}`,
        pct: v.total > 0 ? Math.round((v.score / v.total) * 100) : 0
    })).sort((a, b) => b.pct - a.pct || b.attempts - a.attempts);

    return {
        attempts,
        studentSummary,
        summary: { totalAttempts, totalScore, totalMax, avgPct }
    };
}

window.exportSoloResultsExcel = () => {
    const model = getSoloResultsExportModel();
    if (model.attempts.length === 0) return window.showMessage("Няма индивидуални резултати за експорт.", "error");

    const wb = XLSX.utils.book_new();

    const summaryRows = [
        ["ОБЩО ОПИТИ", model.summary.totalAttempts],
        ["ОБЩ РЕЗУЛТАТ", `${model.summary.totalScore}/${model.summary.totalMax}`],
        ["СРЕДЕН УСПЕХ", `${model.summary.avgPct}%`],
        []
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, "Обобщение");

    const attemptsRows = [
        ["#", "Ученик", "Урок", "Дата/Час", "Точки", "% Успех"],
        ...model.attempts.map(r => [r.idx, r.studentName, r.quizTitle, r.dateTime, r.scoreLabel, `${r.pct}%`])
    ];
    const wsAttempts = XLSX.utils.aoa_to_sheet(attemptsRows);
    XLSX.utils.book_append_sheet(wb, wsAttempts, "Индивидуални_Опити");

    const studentRows = [
        ["Ученик", "Опити", "Точки", "% Успех"],
        ...model.studentSummary.map(r => [r.name, r.attempts, r.scoreLabel, `${r.pct}%`])
    ];
    const wsStudents = XLSX.utils.aoa_to_sheet(studentRows);
    XLSX.utils.book_append_sheet(wb, wsStudents, "По_Ученици");

    const timestamp = new Date().toISOString().slice(0,19).replace(/[-:T]/g,"");
    XLSX.writeFile(wb, `solo_results_${timestamp}.xlsx`);
    window.showMessage("Индивидуалният отчет е изтеглен.");
};

window.exportExcel = () => {
    const data = getResultsData();
    if (data.length === 0) return window.showMessage("Няма данни за експорт.", "error");

    const analytics = getClassQuestionStats();
    const highlights = getLiveSessionTeacherHighlights();
    const wb = XLSX.utils.book_new();

    const wsResults = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, wsResults, "Резултати");

    const summaryRows = [
        ["СЕСИЯ", sessionID],
        ["УЧАСТНИЦИ", analytics.summary?.participantsCount ?? 0],
        ["ВЪПРОСИ", analytics.summary?.questionsCount ?? 0],
        ["ОЧАКВАНИ ОТГОВОРИ", analytics.summary?.expectedAnswers ?? 0],
        ["ОБЩО ОТГОВОРИ", analytics.summary?.totalAnswered ?? 0],
        ["БЕЗ ОТГОВОР", analytics.summary?.totalMissing ?? 0],
        ["ПОКРИТИЕ НА ОТГОВОРИТЕ", `${analytics.summary?.answerCoveragePct ?? 0}%`],
        ["ВЕРНИ", `${analytics.summary?.totalCorrect ?? 0} (${analytics.summary?.classCorrectPct ?? 0}%)`],
        ["ГРЕШНИ", `${analytics.summary?.totalWrong ?? 0} (${analytics.summary?.classWrongPct ?? 0}%)`],
        ["ТОП РЕЗУЛТАТ", highlights.topScorer],
        ["НАЙ-АКТИВЕН", highlights.mostActive],
        ["РИСКОВИ УЧЕНИЦИ", highlights.atRiskCount],
        ["РИСКОВ СПИСЪК (TOP 5)", highlights.atRiskList || "-"],
        []
    ];

    const questionHeader = ["Въпрос", "Текст", "Верни", "Грешни", "Без отговор", "Активност", "% Верни (отговорили)", "% Грешни (отговорили)", "% Верни (клас)", "% Грешни (клас)", "Първи верен", "Време (s)"];
    const questionRows = analytics.rows.map((r) => [
        r.qIdx + 1,
        r.questionText,
        r.correct,
        r.wrong,
        r.missing,
        `${r.responseRatePct}%`,
        `${r.correctPct}%`,
        `${r.wrongPct}%`,
        `${r.classCorrectPct}%`,
        `${r.classWrongPct}%`,
        r.firstCorrectName,
        r.firstCorrectSeconds
    ]);
    const wsAnalytics = XLSX.utils.aoa_to_sheet([...summaryRows, questionHeader, ...questionRows]);
    XLSX.utils.book_append_sheet(wb, wsAnalytics, "Анализ_Клас");

    const now = new Date();
    const timestamp = now.toISOString().slice(0,19).replace(/[-:T]/g,"");

    XLSX.writeFile(wb, `results_${sessionID}_${timestamp}.xlsx`);
    window.showMessage("Excel файлът е генериран! (вкл. анализ по въпроси)");
};

window.exportPDF = () => {
  const data = getResultsData();
  if (!data || data.length === 0) return window.showMessage("Няма данни за PDF експорт.", "error");

  const analytics = getClassQuestionStats?.() || { rows: [] };
  const highlights = getLiveSessionTeacherHighlights();

  // data is like: [headRow, ...bodyRows]
  const [head, ...body] = data;

  // helpers
  const esc = (s) => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;");

  const now = new Date().toLocaleString("bg-BG");

  // Опит да изчислим среден успех от точките (ако имаме колони "Точки" и "Макс" или "X/Y")
  // Ако не може — ще го пропуснем тихо.
  let avgPct = null;
  try {
    // намираме индекс на колона "Точки" (или "Резултат")
    const headLower = head.map(h => String(h).toLowerCase());
    const idxScore = headLower.findIndex(h => h.includes("точк") || h.includes("резултат") || h.includes("score"));
    const idxMax = headLower.findIndex(h => h.includes("макс") || h.includes("max"));

    const pcts = [];
    body.forEach(row => {
      const s = row[idxScore];
      const m = idxMax >= 0 ? row[idxMax] : null;

      // формат "X/Y"
      if (typeof s === "string" && s.includes("/")) {
        const [a,b] = s.split("/").map(x => Number(String(x).trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && b > 0) pcts.push(Math.round((a/b)*100));
        return;
      }
      // формат отделно score/max
      const score = Number(s);
      const max = Number(m);
      if (Number.isFinite(score) && Number.isFinite(max) && max > 0) pcts.push(Math.round((score/max)*100));
    });

    if (pcts.length) avgPct = Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length);
  } catch(e) {}

  const makeTable = (headers, rows) => {
    const thead = headers.map(h => `<th>${esc(h)}</th>`).join("");
    const tbody = rows.length
      ? rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${headers.length}">Няма данни</td></tr>`;
    return `
      <table>
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    `;
  };

  const analyticsHead = ['№','Въпрос','Верни','Грешни','Без отговор','Активност','% Верни (отговорили)','% Грешни (отговорили)','% Верни (клас)','% Грешни (клас)','Първи верен','Време (s)'];
  const analyticsBody = (analytics.rows || []).map(r => ([
    String((r.qIdx ?? 0) + 1),
    r.questionText ?? "",
    String(r.correct ?? 0),
    String(r.wrong ?? 0),
    String(r.missing ?? 0),
    `${r.responseRatePct ?? 0}%`,
    `${r.correctPct ?? 0}%`,
    `${r.wrongPct ?? 0}%`,
    `${r.classCorrectPct ?? 0}%`,
    `${r.classWrongPct ?? 0}%`,
    r.firstCorrectName ?? "—",
    String(r.firstCorrectSeconds ?? "—")
  ]));

  const html = `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VideoQuiz - PDF</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; padding:18px; color:#111;}
  h1{margin:0 0 6px; font-size:18px;}
  .meta{font-size:12px; color:#333; margin:2px 0;}
  .summary{margin:12px 0; padding:10px; border:1px solid #ddd; background:#fcfcfc; font-size:12px;}
  table{width:100%; border-collapse:collapse; margin-top:10px; font-size:11px;}
  th,td{border:1px solid #999; padding:6px; vertical-align:top;}
  th{background:#f2f2f2; text-align:left;}
  tr:nth-child(even) td{background:#fafafa;}
  .section-title{margin-top:16px; font-weight:800; font-size:13px;}
  @media print { body{padding:0;} }
</style>
</head>
<body>
  <h1>VideoQuiz – Резултати от сесия ${esc(sessionID || "")}</h1>
  <div class="meta">Дата: ${esc(now)}</div>

  <div class="summary">
    <div>• Брой участници: <b>${esc(body.length)}</b></div>
    <div>• Брой въпроси: <b>${esc(analytics.summary?.questionsCount ?? 0)}</b></div>
    <div>• Покритие на отговорите: <b>${esc(analytics.summary?.answerCoveragePct ?? 0)}%</b></div>
    <div>• Топ резултат: <b>${esc(highlights.topScorer)}</b></div>
    <div>• Най-активен: <b>${esc(highlights.mostActive)}</b></div>
    <div>• Рискови ученици: <b>${esc(highlights.atRiskCount ?? 0)}</b></div>
    ${highlights.atRiskList ? `<div>• Рисков списък (TOP 5): <b>${esc(highlights.atRiskList)}</b></div>` : ""}
    ${avgPct === null ? "" : `<div>• Среден успех на класа: <b>${avgPct}%</b></div>`}
  </div>

  <div class="section-title">Резултати</div>
  ${makeTable(head, body)}

  <div class="section-title">Анализ по въпроси</div>
  ${makeTable(analyticsHead, analyticsBody)}

  <script>
    setTimeout(()=>window.print(), 250);
  </script>
</body>
</html>`;

  const w = window.open("", "_blank");
  if (!w) return window.showMessage("Браузърът блокира нов прозорец (pop-up). Разреши pop-ups и пробвай пак.", "error");
  w.document.open();
  w.document.write(html);
  w.document.close();
};

// --- STUDENT CLIENT LOGIC ---
window.joinLiveSession = async () => {
    const pin = document.getElementById('live-pin').value.trim();
    studentNameValue = document.getElementById('live-student-name').value.trim();
    if (!pin || !studentNameValue) return window.showMessage("Име и ПИН са задължителни!", 'error');
    try {
        if (!user) await signInAnonymously(auth);
        const sessionRef = getSessionRefById(pin);
        sessionID = pin;
        sessionDocId = pin;
        const sessionSnap = await getDoc(sessionRef);
        if (!sessionSnap.exists()) return window.showMessage("Невалиден ПИН код.", 'error');

        const randomAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
        window.switchScreen('live-client');

        liveScore = 0;
        lastAnsweredIdx = -1;
        document.getElementById('my-avatar-display').innerText = randomAvatar;
        window.tempLiveSelection = null;

        const uid = auth.currentUser?.uid || "unknown";

        participantStorageMode = 'legacy';
        const legacyPartRef = getLegacyParticipantRef(uid);
        const sessionPartRef = getParticipantRef(pin, uid);

        let pSnap = await getDoc(sessionPartRef);
        let targetRef = sessionPartRef;
        let found = false;

        if (pSnap.exists()) {
            found = true;
            participantStorageMode = 'session';
        } else {
            pSnap = await getDoc(legacyPartRef);
            if (pSnap.exists() && pSnap.data().sessionId === pin) {
                found = true;
                targetRef = legacyPartRef;
                participantStorageMode = 'legacy';
            }
        }

        currentParticipantRef = targetRef;

        if (found) {
            const d = pSnap.data();
            liveScore = d.score || 0;
            studentNameValue = d.name;
            window.showMessage("Върнахте се в сесията!", "info");
        } else {
            const participantPayload = {
                name: studentNameValue, sessionId: pin, avatar: randomAvatar, score: 0,
                finished: false, lastAnsweredIdx: -1, answers: {}
            };

            try {
                targetRef = sessionPartRef;
                currentParticipantRef = sessionPartRef;
                participantStorageMode = 'session';
                await setDoc(sessionPartRef, participantPayload, { merge: true });
            } catch (writeErr) {
                if (writeErr?.code !== 'permission-denied') throw writeErr;
                targetRef = legacyPartRef;
                currentParticipantRef = legacyPartRef;
                participantStorageMode = 'legacy';
                await setDoc(legacyPartRef, participantPayload, { merge: true });
            }
        }

        const unsub = onSnapshot(sessionRef, (snap) => {
            const d = snap.data(); if (!d) return;
            if (d.status === 'finished') {
                document.getElementById('client-question').classList.add('hidden');
                document.getElementById('client-waiting').classList.add('hidden');
                document.getElementById('client-finished').classList.remove('hidden');
                const maxPoints = d.totalPoints || '?';
                document.getElementById('final-score-display').innerText = `${liveScore} / ${maxPoints}`;
            } else if (d.status === 'active' && d.activeQ !== -1) {
                if (liveActiveQIdx !== d.activeQ) {
                    liveActiveQIdx = d.activeQ;
                    window.currentLiveQ = d.qData;
                    window.currentLiveQStartedAtMs = (typeof d.qStartedAt?.toMillis === 'function')
                        ? d.qStartedAt.toMillis()
                        : (d.qStartedAt?.seconds ? d.qStartedAt.seconds * 1000 : Date.now());
                    document.getElementById('client-question').classList.remove('hidden');
                    document.getElementById('client-waiting').classList.add('hidden');
                    document.getElementById('live-q-text-client').innerText = d.qData.text;
                    window.renderLiveQuestionUI(d.qData);
                }
            } else {
                document.getElementById('client-question').classList.add('hidden');
                document.getElementById('client-waiting').classList.remove('hidden');
                document.getElementById('waiting-status-text').innerText = "Изчакай въпрос...";
            }
        }, (error) => {
            if(error.code === 'permission-denied') window.showRulesHelpModal();
        });
        unsubscribes.push(unsub);
    } catch (e) {
        console.error(e);
        if(e.code === 'permission-denied') window.showRulesHelpModal();
        else window.showMessage("Грешка при свързване.", "error");
    }
};

window.selectLiveOption = (el, val) => {
    document.querySelectorAll('.client-opt-btn').forEach(btn => {
        btn.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-600');
        btn.classList.add('bg-slate-50', 'text-slate-800', 'border-slate-100');
    });
    el.classList.remove('bg-slate-50', 'text-slate-800', 'border-slate-100');
    el.classList.add('bg-indigo-600', 'text-white', 'border-indigo-600');

    window.tempLiveSelection = val;

    const stickyContainer = document.getElementById('sticky-btn-container');
    stickyContainer.classList.remove('hidden');
};

window.submitLiveSingleConfirm = () => {
    if (window.tempLiveSelection === null) return;
    const isCorrect = isAnswerCorrect(window.currentLiveQ, window.tempLiveSelection);
    window.submitLiveFinal(isCorrect);
};

window.selectLiveMultiple = () => {
    const checked = Array.from(document.querySelectorAll('input[name="c-multiple"]:checked'));
    const stickyContainer = document.getElementById('sticky-btn-container');
    if (checked.length > 0) {
        stickyContainer.classList.remove('hidden');
    } else {
        stickyContainer.classList.add('hidden');
    }
};

window.submitLiveMultipleConfirm = () => {
    const checked = Array.from(document.querySelectorAll('input[name="c-multiple"]:checked')).map(el => parseInt(el.value));
    const isCorrect = isAnswerCorrect(window.currentLiveQ, checked);
    window.submitLiveFinal(isCorrect);
};

window.submitLiveOpenConfirm = () => {
    const ans = document.getElementById('c-open-answer')?.value.trim().toLowerCase();
    const isCorrect = isAnswerCorrect(window.currentLiveQ, ans);
    window.submitLiveFinal(isCorrect);
};

window.submitLiveNumericConfirm = () => {
    const slider = document.getElementById('c-numeric-slider');
    if (!slider) return;
    const answer = parseFloat(slider.value);
    const q = window.currentLiveQ;
    const correct = q.correct;
    const tolerance = q.tolerance || 0;
    const isCorrect = Math.abs(answer - correct) <= tolerance;
    window.submitLiveFinal(isCorrect);
};

window.pickLiveOrder = (el, originalIdx) => {
    if (!Array.isArray(window.userOrderSequence)) window.userOrderSequence = [];
    if (window.userOrderSequence.includes(originalIdx)) return;
    window.userOrderSequence.push(originalIdx);
    el.classList.add('opacity-40', 'pointer-events-none');
    const result = document.getElementById('client-ordering-result');
    if (result) {
        const chip = document.createElement('div');
        chip.className = 'bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-black text-[10px]';
        chip.innerText = `${window.userOrderSequence.length}. ${el.innerText}`;
        result.appendChild(chip);
    }
    if (window.userOrderSequence.length === window.currentLiveQ.options.length) {
        document.getElementById('sticky-btn-container')?.classList.remove('hidden');
    }
};

window.pickLiveTimeline = (el, originalIdx) => {
    if (!Array.isArray(window.userOrderSequence)) window.userOrderSequence = [];
    if (window.userOrderSequence.includes(originalIdx)) return;
    window.userOrderSequence.push(originalIdx);
    el.classList.add('opacity-40', 'pointer-events-none');
    const result = document.getElementById('client-timeline-result');
    if (result) {
        const chip = document.createElement('div');
        chip.className = 'bg-amber-600 text-white px-3 py-1.5 rounded-lg font-black text-[10px] flex items-center gap-1';
        chip.innerHTML = `<i data-lucide="clock" class="w-3 h-3"></i> ${window.userOrderSequence.length}. ${el.innerText}`;
        result.appendChild(chip);
        if (window.lucide) lucide.createIcons();
    }
    if (window.userOrderSequence.length === window.currentLiveQ.options.length) {
        document.getElementById('sticky-btn-container')?.classList.remove('hidden');
    }
};

window.clearLiveTimeline = () => {
    window.userOrderSequence = [];
    const result = document.getElementById('client-timeline-result');
    if (result) result.innerHTML = '';
    document.querySelectorAll('.client-timeline-item').forEach((btn) => btn.classList.remove('opacity-40', 'pointer-events-none'));
    document.getElementById('sticky-btn-container')?.classList.add('hidden');
};

window.submitLiveTimelineConfirm = () => {
    const q = window.currentLiveQ;
    if (!Array.isArray(window.userOrderSequence) || window.userOrderSequence.length !== q.options.length) {
        return window.showMessage('Подредете всички събития!', 'error');
    }
    const isCorrect = isAnswerCorrect(q, window.userOrderSequence);
    window.submitLiveFinal(isCorrect);
};

window.clearLiveOrdering = () => {
    window.userOrderSequence = [];
    const result = document.getElementById('client-ordering-result');
    if (result) result.innerHTML = '';
    document.querySelectorAll('.client-order-item').forEach((btn) => btn.classList.remove('opacity-40', 'pointer-events-none'));
    document.getElementById('sticky-btn-container')?.classList.add('hidden');
};

window.submitLiveOrderingConfirm = () => {
    const q = window.currentLiveQ;
    if (!Array.isArray(window.userOrderSequence) || window.userOrderSequence.length !== q.options.length) {
        return window.showMessage('Подредете всички елементи!', 'error');
    }
    const isCorrect = isAnswerCorrect(q, window.userOrderSequence);
    window.submitLiveFinal(isCorrect);
};

window.renderLiveQuestionUI = (q) => {
    const container = document.getElementById('live-options-client');
    container.innerHTML = '';
    window.tempLiveSelection = null;
    window.userOrderSequence = [];

    let btnHtml = `
    <div class="h-28"></div>
    <div id="sticky-btn-container" class="fixed bottom-0 left-0 w-full p-4 bg-white/90 backdrop-blur-md border-t border-indigo-100 z-50 hidden animate-pop pb-6 sm:pb-4">
        <button id="btn-submit-live-unified" class="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-lg shadow-xl shadow-indigo-200 transform active:scale-95 transition-all">ИЗПРАТИ</button>
    </div>`;

    if (q.type === 'single') {
        container.innerHTML = q.options.map((o, i) => `
            <button onclick="window.selectLiveOption(this, ${i})" class="client-opt-btn w-full p-4 text-left bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-slate-800 shadow-sm hover:border-indigo-300 transition-all text-sm mb-2">${o}</button>
        `).join('') + btnHtml;
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveSingleConfirm;
    } else if (q.type === 'multiple') {
        container.innerHTML = q.options.map((o, i) => `
            <label class="flex items-center gap-4 w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-slate-800 cursor-pointer text-sm mb-2">
                <input type="checkbox" name="c-multiple" value="${i}" class="w-6 h-6" onchange="window.selectLiveMultiple()"> ${o}
            </label>
        `).join('') + btnHtml;
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveMultipleConfirm;
    } else if (q.type === 'boolean') {
        container.innerHTML = `
         <div class="grid grid-cols-2 gap-4">
            <button onclick="window.selectLiveOption(this, true)" class="client-opt-btn p-6 sm:p-8 bg-slate-50 border-4 border-slate-100 rounded-3xl font-black text-emerald-600 text-xl">ДА</button>
            <button onclick="window.selectLiveOption(this, false)" class="client-opt-btn p-6 sm:p-8 bg-slate-50 border-4 border-slate-100 rounded-3xl font-black text-rose-600 text-xl">НЕ</button>
         </div>` + btnHtml;
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveSingleConfirm;
    } else if (q.type === 'open') {
        container.innerHTML = `<input type="text" id="c-open-answer" placeholder="Напишете отговор..." class="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-base outline-none text-center mb-4">` + btnHtml;
        document.getElementById('sticky-btn-container').classList.remove('hidden');
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveOpenConfirm;
    } else if (q.type === 'ordering') {
        const shuffled = q.options.map((o, i) => ({o, i})).sort(() => Math.random() - 0.5);
        container.innerHTML = `
            <div id="client-ordering-pool" class="grid grid-cols-1 gap-2 mb-4">${shuffled.map(item => `<button onclick="window.pickLiveOrder(this, ${item.i})" class="client-order-item w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-slate-800 text-sm">${item.o}</button>`).join('')}</div>
            <div id="client-ordering-result" class="flex flex-wrap justify-center gap-2 mb-4 min-h-[40px] border-t pt-4"></div>
            <button type="button" onclick="window.clearLiveOrdering()" class="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-black uppercase text-[10px] mb-2">Изчисти</button>
        ` + btnHtml;
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveOrderingConfirm;
    } else if (q.type === 'timeline') {
        const shuffled = q.options.map((o, i) => ({o, i})).sort(() => Math.random() - 0.5);
        container.innerHTML = `
            <div class="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 font-black text-xs flex items-center gap-2">
                <i data-lucide="clock" class="w-4 h-4"></i> Подредете събитията в хронологичен ред
            </div>
            <div id="client-timeline-pool" class="grid grid-cols-1 gap-2 mb-4">${shuffled.map(item => `<button onclick="window.pickLiveTimeline(this, ${item.i})" class="client-timeline-item w-full p-4 bg-amber-50 border-2 border-amber-200 rounded-2xl font-black text-amber-800 text-sm hover:bg-amber-100 transition-all">${item.o}</button>`).join('')}</div>
            <div id="client-timeline-result" class="flex flex-wrap justify-center gap-2 mb-4 min-h-[40px] border-t border-amber-200 pt-4"></div>
            <button type="button" onclick="window.clearLiveTimeline()" class="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-black uppercase text-[10px] mb-2">Изчисти хронологията</button>
        ` + btnHtml;
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveTimelineConfirm;
        if (window.lucide) lucide.createIcons();
    } else if (q.type === 'numeric' || q.type === 'timeline-slider') {
        const defaultValue = (q.min + q.max) / 2;
        const isTimeline = (q.type === 'timeline-slider');
        
        let sliderHtml = '';
        if (isTimeline) {
            const years = [];
            const step = Math.max(1, Math.ceil((q.max - q.min) / 5));
            for (let y = q.min; y <= q.max; y += step) {
                years.push(Math.round(y));
            }
            if (years[years.length-1] < q.max) years.push(Math.round(q.max));
            
            sliderHtml = `
                <div class="relative pt-6 pb-2">
                    <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-amber-300 via-amber-500 to-amber-700 rounded-full"></div>
                    <div class="flex justify-between text-[10px] font-bold text-amber-700 px-1">
                        ${years.map(y => `<span>${y}</span>`).join('')}
                    </div>
                    <input type="range" id="c-numeric-slider" min="${q.min}" max="${q.max}" step="${q.step || 1}" value="${defaultValue}" 
                        class="w-full h-2 bg-transparent accent-amber-500 appearance-none cursor-pointer mt-2">
                    <div class="flex justify-between text-slate-800 text-sm font-bold mt-2">
                        <span>${q.min}</span>
                        <span id="c-numeric-value" class="bg-amber-600 text-white px-6 py-2 rounded-full font-black shadow-lg">${defaultValue}</span>
                        <span>${q.max}</span>
                    </div>
                </div>
            `;
        } else {
            sliderHtml = `
                <div class="space-y-6">
                    <input type="range" id="c-numeric-slider" min="${q.min}" max="${q.max}" step="${q.step || 1}" value="${defaultValue}" class="w-full h-3 bg-slate-200 rounded-lg appearance-none cursor-pointer">
                    <div class="flex justify-between text-slate-800 text-sm font-bold">
                        <span>${q.min}</span>
                        <span id="c-numeric-value" class="bg-indigo-100 px-4 py-2 rounded-full font-black">${defaultValue}</span>
                        <span>${q.max}</span>
                    </div>
                </div>
            `;
        }
        
        container.innerHTML = sliderHtml + btnHtml;
        
        const slider = document.getElementById('c-numeric-slider');
        const display = document.getElementById('c-numeric-value');
        slider.addEventListener('input', () => {
            display.innerText = slider.value;
        });
        
        document.getElementById('sticky-btn-container').classList.remove('hidden');
        document.getElementById('btn-submit-live-unified').onclick = window.submitLiveNumericConfirm;
    }
};

window.submitLiveFinal = async (isCorrect) => {
    if (!user || lastAnsweredIdx === liveActiveQIdx) return;
    lastAnsweredIdx = liveActiveQIdx;
    liveScore += isCorrect ? (window.currentLiveQ.points || 1) : 0;

    document.getElementById('client-question').classList.add('hidden');
    document.getElementById('client-waiting').classList.remove('hidden');
    document.getElementById('waiting-status-text').innerHTML = `
        <div class="flex flex-col items-center gap-4">
            <div class="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            <span>Изпращане на отговор...</span>
        </div>
    `;

    const updatePayload = {
        score: liveScore,
        lastAnsweredIdx: liveActiveQIdx,
        lastResult: isCorrect
    };
    const explanationText = window.currentLiveQ?.explanation ? String(window.currentLiveQ.explanation).trim() : '';
    const reactionMs = window.currentLiveQStartedAtMs ? Math.max(0, Date.now() - window.currentLiveQStartedAtMs) : null;
    updatePayload[`answers.${liveActiveQIdx}`] = isCorrect;
    if (reactionMs !== null) updatePayload[`reactionMs.${liveActiveQIdx}`] = reactionMs;

    try {
        if (currentParticipantRef) {
            await updateDoc(currentParticipantRef, updatePayload);
            const baseMsg = isCorrect ? "ВЕРЕН ОТГОВОР! ✨" : "ГРЕШЕН ОТГОВОР... ❌";
            document.getElementById('waiting-status-text').innerHTML = explanationText
                ? `<div class="space-y-2"><div>${baseMsg}</div><div class="text-xs text-amber-200 font-bold">💡 ${explanationText}</div></div>`
                : baseMsg;
        }
    } catch (e) {
        console.error(e);
        document.getElementById('waiting-status-text').innerText = "Грешка при изпращане!";
        setTimeout(() => window.submitLiveFinal(isCorrect), 2000);
    }
};

const stopSpeechReader = () => {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
};

const readQuestionWithSpeech = (text) => {
    if (!sopModeEnabled || !('speechSynthesis' in window)) return;
    try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'bg-BG';
        u.rate = 0.9;
        u.pitch = 1;
        window.speechSynthesis.speak(u);
    } catch (e) {
        console.error('Speech reader failed:', e);
    }
};

// --- SOLO LOGIC ---
window.startIndividual = async () => {
    const pinCode = document.getElementById('ind-quiz-code').value.trim();
    const decoded = window.decodeQuizCode(pinCode);
    if (!decoded) return window.showMessage("Невалиден код на урок.", 'error');
    isDiscussionMode = !!document.getElementById('ind-discussion-mode')?.checked;
    sopModeEnabled = !!document.getElementById('ind-sop-mode')?.checked;
    const name = isDiscussionMode ? "Обсъждане" : prompt("Вашето име:");
    if (!name) return;
    const normalizedQuiz = normalizeQuizPayload(decoded);
    if (!normalizedQuiz) return window.showMessage("Кодът е невалиден или непълен (липсва видео/въпроси).", 'error');
    studentNameValue = name; currentQuiz = normalizedQuiz;
    currentQuizOwnerId = await window.resolveTeacherUidFromCode(decoded);
    if (!currentQuizOwnerId) {
        return window.showMessage("Кодът не е свързан еднозначно с учител. Генерирайте нов код от профила на учителя.", 'error');
    }

    if (!auth.currentUser) {
        try {
            await signInAnonymously(auth);
        } catch(e) { console.error("Auto-login failed", e); }
    }

    window.switchScreen('solve');
    scoreCount = 0; currentQIndex = -1; soloGameFinished = false;
    window.initSolvePlayer();
};

window.initSolvePlayer = () => {
    if (!window.YT || !window.YT.Player) {
        window.showMessage("Изчакайте YouTube API...", "error");
        setTimeout(window.initSolvePlayer, 1000);
        return;
    }
    document.getElementById('solve-player-container').innerHTML = '<div id="solve-player"></div>';
    solvePlayer = new YT.Player('solve-player', {
        videoId: currentQuiz.v, width: '100%', height: '100%',
        playerVars: { 'autoplay': 1, 'controls': 1, 'rel': 0, 'playsinline': 1, 'origin': window.location.origin },
        events: { 'onStateChange': (e) => {
            if (e.data === YT.PlayerState.ENDED) {
                window.finishSoloGame();
            }
            if (e.data === YT.PlayerState.PLAYING) {
                const m = setInterval(() => {
                    if (!solvePlayer?.getCurrentTime) return;
                    const cur = Math.floor(solvePlayer.getCurrentTime());
                    const duration = solvePlayer.getDuration();

                    const qIdx = currentQuiz.q.findIndex((q, i) => cur >= q.time && i > currentQIndex);
                    if (qIdx !== -1) {
                        currentQIndex = qIdx;
                        window.triggerSoloQuestion(currentQuiz.q[qIdx]);
                    }

                    if (duration > 0 && cur >= duration - 1) {
                        clearInterval(m);
                        window.finishSoloGame();
                    }
                }, 500);
                activeIntervals.push(m);
            }
        }}
    });
};

// --- SOLO CONFIRM HELPERS (single/boolean) ---
window.soloPendingAnswer = null;
window.selectSoloPending = (val, btnEl) => {
    window.soloPendingAnswer = val;
    try {
        // clear selection styling
        document.querySelectorAll('#ind-overlay-options .solo-choice').forEach(b => {
            b.classList.remove('ring-4','ring-indigo-400','bg-white/30');
        });
        if (btnEl) btnEl.classList.add('ring-4','ring-indigo-400','bg-white/30');
        const cbtn = document.getElementById('solo-confirm-btn');
        if (cbtn) {
            cbtn.classList.remove('opacity-60','pointer-events-none');
            cbtn.classList.add('opacity-100');
        }
    } catch(e) {}
};
window.confirmSoloPending = () => {
    const v = window.soloPendingAnswer;
    if (v === null || v === undefined) return;
    window.soloPendingAnswer = null;
    // prevent double submit
    try {
        const cbtn = document.getElementById('solo-confirm-btn');
        if (cbtn) {
            cbtn.classList.add('opacity-60','pointer-events-none');
            cbtn.classList.remove('opacity-100');
        }
    } catch(e) {}
    window.submitSolo(v);
};

window.triggerSoloQuestion = (q) => {
    solvePlayer?.pauseVideo();
    const overlay = document.getElementById('ind-overlay');
    overlay.classList.remove('hidden'); overlay.classList.add('flex');
    const questionEl = document.getElementById('ind-overlay-q-text');
    questionEl.innerText = q.text;
    questionEl.classList.toggle('text-3xl', sopModeEnabled);
    questionEl.classList.toggle('sm:text-6xl', sopModeEnabled);
    questionEl.classList.toggle('text-xl', !sopModeEnabled);
    questionEl.classList.toggle('sm:text-4xl', !sopModeEnabled);
    readQuestionWithSpeech(q.text);
    const container = document.getElementById('ind-overlay-options');
    container.innerHTML = '';

    if (q.type === 'single') {
        window.soloPendingAnswer = null;
        container.innerHTML = q.options.map((o, i) => `<button onclick="window.selectSoloPending(${i}, this)" class="solo-choice w-full p-4 text-left bg-white/10 border border-white/20 rounded-2xl font-black text-white hover:bg-white/20 transition-all text-sm">${o}</button>`).join('')
            + `<button id="solo-confirm-btn" onclick="window.confirmSoloPending()" class="w-full mt-4 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-xs opacity-60 pointer-events-none">Потвърди избора</button>`;
    } else if (q.type === 'multiple') {
        container.innerHTML = q.options.map((o, i) => `<label class="flex items-center gap-4 w-full p-4 bg-white/10 border border-white/20 rounded-2xl font-black text-white cursor-pointer text-sm mb-2"><input type="checkbox" name="s-multiple" value="${i}" class="w-5 h-5"> ${o}</label>`).join('') + `<button onclick="window.submitSoloMultiple()" class="w-full mt-4 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-xs">Изпрати</button>`;
    } else if (q.type === 'boolean') {
        window.soloPendingAnswer = null;
        container.innerHTML = `<div class="grid grid-cols-2 gap-4">
            <button onclick="window.selectSoloPending(true, this)" class="solo-choice p-10 bg-emerald-500/80 rounded-3xl font-black border border-white/30 text-white text-2xl">ДА</button>
            <button onclick="window.selectSoloPending(false, this)" class="solo-choice p-10 bg-rose-500/80 rounded-3xl font-black border border-white/30 text-white text-2xl">НЕ</button>
        </div>` + `<button id="solo-confirm-btn" onclick="window.confirmSoloPending()" class="w-full mt-4 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-xs opacity-60 pointer-events-none">Потвърди избора</button>`;
    } else if (q.type === 'open') {
        container.innerHTML = `<input type="text" id="s-open-answer" placeholder="Отговор..." class="w-full p-6 bg-white/10 border border-white/20 rounded-2xl font-black text-white text-xl outline-none mb-4 text-center"><button onclick="window.submitSoloOpen()" class="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-xs">Изпрати</button>`;
    } else if (q.type === 'ordering') {
        window.userOrderSequence = [];
        const shuffled = q.options.map((o, i) => ({o, i})).sort(() => Math.random() - 0.5);
        container.innerHTML = `
            <div id="solo-ordering-pool" class="space-y-2">${shuffled.map(item => `<button onclick="window.pickSoloOrder(this, ${item.i})" class="solo-order-item w-full p-4 text-left bg-white/10 border border-white/20 rounded-2xl font-black text-white">${item.o}</button>`).join('')}</div>
            <div id="solo-ordering-result" class="min-h-[48px] border-t border-white/20 mt-4 pt-4 flex flex-wrap gap-2"></div>
            <div class="grid grid-cols-2 gap-3">
                <button onclick="window.clearSoloOrdering()" class="py-3 bg-slate-600 rounded-xl font-black text-xs">Изчисти</button>
                <button onclick="window.submitSoloOrdering()" class="py-3 bg-indigo-600 rounded-xl font-black text-xs">Изпрати</button>
            </div>`;
    } else if (q.type === 'timeline') {
        window.userOrderSequence = [];
        const shuffled = q.options.map((o, i) => ({o, i})).sort(() => Math.random() - 0.5);
        container.innerHTML = `
            <div class="mb-4 p-3 bg-amber-500/20 border border-amber-400 rounded-xl text-amber-200 font-black text-xs flex items-center gap-2">
                <i data-lucide="clock" class="w-4 h-4"></i> Подредете събитията в хронологичен ред
            </div>
            <div id="solo-timeline-pool" class="space-y-2">${shuffled.map(item => `<button onclick="window.pickSoloTimeline(this, ${item.i})" class="solo-timeline-item w-full p-4 text-left bg-amber-500/10 border border-amber-400/30 rounded-2xl font-black text-amber-100 hover:bg-amber-500/20 transition-all">${item.o}</button>`).join('')}</div>
            <div id="solo-timeline-result" class="min-h-[48px] border-t border-amber-400/30 mt-4 pt-4 flex flex-wrap gap-2"></div>
            <div class="grid grid-cols-2 gap-3 mt-4">
                <button onclick="window.clearSoloTimeline()" class="py-3 bg-slate-600 rounded-xl font-black text-xs">Изчисти</button>
                <button onclick="window.submitSoloTimeline()" class="py-3 bg-amber-600 rounded-xl font-black text-xs">Изпрати</button>
            </div>`;
        if (window.lucide) lucide.createIcons();
    } else if (q.type === 'numeric' || q.type === 'timeline-slider') {
        const defaultValue = (q.min + q.max) / 2;
        const isTimeline = (q.type === 'timeline-slider');
        
        let sliderHtml = '';
        if (isTimeline) {
            const years = [];
            const step = Math.max(1, Math.ceil((q.max - q.min) / 5));
            for (let y = q.min; y <= q.max; y += step) {
                years.push(Math.round(y));
            }
            if (years[years.length-1] < q.max) years.push(Math.round(q.max));
            
            sliderHtml = `
                <div class="relative pt-6 pb-2">
                    <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-amber-300 via-amber-500 to-amber-700 rounded-full"></div>
                    <div class="flex justify-between text-[10px] font-bold text-amber-200 px-1">
                        ${years.map(y => `<span>${y}</span>`).join('')}
                    </div>
                    <input type="range" id="s-numeric-slider" min="${q.min}" max="${q.max}" step="${q.step || 1}" value="${defaultValue}" 
                        class="w-full h-2 bg-transparent accent-amber-500 appearance-none cursor-pointer mt-2">
                    <div class="flex justify-between text-white text-sm font-bold mt-2">
                        <span>${q.min}</span>
                        <span id="s-numeric-value" class="bg-amber-600 px-6 py-2 rounded-full font-black shadow-lg">${defaultValue}</span>
                        <span>${q.max}</span>
                    </div>
                </div>
            `;
        } else {
            sliderHtml = `
                <div class="space-y-6">
                    <input type="range" id="s-numeric-slider" min="${q.min}" max="${q.max}" step="${q.step || 1}" value="${defaultValue}" class="w-full h-3 bg-white/20 rounded-lg appearance-none cursor-pointer">
                    <div class="flex justify-between text-white text-sm font-bold">
                        <span>${q.min}</span>
                        <span id="s-numeric-value" class="bg-indigo-600 px-4 py-2 rounded-full font-black">${defaultValue}</span>
                        <span>${q.max}</span>
                    </div>
                </div>
            `;
        }
        
        container.innerHTML = sliderHtml + `
            <button onclick="window.submitSoloNumeric()" class="w-full mt-6 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-xs">Изпрати</button>
        `;
        
        const slider = document.getElementById('s-numeric-slider');
        const display = document.getElementById('s-numeric-value');
        slider.addEventListener('input', () => {
            display.innerText = slider.value;
        });
    }
};

window.submitSoloNumeric = () => {
    const slider = document.getElementById('s-numeric-slider');
    if (!slider) return;
    const answer = parseFloat(slider.value);
    const q = currentQuiz.q[currentQIndex];
    const correct = q.correct;
    const tolerance = q.tolerance || 0;
    const isCorrect = Math.abs(answer - correct) <= tolerance;
    
// --- ANSWER NORMALIZATION (fix: single/boolean/multiple not scoring) ---
const _toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const _toBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'да' || t === 'yes') return true;
    if (t === 'false' || t === 'не' || t === 'no') return false;
    const n = _toNum(t);
    if (n !== null) return n === 1;
  }
  return null;
};
const _normStr = (v) => String(v ?? '').trim().toLowerCase();
const _normArrNums = (arr) => (Array.isArray(arr) ? arr : []).map(x => _toNum(x)).filter(x => x !== null).sort((a,b)=>a-b);

window.submitSoloFinal(isCorrect);
};

window.submitSoloFinal = (isCorrect) => {
    const explanationText = currentQuiz?.q?.[currentQIndex]?.explanation ? String(currentQuiz.q[currentQIndex].explanation).trim() : '';
    if (isCorrect) scoreCount += (currentQuiz.q[currentQIndex].points || 1);
    if (explanationText) {
        const label = isCorrect ? "✅ Вярно." : "❌ Невярно.";
        window.showMessage(`${label} 💡 ${explanationText}`, isCorrect ? 'info' : 'error');
    }
    stopSpeechReader();
    document.getElementById('ind-overlay').classList.add('hidden');
    document.getElementById('ind-overlay').classList.remove('flex');
    setTimeout(() => { solvePlayer?.playVideo(); }, 500);
};

window.submitSoloMultiple = () => {
    const checked = Array.from(document.querySelectorAll('input[name="s-multiple"]:checked')).map(el => parseInt(el.value));
    const isCorrect = isAnswerCorrect(currentQuiz.q[currentQIndex], checked);
    window.submitSoloFinal(isCorrect);
};

window.submitSoloOpen = () => {
    const ans = document.getElementById('s-open-answer')?.value.trim().toLowerCase();
    window.submitSoloFinal(isAnswerCorrect(currentQuiz.q[currentQIndex], ans));
};

window.submitSolo = (v) => window.submitSoloFinal(isAnswerCorrect(currentQuiz.q[currentQIndex], v));

window.submitSoloOrdering = () => {
    const q = currentQuiz.q[currentQIndex];
    if (!Array.isArray(window.userOrderSequence) || window.userOrderSequence.length !== q.options.length) return window.showMessage('Подредете всички елементи!', 'error');
    const isCorrect = isAnswerCorrect(q, window.userOrderSequence);
    window.submitSoloFinal(isCorrect);
};

window.pickSoloOrder = (el, originalIdx) => {
    if (!Array.isArray(window.userOrderSequence)) window.userOrderSequence = [];
    if (window.userOrderSequence.includes(originalIdx)) return;
    window.userOrderSequence.push(originalIdx);
    el.classList.add('opacity-40', 'pointer-events-none');
    const result = document.getElementById('solo-ordering-result');
    if (result) {
        const chip = document.createElement('div');
        chip.className = 'px-3 py-1 rounded-lg bg-indigo-600 text-white text-xs font-black';
        chip.innerText = `${window.userOrderSequence.length}. ${el.innerText}`;
        result.appendChild(chip);
    }
};

window.clearSoloOrdering = () => {
    window.userOrderSequence = [];
    const result = document.getElementById('solo-ordering-result');
    if (result) result.innerHTML = '';
    document.querySelectorAll('.solo-order-item').forEach((btn) => btn.classList.remove('opacity-40', 'pointer-events-none'));
};

window.pickSoloTimeline = (el, originalIdx) => {
    if (!Array.isArray(window.userOrderSequence)) window.userOrderSequence = [];
    if (window.userOrderSequence.includes(originalIdx)) return;
    window.userOrderSequence.push(originalIdx);
    el.classList.add('opacity-40', 'pointer-events-none');
    const result = document.getElementById('solo-timeline-result');
    if (result) {
        const chip = document.createElement('div');
        chip.className = 'px-3 py-1 rounded-lg bg-amber-600 text-white text-xs font-black flex items-center gap-1';
        chip.innerHTML = `<i data-lucide="clock" class="w-3 h-3"></i> ${window.userOrderSequence.length}. ${el.innerText}`;
        result.appendChild(chip);
        if (window.lucide) lucide.createIcons();
    }
};

window.clearSoloTimeline = () => {
    window.userOrderSequence = [];
    const result = document.getElementById('solo-timeline-result');
    if (result) result.innerHTML = '';
    document.querySelectorAll('.solo-timeline-item').forEach((btn) => btn.classList.remove('opacity-40', 'pointer-events-none'));
};

window.submitSoloTimeline = () => {
    const q = currentQuiz.q[currentQIndex];
    if (!Array.isArray(window.userOrderSequence) || window.userOrderSequence.length !== q.options.length) {
        return window.showMessage('Подредете всички събития!', 'error');
    }
    const isCorrect = isAnswerCorrect(q, window.userOrderSequence);
    window.submitSoloFinal(isCorrect);
};

window.finishSoloGame = async () => {
    if (soloGameFinished) return;
    soloGameFinished = true;

    stopSpeechReader();
    window.switchScreen('finish');
    const totalPossible = currentQuiz.q.reduce((acc, q) => acc + (q.points || 1), 0);
    const scoreText = `${scoreCount} / ${totalPossible}`;
    const finalScoreEl = document.getElementById('res-score');
    if (finalScoreEl) finalScoreEl.innerText = scoreText;

    const currentUser = auth.currentUser || user;
    if (isDiscussionMode) {
        window.showMessage("Режим обсъждане: резултатът не се записва в облака.", "info");
        return;
    }
    if (currentUser) {
        const resId = `${currentUser.uid}_${currentQuiz.v.replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`;
        if (!currentQuizOwnerId) {
            window.showMessage("Кодът няма валиден собственик (учител). Резултатът не е записан.", "error");
            return;
        }
        try {
            await setDoc(doc(getTeacherSoloResultsCollection(currentQuizOwnerId), resId), {
                studentName: studentNameValue,
                quizTitle: currentQuiz.title || "Индивидуален тест",
                score: scoreText,
                timestamp: serverTimestamp(),
                userId: currentUser.uid,
                teacherOwnerId: currentQuizOwnerId,
                teacherOwnerEmail: currentQuiz.ownerEmail || currentQuiz.teacherEmail || null
            });
        } catch(e) {
            if(e.code === 'permission-denied') window.showRulesHelpModal();
        }
    }
};

// --- EDITOR ENGINE ---
const extractYouTubeVideoId = (input) => {
    if (!input) return null;
    const value = String(input).trim();

    const directIdMatch = value.match(/^[a-zA-Z0-9_-]{11}$/);
    if (directIdMatch) return directIdMatch[0];

    try {
        const parsed = new URL(value);
        const host = parsed.hostname.replace(/^www\./, '');

        if (host === 'youtu.be') {
            const id = parsed.pathname.split('/').filter(Boolean)[0];
            if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
        }

        if (host.endsWith('youtube.com')) {
            const fromQuery = parsed.searchParams.get('v');
            if (fromQuery && /^[a-zA-Z0-9_-]{11}$/.test(fromQuery)) return fromQuery;

            const parts = parsed.pathname.split('/').filter(Boolean);
            const key = parts[0];
            const candidate = parts[1];
            if (["embed", "v", "shorts", "live"].includes(key) && candidate && /^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
                return candidate;
            }
        }
    } catch (_) {
        // not a full URL -> fallback regex below
    }

    return value.match(/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/shorts\/|\/live\/|\/watch\?v=|\/watch\?.+&v=))([\w-]{11})/)?.[1] || null;
};

window.loadEditorVideo = (isEdit = false) => {
    const url = document.getElementById('yt-url')?.value;
    const id = extractYouTubeVideoId(url);
    if (!id) return window.showMessage("Невалиден YouTube линк или ID.", "error");

    if (!window.YT || !window.YT.Player) {
        window.showMessage("Изчакайте YouTube API...", "error");
        setTimeout(() => window.loadEditorVideo(isEdit), 1000);
        return;
    }

    currentVideoId = id;
    document.getElementById('editor-view').classList.remove('hidden');
    document.getElementById('editor-player-container').innerHTML = '<div id="player"></div>';
    player = new YT.Player('player', { videoId: id, playerVars: { 'origin': window.location.origin, 'playsinline': 1, 'rel': 0 }, events: { 'onReady': () => {
        const i = setInterval(() => { if (player?.getCurrentTime) document.getElementById('timer').innerText = formatTime(player.getCurrentTime()); }, 500);
        activeIntervals.push(i);
    }}});
    if (!isEdit) { questions = []; editingQuizId = null; }
    renderEditorList();
};

window.openQuestionModal = () => {
    if (!player || typeof player.getCurrentTime !== 'function') return window.showMessage("Заредете видео!", "error");
    editingQuestionIndex = null;
    document.getElementById('m-title-text').innerText = "Нов въпрос";
    document.getElementById('m-text').value = '';
    const explanationInput = document.getElementById('m-explanation');
    if (explanationInput) explanationInput.value = '';
    document.getElementById('modal-q').classList.remove('hidden');
    document.getElementById('modal-q').classList.add('flex');
    document.getElementById('m-time').innerText = formatTime(player.getCurrentTime());
    window.updateModalFields();
};

window.addQuestionOptionRow = (value = '', checked = false) => {
    const type = document.getElementById('m-type').value;
    const list = document.getElementById('m-opts-list');
    if (!list) return;
    const inputType = type === 'single' ? 'radio' : (type === 'multiple' ? 'checkbox' : 'hidden');
    const row = document.createElement('div');
    row.className = 'option-row flex items-center gap-2 mb-2 bg-slate-50 p-3 rounded-2xl border';
    row.innerHTML = `
        <input type="${inputType}" name="m-correct" class="w-5 h-5 ${type === 'ordering' || type === 'timeline' ? 'hidden' : ''}" ${checked ? 'checked' : ''}>
        <input type="text" value="${value}" placeholder="Текст на отговор" class="option-input flex-1 bg-transparent font-black outline-none text-xs sm:text-sm">
        <button type="button" onclick="this.closest('.option-row')?.remove()" class="text-rose-500 text-xs font-black px-2">✕</button>
    `;
    list.appendChild(row);
};

window.updateModalFields = () => {
    const type = document.getElementById('m-type').value;
    const container = document.getElementById('m-opts-container');
    container.innerHTML = '';

    if (type === 'single' || type === 'multiple' || type === 'ordering' || type === 'timeline') {
        container.innerHTML = `
            <div id="m-opts-list"></div>
            <button type="button" onclick="window.addQuestionOptionRow()" class="w-full py-3 border-2 border-dashed rounded-2xl text-[10px] font-black uppercase text-slate-400 mt-2">+ Добави отговор</button>
        `;
        window.addQuestionOptionRow();
        window.addQuestionOptionRow();
    } else if (type === 'boolean') {
        container.innerHTML = `<div class="grid grid-cols-2 gap-4 mt-2"><label class="flex items-center justify-center gap-4 p-4 bg-slate-50 rounded-2xl border font-black cursor-pointer"><input type="radio" name="m-correct" value="true" checked> ДА</label><label class="flex items-center justify-center gap-4 p-4 bg-slate-50 rounded-2xl border font-black cursor-pointer"><input type="radio" name="m-correct" value="false"> НЕ</label></div>`;
    } else if (type === 'open') {
        container.innerHTML = `<input type="text" id="m-open-correct" placeholder="Верен отговор..." class="w-full p-4 bg-slate-50 rounded-2xl border font-black outline-none text-sm">`;
    } else if (type === 'numeric' || type === 'timeline-slider') {
        container.innerHTML = `
            <div class="space-y-4">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-[10px] font-bold text-slate-400 uppercase">Мин. стойност</label>
                        <input type="number" id="m-numeric-min" value="0" class="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-black text-sm focus:border-indigo-600 focus:outline-none">
                    </div>
                    <div>
                        <label class="text-[10px] font-bold text-slate-400 uppercase">Макс. стойност</label>
                        <input type="number" id="m-numeric-max" value="100" class="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-black text-sm focus:border-indigo-600 focus:outline-none">
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-[10px] font-bold text-slate-400 uppercase">Стъпка</label>
                        <input type="number" id="m-numeric-step" value="1" min="0.1" step="any" class="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-black text-sm focus:border-indigo-600 focus:outline-none">
                    </div>
                    <div>
                        <label class="text-[10px] font-bold text-slate-400 uppercase">Точен отговор</label>
                        <input type="number" id="m-numeric-correct" value="50" class="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-black text-sm focus:border-indigo-600 focus:outline-none">
                    </div>
                </div>
                <div>
                    <label class="text-[10px] font-bold text-slate-400 uppercase">Толеранс (±)</label>
                    <input type="number" id="m-numeric-tolerance" value="0" min="0" step="any" class="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-black text-sm focus:border-indigo-600 focus:outline-none">
                    <p class="text-[9px] text-slate-400 mt-1">Ако толерансът е 2, то отговор 48-52 е верен.</p>
                </div>
            </div>
        `;
    }
};

window.saveQuestion = () => {
    const text = document.getElementById('m-text').value.trim();
    const type = document.getElementById('m-type').value;
    if (!text) return window.showMessage("Въведете текст!", "error");
    let timeVal = editingQuestionIndex !== null ? questions[editingQuestionIndex].time : Math.floor(player.getCurrentTime());
    let qData = { time: timeVal, text, type, points: parseInt(document.getElementById('m-points').value) || 1 };
    const explanation = document.getElementById('m-explanation')?.value.trim();
    if (explanation) qData.explanation = explanation;

    if (type === 'single' || type === 'multiple' || type === 'ordering' || type === 'timeline') {
        const rows = Array.from(document.querySelectorAll('#m-opts-list .option-row'));
        const entries = rows.map((row) => ({
            text: row.querySelector('.option-input')?.value.trim() || '',
            checked: !!row.querySelector('input[name="m-correct"]')?.checked
        })).filter((e) => e.text);
        if (entries.length < 2) return window.showMessage("Добавете поне 2 отговора!", "error");
        qData.options = entries.map((e) => e.text);

        if (type === 'single' || type === 'multiple') {
            const correct = [];
            entries.forEach((entry, idx) => {
                if (entry.checked) correct.push(idx);
            });
            if (correct.length === 0) return window.showMessage("Маркирайте верен отговор!", "error");
            if (type === 'single') qData.correct = correct[0];
            else qData.correct = correct;
        } else {
            qData.correct = qData.options.map((_, i) => i);
        }
    } else if (type === 'boolean') {
        qData.correct = document.querySelector('input[name="m-correct"]:checked').value === 'true';
    } else if (type === 'open') {
        qData.correct = document.getElementById('m-open-correct')?.value.trim().toLowerCase();
    } else if (type === 'numeric' || type === 'timeline-slider') {
        const min = parseFloat(document.getElementById('m-numeric-min').value);
        const max = parseFloat(document.getElementById('m-numeric-max').value);
        const step = parseFloat(document.getElementById('m-numeric-step').value);
        const correct = parseFloat(document.getElementById('m-numeric-correct').value);
        const tolerance = parseFloat(document.getElementById('m-numeric-tolerance').value) || 0;

        qData.min = min;
        qData.max = max;
        qData.step = step;
        qData.correct = correct;
        qData.tolerance = tolerance;
    }

    if (editingQuestionIndex !== null) {
        questions[editingQuestionIndex] = qData;
    } else {
        questions.push(qData);
    }
    questions.sort((a,b) => a.time - b.time);
    renderEditorList();
    document.getElementById('modal-q').classList.add('hidden');
    editingQuestionIndex = null;
};

window.editQuestionContent = (index) => {
    const q = questions[index];
    editingQuestionIndex = index;
    document.getElementById('m-title-text').innerText = "Редактиране";
    document.getElementById('m-text').value = q.text;
    document.getElementById('m-type').value = q.type;
    document.getElementById('m-points').value = q.points || 1;
    const explanationInput = document.getElementById('m-explanation');
    if (explanationInput) explanationInput.value = q.explanation || '';
    document.getElementById('m-time').innerText = formatTime(q.time);
    document.getElementById('modal-q').classList.remove('hidden');
    document.getElementById('modal-q').classList.add('flex');
    window.updateModalFields();

    if (q.type === 'single' || q.type === 'multiple' || q.type === 'ordering' || q.type === 'timeline') {
        const list = document.getElementById('m-opts-list');
        if (list) list.innerHTML = '';
        (q.options || []).forEach((opt, i) => {
            const corrects = Array.isArray(q.correct) ? q.correct : [q.correct];
            const checked = (q.type === 'single' || q.type === 'multiple') && corrects.includes(i);
            window.addQuestionOptionRow(opt, checked);
        });
    } else if (q.type === 'boolean') {
        const boolInput = document.querySelector(`input[name="m-correct"][value="${q.correct}"]`);
        if (boolInput) boolInput.checked = true;
    } else if (q.type === 'open') {
        const openCorrect = document.getElementById('m-open-correct');
        if (openCorrect) openCorrect.value = q.correct || '';
    } else if (q.type === 'numeric' || q.type === 'timeline-slider') {
        const minInput = document.getElementById('m-numeric-min');
        const maxInput = document.getElementById('m-numeric-max');
        const stepInput = document.getElementById('m-numeric-step');
        const correctInput = document.getElementById('m-numeric-correct');
        const toleranceInput = document.getElementById('m-numeric-tolerance');
        
        if (minInput) minInput.value = q.min ?? 0;
        if (maxInput) maxInput.value = q.max ?? 100;
        if (stepInput) stepInput.value = q.step ?? 1;
        if (correctInput) correctInput.value = q.correct ?? 50;
        if (toleranceInput) toleranceInput.value = q.tolerance ?? 0;
    }
};

function renderEditorList() {
    const list = document.getElementById('q-list'); if (!list) return;
    list.innerHTML = questions.map((q, i) => `
        <div class="p-3 bg-white rounded-xl mb-2 flex flex-col gap-2 border shadow-sm">
            <div class="flex justify-between items-center">
                <div class="flex items-center gap-1">
                    <button onclick="window.adjustTime(${i}, -1)" class="w-6 h-6 flex items-center justify-center bg-slate-100 rounded-md hover:bg-slate-200 text-xs font-black">-</button>
                    <span class="text-indigo-600 text-[10px] font-black bg-indigo-50 px-2 py-0.5 rounded-lg min-w-[45px] text-center">${formatTime(q.time)}</span>
                    <button onclick="window.adjustTime(${i}, 1)" class="w-6 h-6 flex items-center justify-center bg-slate-100 rounded-md hover:bg-slate-200 text-xs font-black">+</button>
                </div>
                <div class="flex gap-1">
                    <button onclick="window.editQuestionContent(${i})" title="Текст" class="text-indigo-400 p-1 hover:text-indigo-600"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
                    <button onclick="window.deleteEditorQuestion(${i})" title="Изтрий" class="text-rose-400 p-1 hover:text-rose-600"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                </div>
            </div>
            <div class="text-slate-700 font-black text-xs truncate border-t pt-2 mt-1 opacity-80">${q.text}</div>
            <div class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                ${q.type === 'numeric' ? '🔢 Числов отговор' : ''}
                ${q.type === 'timeline-slider' ? '📅 Хронологичен плъзгач' : ''}
                ${q.type === 'timeline' ? '📅 Хронология (подреждане)' : ''}
                ${q.type === 'single' ? '✅ Един верен' : ''}
                ${q.type === 'multiple' ? '🔀 Множество верни' : ''}
                ${q.type === 'boolean' ? '✓✓ Вярно/Невярно' : ''}
                ${q.type === 'open' ? '✏️ Отворен отговор' : ''}
                ${q.type === 'ordering' ? '↕️ Подреждане' : ''}
            </div>
            ${q.explanation ? `<div class="text-[10px] text-amber-700 font-bold bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">💡 ${q.explanation}</div>` : ''}
        </div>
    `).join('') || '<p class="text-center text-slate-300 italic py-6 text-xs">Добавете въпроси.</p>';
    if (window.lucide) lucide.createIcons();
}

window.adjustTime = (index, delta) => {
    questions[index].time = Math.max(0, questions[index].time + delta);
    questions.sort((a,b) => a.time - b.time);
    renderEditorList();
    if (player && typeof player.seekTo === 'function') player.seekTo(questions[index].time, true);
};

window.deleteEditorQuestion = (i) => { if (confirm("Изтриване на въпроса?")) { questions.splice(i,1); renderEditorList(); } };

window.saveQuizToLibrary = async () => {
    if (!user) return;
    let title = "";
    const existing = editingQuizId ? myQuizzes.find(x => x.id === editingQuizId) : null;
    title = prompt("Име на урока:", existing?.title || "");
    if (title === null) return;
    if (!title) title = existing?.title || "Без име";
    window.showMessage("Записване...");
    try {
        const data = { title, v: currentVideoId, questions, updatedAt: serverTimestamp() };
        if (!editingQuizId) data.createdAt = serverTimestamp();
        if (editingQuizId) await updateDoc(doc(getTeacherQuizzesCollection(user.uid), editingQuizId), data);
        else await addDoc(getTeacherQuizzesCollection(user.uid), data);
        window.showMessage("Урокът е запазен!", "info");
        editingQuizId = null;
        window.switchScreen('teacher-dashboard');
    } catch (e) {
        if (e.code === 'permission-denied') window.showRulesHelpModal();
        else window.showMessage("Грешка при запис!", "error");
    }
};

window.showShareCode = (id) => {
    const q = myQuizzes.find(x => x.id === id);
    const code = btoa(unescape(encodeURIComponent(JSON.stringify({
        v: q.v,
        q: q.questions,
        title: q.title,
        ownerId: user?.uid || null,
        teacherId: user?.uid || null,
        ownerEmail: user?.email || null,
        ownerEmailNormalized: user?.email?.toLowerCase?.() || null
    }))));
    document.getElementById('share-code-display').value = code;
    document.getElementById('modal-share').classList.remove('hidden'); document.getElementById('modal-share').classList.add('flex');
};

window.copyShareCode = () => {
    const input = document.getElementById('share-code-display');
    input.select(); document.execCommand('copy');
    window.showMessage("Копирано!");
};

window.editQuiz = (id) => {
    const qData = myQuizzes.find(x => x.id === id);
    if (!qData) return;
    editingQuizId = id;
    questions = JSON.parse(JSON.stringify(qData.questions || qData.q || []));
    currentVideoId = qData.v || qData.videoId || qData.youtubeId || '';
    window.switchScreen('create');
    if (!currentVideoId) return window.showMessage("Липсва видео в този урок. Добавете YouTube линк и запазете отново.", "error");
    document.getElementById('yt-url').value = `https://www.youtube.com/watch?v=${currentVideoId}`;
    window.loadEditorVideo(true);
};

window.deleteQuiz = async (id) => {
    if (!user) return;
    if (confirm("Изтриване на урока?")) {
        await deleteDoc(doc(getTeacherQuizzesCollection(user.uid), id));
        window.showMessage("Урокът е изтрит.", "info");
    }
};
// --- Разрешаване на достъп до хранилище (за блокирани ученици) ---
window.requestStorageAccess = async function() {
    try {
        if (document.requestStorageAccess) {
            await document.requestStorageAccess();
            window.showMessage("✅ Достъпът е разрешен! Моля, презаредете страницата.", "success");
            setTimeout(() => location.reload(), 2000);
        } else {
            window.showMessage("ℹ️ Вашият браузър не поддържа тази функция. Моля, разрешете 'Достъп до хранилище' от адресната лента.", "info");
        }
    } catch (e) {
        console.error(e);
        window.showMessage("❌ Неуспешен достъп. Моля, проверете настройките на браузъра си.", "error");
    }
};
// --- АДМИНИСТРАТОРСКИ ПАНЕЛ (само за admin) ---
window.openAdminPanel = async function() {
  try {
    window.showMessage("📊 Зареждам статистики...", "info");
    
    const getAdminStatsFunc = httpsCallable(functions, 'getAdminStats');
    const result = await getAdminStatsFunc();
    const stats = result.data;
    
    const message = `📊 АДМИН СТАТИСТИКИ:
━━━━━━━━━━━━━━━━━━━━━
👥 Учители: ${stats.totalTeachers}
📚 Уроци: ${stats.totalQuizzes}
📝 Соло резултати: ${stats.totalSoloResults}
🎬 Сесии на живо: ${stats.totalSessions}
👩‍🎓 Участници (общо): ${stats.totalParticipants}
━━━━━━━━━━━━━━━━━━━━━`;
    
    window.showMessage(message, "info", 15000); // показва се 15 секунди
  } catch (error) {
    console.error("Admin panel error:", error);
    window.showMessage("❌ Грешка: " + (error.message || "Нямате права"), "error");
  }
};
// --- YT API ---
window.onYouTubeIframeAPIReady = function() {
    isYTReady = true;
    console.log("YouTube API Ready");
};
