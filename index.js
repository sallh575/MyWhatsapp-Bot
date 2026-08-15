/**
 * بوت واتساب لقراءة إيصالات بنكك تلقائياً - النسخة المباشرة لنموذج Claude (Anthropic API)
 *
 * تحديث: تم إصلاح سبب رئيسي كان يخلي البوت يقرا الإيصال صح بس يطلع المجموع اليومي غلط
 * (اختلاف التوقيت الزمني المستخدم في تحديد "بداية يوم جديد" عن توقيت جدولة التقرير)،
 * وتم تعديل مطابقة الحسابات عشان ما تحسب تحويل صادر من أحد حساباتنا كإنه إيراد داخل.
 * كل تعديل موضّح في التعليق فوقه مباشرة بكلمة "إصلاح:".
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

// إصلاح: منطقة زمنية موحّدة تُستخدم في كل مكان (حساب "اليوم" + جدولة التقرير) بدل
// الاعتماد الضمني على توقيت السيرفر (Railway غالباً يشغّل الحاويات بتوقيت UTC).
const TIMEZONE = 'Africa/Khartoum';

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

// إصلاح: .trim() يشيل أي مسافة أو سطر جديد زايد ممكن ينضاف بالغلط لما تنسخ المفتاح
// وتلصقه في متغيرات البيئة - ده أشهر سبب لخطأ "API key is invalid" رغم إن المفتاح صحيح فعلاً
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();

// الموديلات الصحيحة الحالية في Anthropic API (أغسطس 2026):
//   claude-haiku-4-5-20251001   الأسرع والأرخص، ممتاز لقراءة الإيصالات (مختار)
//   claude-sonnet-4-6           أدق وأقوى، لكن أغلى
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// -------------------- إدارة البيانات اليومية --------------------

function today() {
    // إصلاح جوهري (السبب الأرجح لمشكلة "المجموع غلط"): كانت هذه الدالة تحسب "اليوم"
    // بتوقيت السيرفر (UTC على الأغلب في Railway)، بينما جدولة التقرير تحت محددة صراحة
    // بتوقيت الخرطوم (UTC+2). فرق الساعتين ده كان يخلق نافذة يومياً يحصل فيها "تصفير"
    // غير مقصود للبيانات قبل ما توصل للتقرير - فعملية اتقرت صح من الإيصال ممكن تتشال
    // بالغلط لأن الكود ظن إنه بدأ يوم جديد. تحديد timeZone هنا يوحّد الحسبة مع الـcron.
    return new Date().toLocaleDateString('en-GB', { timeZone: TIMEZONE });
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

// هل رقم حساب (من إيصال) يطابق أحد حساباتنا الثمانية؟
function findAccountByNumber(num) {
    const clean = normalizeDigits(num);
    if (!clean) return null;

    for (const acc of ACCOUNTS) {
        const target = normalizeDigits(acc.number);
        const coreTarget = target.slice(0, -4);

        if (
            clean.includes(target) ||
            (coreTarget.length >= 8 && clean.includes(coreTarget))
        ) {
            return acc;
        }
    }
    return null;
}

// إصلاح (مشكلة مهمة ثانية): الدالة القديمة كانت تطابق العملية بحساباتنا لو ظهر
// الحساب في "من حساب" *أو* "الى حساب". فلو أحد أصحاب الحسابات الثمانية حوّل فلوس
// لطرف خارجي (بالضبط زي الإيصال اللي بعتّه - تحويل من حساب أحمد عبد الباقي لحساب
// مش مسجل عندنا)، كانت تُحتسب غلط كإيراد داخل لحساب أحمد رغم إنها فلوس طالعة منه!
// الصح: نطابق فقط على "الحساب المستلم" (to_account) لأنه هو اللي فعلاً استلم الفلوس.
function findMatchingAccount(toNum, recipientNameText = '') {
    const byNumber = findAccountByNumber(toNum);
    if (byNumber) return byNumber;

    for (const acc of ACCOUNTS) {
        if (recipientNameText && recipientNameText.includes(acc.name)) {
            return acc;
        }
    }

    return null;
}

// -------------------- قراءة الإيصال عبر Claude (Anthropic API) مباشرة --------------------

// أكواد HTTP يستاهل معاها نعيد المحاولة (مؤقتة: ازدحام/تحميل زائد/تقطيع شبكة)
const RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 529];

async function callClaudeAPI(payload, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        let response;
        try {
            response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json"
                },
                body: JSON.stringify(payload)
            });
        } catch (networkErr) {
            // خطأ شبكة حقيقي (مش رد من Anthropic) - يستاهل إعادة محاولة
            lastErr = networkErr;
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500));
            continue;
        }

        if (response.ok) return await response.json();

        const errText = await response.text();
        const httpErr = new Error(`Anthropic HTTP Error ${response.status}: ${errText}`);

        // إصلاح: نعيد المحاولة بس لو الخطأ مؤقت. لو الخطأ 400 (زي باراميتر مرفوض أو
        // طلب غلط بالشكل) مفيش أي فايدة من الإعادة - نفس الطلب هيفشل بنفس الطريقة
        // بالظبط في كل مرة، وكنا بنضيّع وقت 1.5 ثانية إضافية على الفاضي كل مرة يحصل خطأ كده.
        if (!RETRYABLE_HTTP_STATUS.includes(response.status) || i === attempts - 1) {
            throw httpErr;
        }
        lastErr = httpErr;
        await new Promise(r => setTimeout(r, 1500));
    }
    throw lastErr;
}

async function readReceiptWithClaude(buffer, mimetype) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY مفقود في المتغيرات!');

    const base64Image = buffer.toString('base64');
    const mimeTypeStr = mimetype || 'image/jpeg';

    // إصلاح: وضّحت للموديل إن في حسابات متشابهة جداً في أول أرقامها (لازم دقة تامة رقم
    // رقم)، وطلبت المبلغ كرقم صافي بدون فواصل صراحة، وطلبت null بدل التخمين لو حقل مش واضح.
    const prompt = `أنت نظام ذكاء اصطناعي دقيق جداً لقراءة إيصالات تحويل بنكك (بنك الخرطوم) السودانية.
اقرأ كل رقم في الصورة بعناية شديدة رقماً رقماً، خصوصاً أرقام الحسابات - بعض الحسابات المسجّلة
لدينا تتشابه في الأرقام الأولى وتختلف فقط في آخر رقمين قبل النهاية، وأي خطأ بسيط في القراءة
يؤدي لمطابقة حساب خاطئ بالكامل.
استخرج البيانات التالية وأرجعها حصرياً بصيغة JSON صحيحة بدون أي كلام إضافي أو Markdown:
{
  "transaction_id": "رقم العملية كاملاً كما يظهر (نص)",
  "from_account": "رقم الحساب المحول *منه* كاملاً كما يظهر أمام 'من حساب' (أرقام فقط بدون فراغات)",
  "to_account": "رقم الحساب المحول *إليه* كاملاً كما يظهر أمام 'الى حساب' (أرقام فقط بدون فراغات)",
  "recipient_name": "الاسم الظاهر أمام 'إسم المرسل اليه' إن وُجد، وإلا اسم صاحب الحساب الظاهر بالإيصال",
  "amount": المبلغ كرقم عشري صافٍ فقط بدون فواصل أو رموز عملة أو أي نص (مثال صحيح: 200000.00)
}
لو أي حقل مش واضح في الصورة أرجع له null بدلاً من التخمين.
اقرأ بحرفية ودقة تامة بدون أي تخمين أو تقريب - نفس الصورة يجب أن تُقرأ بنفس الطريقة تماماً في كل مرة.`;

    // إصلاح مهم: شلت "temperature: 0" اللي كانت هنا. Sonnet 5 (وكل الجيل الجديد زي
    // Opus 4.7/4.8) بيرفض الباراميتر ده تماماً ويرجع نفس الخطأ اللي واجهته - حتى لو قيمته صفر.
    // ده سبب رسالة "temperature is deprecated for this model" اللي جاتك. الثبات في القراءة
    // دلوقتي معتمد بس على وضوح تعليمات الـprompt (فوق) مش على معامل الـsampling.
    const data = await callClaudeAPI({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: mimeTypeStr,
                            data: base64Image
                        }
                    },
                    {
                        type: "text",
                        text: prompt
                    }
                ]
            }
        ]
    });

    let content = data.content[0].text.trim();

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
    // إصلاح: كانت مضبوطة '0 0 * * *' (منتصف الليل) مش الساعة 8 بالليل زي ما تبيها.
    // لو تبي وقت مختلف غيّر بس الرقم التاني (20) لساعة اليوم اللي تناسبك (نظام 24 ساعة).
    cron.schedule('0 20 * * *', async () => {
        if (!targetGroupId) return;
        const data = loadData();
        const report = buildReport(data);
        // إصلاح: نصفّر البيانات فوراً وبشكل متزامن *قبل* إرسال الرسالة (اللي بتاخد وقت
        // عبر الشبكة)، مش بعدها. لو عملية جديدة وصلت بالظبط وقت إرسال التقرير القديم،
        // كانت ممكن تتسجل صح ثم "تتبلع" لما نصفّر البيانات بعد الإرسال بالترتيب القديم.
        saveData(initData());
        await sendMsg(targetGroupId, report);
    }, { timezone: TIMEZONE });
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
            console.log('البوت متصل وجاهز للعمل مع Claude مباشرة!');
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
                await sendMsg(groupId, '🤖 تم تفعيل البوت بنجاح (عبر Claude مباشرة)!');
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
                const parsedData = await readReceiptWithClaude(buffer, imgMsg.mimetype);

                const txId = parsedData.transaction_id;
                const fromAcc = parsedData.from_account;
                const toAcc = parsedData.to_account;
                const recipientName = parsedData.recipient_name;
                // إصلاح: تنظيف أي فواصل/فراغات ممكن الموديل يرجعها بالغلط قبل التحويل لرقم
                const amountVal = parseFloat(String(parsedData.amount).replace(/[,\s]/g, ''));

                let data = loadData();
                data = resetIfNewDay(data);

                if (txId && data.processedTxIds && data.processedTxIds.includes(txId)) {
                    await sendMsg(groupId, '⚠️ العملية رقم ' + txId + ' مسجّلة مسبقاً اليوم ولم يتم تكرارها.');
                    continue;
                }

                const matchedAcc = findMatchingAccount(toAcc, recipientName);

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
                    // إصلاح: لو الحساب المصدر ("من حساب") هو أحد حساباتنا لكن المستلم خارجي،
                    // فهذا تحويل صادر مش إيراد - نوضحها للمستخدم بدل رسالة "غير مطابق" العامة
                    const outgoingFrom = findAccountByNumber(fromAcc);
                    if (outgoingFrom) {
                        await sendMsg(groupId,
                            'ℹ️ هذا إيصال *تحويل صادر* من حساب ' + outgoingFrom.name + ' إلى حساب خارجي، لذلك لم تتم إضافته كإيراد.\n' +
                            '💰 المبلغ: ' + (isNaN(amountVal) ? 'غير واضح' : amountVal.toLocaleString('en-US', { minimumFractionDigits: 2 }))
                        );
                    } else {
                        await sendMsg(groupId,
                            '⚠️ قُرئ الإيصال لكن لم يتم مطابقة الحساب بدقة.\n' +
                            'من: ' + (fromAcc || 'غير واضح') + '\n' +
                            'إلى: ' + (toAcc || 'غير واضح') + '\n' +
                            'الاسم: ' + (recipientName || 'غير واضح') + '\n' +
                            'المبلغ: ' + (isNaN(amountVal) ? 'غير واضح' : amountVal)
                        );
                    }
                }

            } catch (err) {
                console.error('خطأ قراءة الإيصال:', err);
                await sendMsg(groupId, '❌ خطأ تقني: ' + err.message);
            }
        }
    });
}

// تشخيص عند البدء: يطبع في اللوق الموديل المستخدم وأول/آخر 4 أحرف من المفتاح
// لو المفتاح يظهر كـ (MISSING) يبقى لسه ما اتحط في متغيرات Railway
const keyPreview = ANTHROPIC_API_KEY 
    ? ANTHROPIC_API_KEY.slice(0, 8) + '...' + ANTHROPIC_API_KEY.slice(-4) + ' (طول: ' + ANTHROPIC_API_KEY.length + ')'
    : '(MISSING - لا يوجد مفتاح!)';
console.log('[STARTUP] الموديل المستخدم:', CLAUDE_MODEL);
console.log('[STARTUP] مفتاح الـAPI:', keyPreview);

startBot();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('سيرفر بوت الواتساب يعمل بنجاح مع Claude!');
    res.end();
}).listen(PORT, () => {
    console.log(`Web Server is running on port ${PORT}`);
});
