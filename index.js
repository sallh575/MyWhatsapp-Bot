/**
 * بوت واتساب لقراءة إيصالات بنكك تلقائياً - النسخة المعدلة لتقليل استهلاك التوكنز
 */

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
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

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

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
    let report = '📊 *تقرير يوم ' + (data.date || today()) + '*\n------------------\n';
    let grandTotal = 0;
    ACCOUNTS.forEach(acc => {
        const amount = data.totals[acc.number] || 0;
        grandTotal += amount;
        report += '👤 *' + acc.name + '*\n💰 ' + amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n\n';
    });
    report += '------------------\n🔥 *المجموع الكلي: ' + grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '*';
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

// -------------------- المطابقة الذكية والدقيقة 100% --------------------

function normalizeDigits(str) {
    if (!str) return '';
    const easternToWestern = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
    return String(str).split('').map(ch => easternToWestern[ch] || ch).join('').replace(/[^0-9]/g, '');
}

function findMatchingAccountByNumbers(fromNum, toNum, senderNameText = '') {
    const cleanFrom = normalizeDigits(fromNum);
    const cleanTo = normalizeDigits(toNum);

    for (const acc of ACCOUNTS) {
        const target = normalizeDigits(acc.number);
        const coreTarget = target.slice(0, -4);

        if (
            cleanFrom.includes(target) || cleanTo.includes(target) ||
            (coreTarget.length >= 8 && (cleanFrom.includes(coreTarget) || cleanTo.includes(coreTarget)))
        ) {
            return acc;
        }
    }

    for (const acc of ACCOUNTS) {
        if (senderNameText && senderNameText.includes(acc.name)) {
            return acc;
        }
    }

    return null;
}

// -------------------- قراءة الإيصال عبر OpenRouter --------------------

async function readReceiptWithOpenRouter(buffer, mimetype) {
    if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY مفقود في المتغيرات!');

    const base64Image = buffer.toString('base64');
    const mimeTypeStr = mimetype || 'image/jpeg';

    const prompt = `أنت نظام ذكاء اصطناعي دقيق جداً لقراءة إيصالات بنكك السودانية.
قم باستخراج البيانات التالية من الصورة وأرجعها حصرياً بصيغة JSON بدون أي كلام إضافي أو ماركداون:
{
  "transaction_id": "رقم العملية (مثل 20171567293)",
  "from_account": "رقم الحساب المحول منه كاملاً تحت (من حساب)",
  "to_account": "رقم الحساب المحول إليه كاملاً تحت (الى حساب)",
  "sender_name": "اسم المرسل اليه أو اسم صاحب الحساب الظاهر في الإيصال",
  "amount": المبلغ الرقمي الصافي كقيمة عددية دقيقة (مثل 2000000.00)
}`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://whatsapp-bot.railway.app",
            "X-Title": "Bankak Bot",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            max_tokens: 1000, // تحديد الحد الأقصى لمنع استهلاك الرصيد العالي
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: { url: `data:${mimeTypeStr};base64,${base64Image}` }
                        }
                    ]
                }
            ]
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter HTTP Error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('لم يعيد النموذج صيغة JSON صحيحة. الرد كان: ' + content);
    }

    return JSON.parse(jsonMatch[0]);
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

// -------------------- تشغيل السيرفر والاتصال --------------------

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
            console.log('البوت متصل وجاهز للعمل!');
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
                await sendMsg(groupId, '🤖 تم تفعيل البوت بنجاح!');
                continue;
            }
            if (text === '/توقف') {
                botActive = false;
                await sendMsg(groupId, '🛑 تم إيقاف البوت.');
                continue;
            }
            if (text === '/تقرير') {
                let data = loadData();
                data = resetIfNewDay(data);
                await sendMsg(groupId, buildReport(data));
                continue;
            }
            if (text === '/الحسابات') {
                const list = ACCOUNTS.map((a, i) => (i + 1) + ') ' + a.name + ' (...' + a.number.slice(-4) + ')').join('\n');
                await sendMsg(groupId, '📋 *الحسابات المسجّلة:*\n\n' + list);
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
                            '✅ *تمت الإضافة اليدوية بنجاح*\n' +
                            '👤 الحساب: ' + acc.name + '\n' +
                            '💰 المبلغ: ' + amountArg.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                            '📊 إجمالي اليوم: ' + updated.totals[acc.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                        );
                    } else {
                        await sendMsg(groupId, '❌ تعذر إيجاد الحساب. الصيغة: /اضف <اسم الحساب> <المبلغ>');
                    }
                }
                continue;
            }

            const imgMsg = msg.message.imageMessage;
            if (!imgMsg) continue;

            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const parsedData = await readReceiptWithOpenRouter(buffer, imgMsg.mimetype);

                const txId = parsedData.transaction_id;
                const fromAcc = parsedData.from_account;
                const toAcc = parsedData.to_account;
                const senderName = parsedData.sender_name;
                const amountVal = parseFloat(parsedData.amount);

                let data = loadData();
                data = resetIfNewDay(data);

                if (txId && data.processedTxIds && data.processedTxIds.includes(txId)) {
                    await sendMsg(groupId, '⚠️ العملية رقم ' + txId + ' مسجّلة مسبقاً اليوم ولم يتم تكرارها.');
                    continue;
                }

                const matchedAcc = findMatchingAccountByNumbers(fromAcc, toAcc, senderName);

                if (matchedAcc && !isNaN(amountVal) && amountVal > 0) {
                    const updated = creditAccount(matchedAcc, amountVal, txId);
                    await sendMsg(groupId,
                        '✅ *تم تسجيل التحويل بنجاح تلقائياً!*\n\n' +
                        '👤 الحساب: ' + matchedAcc.name + '\n' +
                        '💰 المبلغ: ' + amountVal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                        '🔢 رقم العملية: ' + (txId || 'N/A') + '\n' +
                        '📊 إجمالي اليوم: ' + updated.totals[matchedAcc.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                    );
                } else {
                    await sendMsg(groupId, 
                        '⚠️ قُرئ الإيصال لكن لم يتم مطابقة الحساب بدقة.\n' +
                        'من: ' + (fromAcc || 'غير واضح') + '\n' +
                        'إلى: ' + (toAcc || 'غير واضح') + '\n' +
                        'الاسم: ' + (senderName || 'غير واضح') + '\n' +
                        'المبلغ: ' + (amountVal || 'غير واضح')
                    );
                }

            } catch (err) {
                console.error('خطأ قراءة الإيصال:', err);
                await sendMsg(groupId, '❌ خطأ تقني: ' + err.message);
            }
        }
    });
}

startBot();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('سيرفر بوت الواتساب يعمل بنجاح!');
    res.end();
}).listen(PORT, () => {
    console.log(`Web Server is running on port ${PORT}`);
});
