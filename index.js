const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const ACCOUNTS = [
    { name: 'فاطمه حسين',       number: '1003092849630001' },
    { name: 'حمد خضر',          number: '0273051189600001' },
    { name: 'نمارق عبد الباقي', number: '1003092849830001' },
    { name: 'احمد عبد الباقي',  number: '1003077677580001' },
    { name: 'عبد الباقي صالح',  number: '1003092849400001' },
    { name: 'فتح الرحمن',       number: '1343036754470001' },
    { name: 'خضر صالح',         number: '0273090788480001' },
    { name: 'محمد فتح الرحمن',  number: '0563034575990001' },
];

const DATA_FILE = path.join(__dirname, 'daily_data.json');

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

function normalizeNum(raw) {
    return raw.replace(/\s+/g, '').trim();
}

function findAccount(rawNumber) {
    const clean = normalizeNum(rawNumber);
    return ACCOUNTS.find(a => normalizeNum(a.number) === clean) || null;
}

function extractFromText(text) {
    const result = { fromAccount: null, amount: null };
    const fromMatch = text.match(/من\s*حساب[\s:-]*([0-9\s]{10,25})/i)
        || text.match(/from\s*account[\s:-]*([0-9\s]{10,25})/i);
    if (fromMatch) result.fromAccount = fromMatch[1].trim();
    const amountMatch = text.match(/المبلغ[\s:-]*([\d,.]+)/i)
        || text.match(/amount[\s:-]*([\d,.]+)/i);
    if (amountMatch) result.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    return result;
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

async function sendMsg(jid, text) {
    await sock.sendMessage(jid, { text });
}

function scheduleReport() {
    cron.schedule('0 0 * * *', async () => {
        if (!targetGroupId) return;
        let data = loadData();
        await sendMsg(targetGroupId, buildReport(data));
        saveData(initData());
        console.log('تم إرسال التقرير اليومي');
    }, { timezone: 'Africa/Khartoum' });
}

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('امسح QR Code من واتساب');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('انقطع الاتصال - إعادة الاتصال:', shouldReconnect);
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
                await sendMsg(groupId, 'البوت شغال! جاهز لقراءة الايصالات.');
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

            await sendMsg(groupId, 'جاري قراءة الايصال...');
            try {
                const buffer = await sock.downloadMediaMessage(msg);
                const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'ara+eng');
                const extracted = extractFromText(ocrText);

                if (!extracted.fromAccount || !extracted.amount) {
                    await sendMsg(groupId, 'لم اتمكن من قراءة الايصال. تاكد من وضوح الصورة.');
                    continue;
                }

                const account = findAccount(extracted.fromAccount);
                if (!account) {
                    await sendMsg(groupId, 'الحساب غير موجود: ' + extracted.fromAccount);
                    continue;
                }

                let data = loadData();
                data = resetIfNewDay(data);
                data.totals[account.number] = (data.totals[account.number] || 0) + extracted.amount;
                saveData(data);

                await sendMsg(groupId,
                    'تم التسجيل!\n' +
                    account.name + '\n' +
                    'المبلغ: ' + extracted.amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                    'اجمالي اليوم: ' + data.totals[account.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                );
            } catch (err) {
                console.error('خطا:', err);
                await sendMsg(groupId, 'حدث خطا اثناء قراءة الايصال.');
            }
        }
    });
}

startBot();
