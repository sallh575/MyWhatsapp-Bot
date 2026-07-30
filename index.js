/**
 * بوت واتساب لقراءة إيصالات بنكك تلقائياً - النسخة المستقرة والمقاومة للأخطاء
 */

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const http = require('http');

const basePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(basePath, 'daily_data.json');

const ACCOUNTS = [
    { name: 'فاطمه حسين',        number: '1003092849630001' },
    { name: 'حمد خضر',          number: '0273051189600001' },
    { name: 'نمارق عبد الباقي', number: '1003092849830001' },
    { name: 'احمد عبد الباقي',  number: '1003077677580001' },
    { name: 'عبد الباقي صالح',  number: '1003092849400001' },
    { name: 'فتح الرحمن',       number: '1343036754470001' },
    { name: 'خضر صالح',         number: '0273090788480001' },
    { name: 'محمد فتح الرحمن',  number: '0563034575990001' },
];

// تهيئة Google Gemini API
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// -------------------- إدارة البيانات اليومية --------------------

function today() {
    return new Date().toLocaleDateString('en-GB');
}

function initData() {
    const data = { date: today(), totals: {}, processedTxIds: [] };
    ACCOUNTS.forEach(a => { data.totals[a.number] = 0; });
    return data;
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return initData();
    try {
        const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!d.processedTxIds) d.processedTxIds = [];
        return d;
    } catch {
        return initData();
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function resetIfNewDay(data) {
    if (data.date !== today()) {
        const fresh = initData();
        saveData(fresh);
        return fresh;
    }
    return data;
}

function buildReport(data) {
    let report = 'تقرير يوم ' + (data.date || today()) + '\n------------------\n';
    let grandTotal = 0;
    ACCOUNTS.forEach(acc => {
        const amount = data.totals[acc.number] || 0;
        grandTotal += amount;
        report += acc.name + '\n' + amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n\n';
    });
    report += '------------------\nالمجموع الكلي: ' + grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 });
    return report;
}

function creditAccount(acc, amount, txId) {
    let data = loadData();
    data = resetIfNewDay(data);
    data.totals[acc.number] = (data.totals[acc.number] || 0) + amount;
    if (txId) data.processedTxIds.push(txId);
    saveData(data);
    return data;
}

// -------------------- معالجة الأرقام والمطابقة --------------------

function normalizeDigits(str) {
    if (!str) return '';
    const easternToWestern = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
    return String(str).split('').map(ch => easternToWestern[ch] || ch).join('').replace(/[^0-9]/g, '');
}

function findMatchingAccount(fullText) {
    const cleanText = normalizeDigits(fullText);
    
    // 1. البحث برقم الحساب الكامل أو آخر 4 أرقام
    for (const acc of ACCOUNTS) {
        const target = normalizeDigits(acc.number);
        const shortTarget = target.slice(-4);
        if (cleanText.includes(target) || cleanText.includes(shortTarget)) {
            return acc;
        }
    }

    // 2. البحث باسم صاحب الحساب النصي
    for (const acc of ACCOUNTS) {
        if (fullText.includes(acc.name)) {
            return acc;
        }
    }

    return null;
}

function extractAmount(fullText) {
    // البحث عن المبالغ النقدية بأي صيغة داخل النص (مثل 1,320,000.00 أو 5000.00)
    const matches = fullText.match(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g) || fullText.match(/\b\d+\.\d{2}\b/g);
    if (matches && matches.length > 0) {
        let parsed = matches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n));
        parsed = parsed.filter(n => n > 0 && n < 100000000);
        if (parsed.length > 0) return Math.max(...parsed);
    }
    
    // بحث بديل لو لم يجد علامة عشرية دقيقة
    const fallbackMatches = fullText.match(/\b\d{4,}\b/g);
    if (fallbackMatches) {
        const numbers = fallbackMatches.map(n => parseFloat(n)).filter(n => n > 100 && n < 100000000);
        if (numbers.length > 0) return Math.max(...numbers);
    }

    return null;
}

// -------------------- قراءة الإيصال عبر Gemini بمرونة تامة --------------------

