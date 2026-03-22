// ============================================
// VideoQuiz Ultimate - Helper функции
// ============================================

const BG_DATE_FORMAT_OPTIONS = {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
};

const decodeBase64Utf8 = (base64Value) => {
    const binary = atob(base64Value);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
};

// --- Време и дата ---
export const formatTime = (s) => {
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m < 10 ? '0' + m : m}:${r < 10 ? '0' + r : r}`;
};

export const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('bg-BG', BG_DATE_FORMAT_OPTIONS);
};

const getTimestampMs = (value) => {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value?.toDate === 'function') return value.toDate().getTime();
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
};

// --- Резултати и точки ---
export const parseScoreValue = (scoreText) => {
    if (!scoreText) return { score: 0, total: 0 };
    const parts = String(scoreText).split('/').map(s => parseInt(s.trim(), 10));
    const score = Number.isFinite(parts[0]) ? parts[0] : 0;
    const total = Number.isFinite(parts[1]) ? parts[1] : 0;
    return { score, total };
};

// --- Кодове и аватари ---
export const decodeQuizCode = (code) => {
    if (!code) return null;
    try {
        const cleanCode = code.trim().replace(/\s/g, '');
        return JSON.parse(decodeBase64Utf8(cleanCode));
    } catch (e) {
        try { return JSON.parse(atob(code.trim())); } catch(err) { return null; }
    }
};

export const AVATARS = ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄", "🐝", "🦋", "🐌", "🐞", "🐙", "🐬"];

// --- Времева помощна ---
export { getTimestampMs };

// --- 🎲 Разбъркване на масив (Фишър-Йейтс) ---
export const shuffleArray = (arr) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
};
// --- Генериране на QR код (връща data URL) ---
export const generateQRCode = (text, size = 200) => {
    if (typeof qrcode === 'undefined') {
        console.error('QR код библиотеката не е заредена!');
        return null;
    }
    try {
        const qr = qrcode(0, 'H');
        qr.addData(text);
        qr.make();
        const canvas = document.createElement('canvas');
        const moduleCount = qr.getModuleCount();
        const cellSize = Math.max(1, Math.floor(size / moduleCount));
        const canvasSize = moduleCount * cellSize;
        canvas.width = canvasSize;
        canvas.height = canvasSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        for (let row = 0; row < moduleCount; row++) {
            for (let col = 0; col < moduleCount; col++) {
                ctx.fillStyle = qr.isDark(row, col) ? '#000000' : '#ffffff';
                ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
            }
        }
        return canvas.toDataURL('image/png');
    } catch (error) {
        console.error('Грешка при генериране на QR код:', error);
        return null;
    }
};
