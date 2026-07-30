const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Tesseract = require('tesseract.js');
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

function today() {
    return new Date().toLocaleDateString('en-GB');
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return initData();
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return initData(); }
}

function initData() {
    const data = { date: today(), totals: {} };
    ACCOUNTS.forEach(a => { data.totals[a.number] = 0; });
    return data;
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

// دالة ذكية للبحث عن الحساب وتصحيح الأخطاء البصرية الشائعة
function findAccountSmart(text) {
    const cleanText = text.toLowerCase()
        .replace(/[oO]/g, '0')
        .replace(/[liI|]/g, '1')
        .replace(/[sS]/g, '5') // تصحيح حرف S الذي يقرأه البوت كـ 5
        .replace(/\s+/g, '');
        
    const justNumbers = cleanText.replace(/\D/g, ''); 

    for (const acc of ACCOUNTS) {
        const targetNum = acc.number.replace(/\s+/g, '');
        
        // 1. بحث دقيق
        if (cleanText.includes(targetNum)) return acc;
        
        // 2. بحث داخل الأرقام الصافية
        if (justNumbers.includes(targetNum)) return acc;
        
        // 3. بحث مرن (يتجاوز الأخطاء لو انمسح رقم من منتصف الحساب)
        const start = targetNum.slice(0, 8);
        const end = targetNum.slice(-4);
        if (cleanText.includes(start) && cleanText.includes(end)) return acc;
    }
    return null;
}

// دالة وحشية تستخرج المبلغ من أي إيصال (حتى لو أبيض أو بدون فواصل ألوف)
function extractAmountSmart(text) {
    // توحيد المسافات الخاطئة حول الفاصلة العشرية التي يسببها Tesseract
    let t = text.replace(/\s+\.\s+/g, '.').replace(/\s+\./g, '.').replace(/\.\s+/g, '.');
    
    // 1. قناص المبالغ المباشر: البحث عن أي رقم ينتهي بصيغة مالية .00 أو .50 (دقيق 100%)
    const decimalNumbers = t.match(/\b\d+(?:[,\s]*\d{3})*\.\d{2}\b/g);
    if (decimalNumbers && decimalNumbers.length > 0) {
        let parsed = decimalNumbers.map(n => parseFloat(n.replace(/[,\s]/g, ''))).filter(n => !isNaN(n));
        // استبعاد أرقام العمليات الطويلة التي قد تحتوي على نقطة بالخطأ
        parsed = parsed.filter(n => n.toString().split('.')[0].length < 10);
        if (parsed.length > 0) return Math.max(...parsed); 
    }

    // 2. محاولة القراءة التقليدية بالكلمات المفتاحية
    const keywordMatch = t.match(/(?:المبلغ|مبلغ|القيمة|Amount)\s*[:\-]?\s*([0-9]{1,3}(?:[,\s]*[0-9]{3})*(?:\.[0-9]{1,2})?)/i)
                      || t.match(/([0-9]{1,3}(?:[,\s]*[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:المبلغ|مبلغ|القيمة|Amount)/i);
    if (keywordMatch) {
        let val = parseFloat(keywordMatch[1].replace(/[,\s]/g, ''));
        if (!isNaN(val) && val > 0) return val;
    }

    // 3. الطريقة الوحشية (سحب كل الأرقام واختيار الأكبر مع فلترة قوية)
    const cleanedForNums = t.replace(/,/g, '');
    const rawNumbers = cleanedForNums.match(/\b\d+(?:\.\d{1,2})?\b/g);
    if (rawNumbers && rawNumbers.length > 0) {
        // فلترة: لا يوجد مبلغ تحويل حقيقي يبدأ بصفر (الأصفار تعني أرقام هواتف أو حسابات)
        let validStrings = rawNumbers.filter(s => !s.startsWith('0') || s.startsWith('0.'));
        let parsed = validStrings.map(n => parseFloat(n)).filter(n => !isNaN(n));
        
        let possibleAmounts = parsed.filter(n => n > 0 && n.toString().split('.')[0].length < 10);
        if (possibleAmounts.length > 0) {
            return Math.max(...possibleAmounts);
        }
    }
    
    return null;
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
    console.log('تم جدولة إرسال التقرير اليومي بنجاح (مرة واحدة فقط)');
}

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
                await sendMsg(groupId, 'البوت شغال بأعلى ذكاء! جاهز لقراءة كل الإيصالات (الخضراء والبيضاء).');
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

            if (!botActive || groupId !== targetGroupId) continue;

            const imgMsg = msg.message.imageMessage;
            if (!imgMsg) continue;

            await sendMsg(groupId, 'جاري قراءة الإيصال بذكاء...');
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );
                
                const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'ara+eng');

                const account = findAccountSmart(ocrText);
                const amount = extractAmountSmart(ocrText);

                if (!account || !amount) {
                    await sendMsg(groupId, '⚠️ لم أتمكن من استخراج الحساب او المبلغ بدقة. تأكد من وضوح صورة الإيصال.');
                    continue;
                }

                let data = loadData();
                data = resetIfNewDay(data);
                data.totals[account.number] = (data.totals[account.number] || 0) + amount;
                saveData(data);

                await sendMsg(groupId,
                    '✅ تم التسجيل بنجاح!\n' +
                    '👤 ' + account.name + '\n' +
                    '💰 المبلغ: ' + amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                    '📊 إجمالي اليوم: ' + data.totals[account.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                );
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