async function readReceiptWithGemini(buffer, mimetype) {
    if (!ai) throw new Error('GEMINI_API_KEY missing');

    const prompt = `أنت مساعد ذكي متخصص في قراءة إيصالات التحويل البنكي السودانية (بنكك - بنك الخرطوم).
قم بفحص الصورة بدقة واستخرج كل النصوص الظاهرة فيها، وخصوصاً:
1. أرقام الحسابات الموجودة (من حساب أو إلى حساب).
2. المبلغ المحول بدقة.
3. رقم العملية (Transaction ID).

اكتب كل ما تقرأه بوضوح وبدون أي قيود على التنسيق.`;

    const base64Data = buffer.toString('base64');

    const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [
            { inlineData: { mimeType: mimetype || 'image/jpeg', data: base64Data } },
            { text: prompt }
        ]
    });

    return response.text() || '';
}

// -------------------- حالة البوت --------------------

let botActive = false;
let targetGroupId = null;
let sock = null;
let isCronScheduled = false;

async function sendMsg(jid, text) {
    await sock.sendMessage(jid, { text });
}

function scheduleReport() {
    if (isCronScheduled) return;
    cron.schedule('0 0 * * *', async () => {
        if (!targetGroupId) return;
        let data = loadData();
        await sendMsg(targetGroupId, buildReport(data));
        saveData(initData());
    }, { timezone: 'Africa/Khartoum' });
    isCronScheduled = true;
}

// -------------------- تشغيل البوت --------------------

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(path.join(basePath, 'auth_info'));

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n========================================');
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
            console.log('========================================\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('البوت متصل وجاهز!');
            scheduleReport();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            if (!msg.key.remoteJid.endsWith('@g.us')) continue;

            const groupId = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

            if (text === '/بدا') {
                botActive = true;
                targetGroupId = groupId;
                await sendMsg(groupId, 'البوت شغال وجاهز لقراءة الإيصالات تلقائياً!');
                continue;
            }
            if (text === '/توقف') {
                botActive = false;
                await sendMsg(groupId, 'تم إيقاف البوت. ارسل /بدا لتشغيله.');
                continue;
            }
            if (text === '/تقرير') {
                let data = loadData();
                data = resetIfNewDay(data);
                await sendMsg(groupId, buildReport(data));
                continue;
            }
            if (text === '/الحسابات') {
                const list = ACCOUNTS.map((a, i) => (i + 1) + ') ' + a.name + ' - ...' + a.number.slice(-4)).join('\n');
                await sendMsg(groupId, 'الحسابات المسجّلة:\n' + list);
                continue;
            }

            if (!botActive || groupId !== targetGroupId) continue;

            const imgMsg = msg.message.imageMessage;
            if (!imgMsg) continue;

            await sendMsg(groupId, 'جاري قراءة الإيصال وتحليله...');

            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const geminiText = await readReceiptWithGemini(buffer, imgMsg.mimetype);

                console.log('محتوى النص المستخرج من الصورة:', geminiText);

                const matchedAcc = findMatchingAccount(geminiText);
                const amountVal = extractAmount(geminiText);

                if (matchedAcc && amountVal && amountVal > 0) {
                    const updated = creditAccount(matchedAcc, amountVal, null);
                    await sendMsg(groupId,
                        '✅ تم تسجيل التحويل بنجاح تلقائياً!\n' +
                        '👤 الحساب: ' + matchedAcc.name + '\n' +
                        '💰 المبلغ: ' + amountVal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                        '📊 إجمالي اليوم: ' + updated.totals[matchedAcc.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                    );
                } else {
                    await sendMsg(groupId, 
                        '⚠️ لم أتمكن من مطابقة الحساب أو المبلغ بدقة من الصورة.\n' +
                        'يمكنك الإضافة يدوياً بالأمر:\n/اضف <اسم الحساب> <المبلغ>'
                    );
                }

            } catch (err) {
                console.error('خطأ قراءة الإيصال:', err);
                await sendMsg(groupId, '❌ حدث خطأ تقني أثناء قراءة الصورة.');
            }
        }
    });
}

startBot();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('بوت الواتساب يعمل بنجاح على Railway!');
    res.end();
}).listen(PORT, () => {
    console.log(`Web Server is running on port ${PORT}`);
});
