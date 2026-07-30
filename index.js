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

// دالة بحث خارقة تتغلب على تشابك الخطوط في الإيصالات
function findAccountSmart(text) {
    const cleanText = text.replace(/[^0-9]/g, ''); // أخذ الأرقام الصافية فقط من النص المستخرج
    
    for (const acc of ACCOUNTS) {
        const targetNum = acc.number.replace(/\D/g, '');
        
        // 1. التطابق التام الكامل
        if (cleanText.includes(targetNum)) return acc;
        
        // 2. مطابقة ذكية تعتمد على الأجزاء (أول 6 أرقام + آخر 4 أرقام من الحساب)
        const p1 = targetNum.slice(0, 6);
        const p2 = targetNum.slice(-4);
        
        if (cleanText.includes(p1) && cleanText.includes(p2)) {
            return acc;
        }
    }
    return null;
}

function extractAmountSmart(text) {
    // استخراج المبالغ التي تحتوي على فواصل عشرية (.00 أو .50 إلخ)
    const matches = text.match(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g) || text.match(/\b\d+\.\d{2}\b/g);
    
    if (matches && matches.length > 0) {
        let parsed = matches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n));
        parsed = parsed.filter(n => n > 0 && n < 100000000); // استبعاد أي رقم غير منطقي
        if (parsed.length > 0) return Math.max(...parsed);
    }
    
    // محاولة احتياطية ثانية في حال غابت النقطة العشرية
    const rawNums = text.match(/\b\d{5,}\b/g);
    if (rawNums) {
        let parsedRaw = rawNums.map(n => parseFloat(n)).filter(n => !isNaN(n) && n < 100000000 && n > 100);
        if (parsedRaw.length > 0) {
            // استبعاد أرقام الحسابات الطويلة واختيار القيمة المناسبة
            let valid = parsedRaw.filter(n => n.toString().length < 10);
            if (valid.length > 0) return Math.max(...valid);
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
                await sendMsg(groupId, 'البوت شغال بوضع القراءة الذكية الفائقة وجاهز!');
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

            await sendMsg(groupId, 'جاري قراءة الإيصال...');
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
                    await sendMsg(groupId, '⚠️ لم أتمكن من استخراج الحساب أو المبلغ بدقة. تأكد من وضوح صورة الإيصال.');
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
