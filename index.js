/**
 * بوت واتساب لتتبع التحويلات البنكية (بنكك - بنك الخرطوم) عبر OCR المحسّن
 */

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const http = require('http');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* اختياري */ }

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

// -------------------- تخزين البيانات اليومية --------------------

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

// -------------------- أدوات المطابقة والاستخراج --------------------

function normalizeDigits(str) {
    if (!str) return '';
    const easternToWestern = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
    return String(str).split('').map(ch => easternToWestern[ch] || ch).join('').replace(/[^0-9]/g, '');
}

function findAccountInText(text) {
    const cleanText = normalizeDigits(text);
    for (const acc of ACCOUNTS) {
        const targetNum = normalizeDigits(acc.number);
        if (cleanText.includes(targetNum)) return acc;
        // مطابقة جزئية للأرقام لو حصل خطأ بسيط في القراءة
        const p1 = targetNum.slice(0, 6);
        const p2 = targetNum.slice(-4);
        if (cleanText.includes(p1) && cleanText.includes(p2)) return acc;
    }
    return null;
}

function extractAmountFromText(text) {
    // البحث عن المبالغ بالصيغ المعتادة (مثال: 1,200.00 أو 5000.00)
    const matches = text.match(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g) || text.match(/\b\d+\.\d{2}\b/g);
    if (matches && matches.length > 0) {
        let parsed = matches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n));
        parsed = parsed.filter(n => n > 0 && n < 100000000);
        if (parsed.length > 0) return Math.max(...parsed);
    }
    return null;
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
        console.log('تم إرسال التقرير اليومي');
    }, { timezone: 'Africa/Khartoum' });
    isCronScheduled = true;
}

// -------------------- معالجة الصورة --------------------

async function handleReceiptImage(groupId, msg) {
    await sendMsg(groupId, 'جاري قراءة الإيصال...');

    let buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

    // تحسين الصورة عبر Sharp لو متوفرة لتسريع وقراءة أدق
    if (sharp) {
        try {
            buffer = await sharp(buffer)
                .grayscale()
                .normalize()
                .toBuffer();
        } catch (e) {
            // تجاهل الخطأ واستخدام البفر الأصلي
        }
    }

    const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'ara+eng');
    
    const account = findAccountInText(ocrText);
    const amount = extractAmountFromText(ocrText);

    if (!account || !amount) {
        await sendMsg(groupId, '⚠️ لم أتمكن من قراءة الحساب أو المبلغ بوضوح.\nاستخدم الأمر اليدوي:\n/اضف <اسم الحساب> <المبلغ>');
        return;
    }

    const updated = creditAccount(account, amount, null);
    await sendMsg(groupId,
        '✅ تم التسجيل بنجاح:\n' +
        '👤 الحساب: ' + account.name + '\n' +
        '💰 المبلغ: ' + amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
        '📊 إجمالي اليوم: ' + updated.totals[account.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
    );
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
            console.log('امسح QR Code من الرابط التالي عبر المتصفح:');
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
                await sendMsg(groupId, 'البوت شغال وجاهز لقراءة الإيصالات!');
                continue;
            }
            if (text === '/توقف') {
                botActive = false;
                await sendMsg(groupId, 'البوت وقف. ارسل /بدا لتشغيله.');
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

            if (text.startsWith('/اضف')) {
                const parts = text.split(/\s+/).filter(Boolean);
                if (parts.length >= 3) {
                    const amountArg = parseFloat(parts[parts.length - 1].replace(/,/g, ''));
                    const nameQuery = parts.slice(1, -1).join(' ').trim();
                    const nameDigits = normalizeDigits(nameQuery);

                    let candidates = ACCOUNTS.filter(a => a.name.includes(nameQuery) || nameQuery.includes(a.name));
                    if (candidates.length === 0 && nameDigits.length >= 4) {
                        candidates = ACCOUNTS.filter(a => a.number.includes(nameDigits));
                    }

                    if (candidates.length === 1 && !isNaN(amountArg) && amountArg > 0) {
                        const acc = candidates[0];
                        const updated = creditAccount(acc, amountArg, null);
                        await sendMsg(groupId,
                            '✅ تمت الإضافة اليدوية لحساب ' + acc.name + ': ' + amountArg.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                            '📊 إجمالي اليوم: ' + updated.totals[acc.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                        );
                    } else {
                        await sendMsg(groupId, 'تعذر إيجاد الحساب. الصيغة الصحيحة: /اضف <اسم الحساب> <المبلغ>');
                    }
                }
                continue;
            }

            const imgMsg = msg.message.imageMessage;
            if (!imgMsg) continue;

            try {
                await handleReceiptImage(groupId, msg);
            } catch (err) {
                console.error('خطأ:', err);
                await sendMsg(groupId, 'حدث خطأ أثناء قراءة الإيصال.');
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
