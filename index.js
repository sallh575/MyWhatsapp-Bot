/**
 * بوت واتساب لتتبع التحويلات البنكية (بنكك - بنك الخرطوم) - مُعدّل للعمل عبر OpenRouter
 * =========================================================
 * إعداد مطلوب قبل التشغيل:
 *  1) npm install openai @whiskeysockets/baileys tesseract.js node-cron pino qrcode-terminal sharp
 *  2) متغير بيئة OPENROUTER_API_KEY
 *  3) اختياري: VISION_MODEL لتغيير النموذج (افتراضي: anthropic/claude-3.5-sonnet)
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
const OpenAI = require('openai');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* لم تُثبَّت بعد */ }

const basePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(basePath, 'daily_data.json');

const ACCOUNTS = [
    { name: 'فاطمه حسين',        number: '1003092849630001' },
    { name: 'حمد خضر',          number: '0273051189600001' },
    { name: 'نمارق عبد الباقي', number: '1003092849830001' },
    { name: 'احمد عبد الباقي',   number: '1003077677580001' },
    { name: 'عبد الباقي صالح',   number: '1003092849400001' },
    { name: 'فتح الرحمن',        number: '1343036754470001' },
    { name: 'خضر صالح',          number: '0273090788480001' },
    { name: 'محمد فتح الرحمن',   number: '0563034575990001' },
];

const MATCH_FIELD = (process.env.MATCH_FIELD || 'from').toLowerCase() === 'to' ? 'to' : 'from';

// استخدام OpenRouter بدلاً من Anthropic المباشر
const VISION_MODEL = process.env.VISION_MODEL || 'anthropic/claude-3.5-sonnet';
const openrouterApiKey = process.env.OPENROUTER_API_KEY;

const aiClient = openrouterApiKey ? new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: openrouterApiKey,
    defaultHeaders: {
        'HTTP-Referer': 'https://github.com/free-claude-code',
        'X-Title': 'WhatsApp Banking Bot'
    }
}) : null;

if (!aiClient) {
    console.warn('⚠️ OPENROUTER_API_KEY غير مضبوط — سيعمل البوت بـ OCR تقليدي أقل دقة.');
}

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

// -------------------- أدوات مطابقة الحسابات --------------------

function normalizeDigits(str) {
    if (!str) return '';
    const easternToWestern = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
    return String(str).split('').map(ch => easternToWestern[ch] || ch).join('').replace(/[^0-9]/g, '');
}

function matchAccountExact(numStr) {
    const clean = normalizeDigits(numStr);
    if (!clean) return null;
    return ACCOUNTS.find(a => a.number.replace(/\D/g, '') === clean) || null;
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[m][n];
}

function findClosestAccounts(numStr, limit = 2) {
    const clean = normalizeDigits(numStr);
    if (!clean) return [];
    return ACCOUNTS
        .map(a => ({ acc: a, dist: levenshtein(clean, a.number.replace(/\D/g, '')) }))
        .sort((x, y) => x.dist - y.dist)
        .slice(0, limit)
        .filter(x => x.dist <= 3);
}

// -------------------- الاستخراج عبر OpenRouter Vision --------------------

const EXTRACTION_SYSTEM_PROMPT = `أنت أداة استخراج بيانات دقيقة لإيصالات تحويل بنكي سودانية (تطبيق بنكك - بنك الخرطوم).
الجدول في الصورة باللغة العربية ومرتب من اليمين لليسار: اسم الحقل على اليمين، والقيمة على اليسار في نفس الصف.

انقل الأرقام والنصوص كما تراها بالضبط. لا تحاول "تصحيحها" أو تخمين قيمة لا تراها بوضوح، ولا تفترض أي حسابات معروفة مسبقًا.

أرجع JSON فقط بدون أي نص إضافي أو علامات markdown، بالشكل التالي بالضبط:
{
  "is_receipt": true,
  "transaction_id": {"value": "رقم العملية أو null", "confidence": "high|medium|low"},
  "date_time": {"value": "التاريخ والزمن أو null", "confidence": "high|medium|low"},
  "from_account": {"value": "أرقام فقط بدون مسافات لحقل من حساب", "confidence": "high|medium|low"},
  "to_account": {"value": "أرقام فقط بدون مسافات لحقل الى حساب", "confidence": "high|medium|low"},
  "recipient_name": {"value": "إسم المرسل اليه", "confidence": "high|medium|low"},
  "amount": {"value": 0, "confidence": "high|medium|low"}
}

قواعد صارمة:
- إذا كان أي رقم غير واضح تمامًا، اكتب أفضل قراءة ممكنة لكن ضع confidence = "low" لذلك الحقل فقط.
- لا تخلط أبدًا بين "من حساب" و"الى حساب".
- amount يجب أن يكون رقمًا عشريًا صافيًا بدون فواصل آلاف (مثال: 15000.00).
- إذا لم تكن الصورة إيصال تحويل بنكي أصلًا، اجعل is_receipt = false واترك باقي الحقول null.`;

const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function extractReceiptDataAI(buffer, mimetype) {
    if (!aiClient) return null;
    const media_type = SUPPORTED_MIME.includes(mimetype) ? mimetype : 'image/jpeg';
    const base64 = buffer.toString('base64');

    const response = await aiClient.chat.completions.create({
        model: VISION_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    { type: "text", text: "استخرج بيانات هذا الإيصال بصيغة JSON فقط." },
                    { type: "image_url", image_url: { url: `data:${media_type};base64,${base64}` } }
                ]
            }
        ]
    });

    const raw = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json\s*|^```\s*|```\s*$/gm, '').trim();
    return JSON.parse(cleaned);
}

// -------------------- OCR احتياطي --------------------

async function preprocessForOCR(buffer) {
    if (!sharp) return buffer;
    try {
        return await sharp(buffer)
            .resize({ width: 1600 })
            .greyscale()
            .normalize()
            .sharpen()
            .toBuffer();
    } catch {
        return buffer;
    }
}

function legacyFindAccount(text) {
    const cleanText = text.replace(/[^0-9]/g, '');
    for (const acc of ACCOUNTS) {
        const targetNum = acc.number.replace(/\D/g, '');
        if (cleanText.includes(targetNum)) return acc;
        const p1 = targetNum.slice(0, 6);
        const p2 = targetNum.slice(-4);
        if (cleanText.includes(p1) && cleanText.includes(p2)) return acc;
    }
    return null;
}

function legacyExtractAmount(text) {
    const matches = text.match(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g) || text.match(/\b\d+\.\d{2}\b/g);
    if (matches && matches.length > 0) {
        let parsed = matches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n));
        parsed = parsed.filter(n => n > 0 && n < 100000000);
        if (parsed.length > 0) return Math.max(...parsed);
    }
    const rawNums = text.match(/\b\d{5,}\b/g);
    if (rawNums) {
        let parsedRaw = rawNums.map(n => parseFloat(n)).filter(n => !isNaN(n) && n < 100000000 && n > 100);
        if (parsedRaw.length > 0) {
            let valid = parsedRaw.filter(n => n.toString().length < 10);
            if (valid.length > 0) return Math.max(...valid);
        }
    }
    return null;
}

// -------------------- حالة البوت --------------------

let botActive = false;
let targetGroupId = null;
let sock = null;
let isCronScheduled = false;
const pendingByGroup = {};

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

// -------------------- معالجة إيصال واحد --------------------

async function handleReceiptImage(groupId, msg, imgMsg) {
    await sendMsg(groupId, 'جاري قراءة الإيصال...');

    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

    let parsed = null;
    let usedAI = false;

    if (aiClient) {
        try {
            parsed = await extractReceiptDataAI(buffer, imgMsg.mimetype);
            usedAI = true;
        } catch (aiErr) {
            console.error('خطأ في الاستخراج عبر OpenRouter، سيتم استخدام OCR الاحتياطي:', aiErr.message);
        }
    }

    if (usedAI && parsed && parsed.is_receipt === false) {
        await sendMsg(groupId,
            '⚠️ لم أستطع التأكد أن هذه الصورة إيصال تحويل واضح. تأكد من وضوح الصورة، ' +
            'أو سجّل العملية يدويًا: /اضف <اسم الحساب> <المبلغ>'
        );
        return;
    }

    if (usedAI && parsed) {
        const txId = parsed.transaction_id && parsed.transaction_id.value;
        const fromRaw = parsed.from_account && parsed.from_account.value;
        const toRaw = parsed.to_account && parsed.to_account.value;
        const fromConf = parsed.from_account && parsed.from_account.confidence;
        const toConf = parsed.to_account && parsed.to_account.confidence;
        const rawAmount = parsed.amount && parsed.amount.value;
        const amountConf = parsed.amount && parsed.amount.confidence;
        const recipientName = (parsed.recipient_name && parsed.recipient_name.value) || '';
        const dateTime = (parsed.date_time && parsed.date_time.value) || '';

        const amountVal = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount || '').replace(/,/g, ''));
        const matchRaw = MATCH_FIELD === 'to' ? toRaw : fromRaw;
        const matchConf = MATCH_FIELD === 'to' ? toConf : fromConf;

        let data = loadData();
        data = resetIfNewDay(data);
        if (txId && data.processedTxIds.includes(txId)) {
            await sendMsg(groupId, '⚠️ العملية رقم ' + txId + ' مسجّلة مسبقًا اليوم، تم تجاهل التكرار.');
            return;
        }

        const exactMatch = matchAccountExact(matchRaw);
        const isAmountOk = !isNaN(amountVal) && amountVal > 0;
        const isHighConfidence = matchConf === 'high' && amountConf === 'high';

        if (exactMatch && isAmountOk && isHighConfidence) {
            const updated = creditAccount(exactMatch, amountVal, txId);
            await sendMsg(groupId,
                '✅ تم التسجيل بنجاح!\n' +
                '👤 ' + exactMatch.name + '\n' +
                '💰 المبلغ: ' + amountVal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
                '📊 إجمالي اليوم: ' + updated.totals[exactMatch.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
            );
            return;
        }

        const suggestions = findClosestAccounts(matchRaw, 2);
        pendingByGroup[groupId] = { txId, amountVal: isAmountOk ? amountVal : null, matchRaw, suggestions, ts: Date.now() };

        let out = '⚠️ يحتاج تأكيد يدوي:\n';
        if (dateTime) out += 'التاريخ: ' + dateTime + '\n';
        if (txId) out += 'رقم العملية: ' + txId + '\n';
        out += 'المبلغ المقروء: ' + (isAmountOk ? amountVal.toLocaleString('en-US', { minimumFractionDigits: 2 }) : 'غير واضح') + '\n';
        out += 'رقم الحساب المقروء: ' + (matchRaw || 'غير واضح') + '\n';
        if (recipientName) out += 'الاسم في الإيصال: ' + recipientName + '\n';

        if (suggestions.length) {
            out += '\nأقرب الحسابات المسجّلة:\n';
            suggestions.forEach((s, i) => { out += (i + 1) + ') ' + s.acc.name + '\n'; });
            out += '\nللتأكيد أرسل رقم الاختيار (1 أو 2).';
        }
        out += '\nأو للتسجيل اليدوي: /اضف <اسم الحساب> <المبلغ>';
        await sendMsg(groupId, out);
        return;
    }

    // مسار احتياطي OCR تقليدي
    const preBuffer = await preprocessForOCR(buffer);
    const { data: { text: ocrText } } = await Tesseract.recognize(preBuffer, 'ara+eng');
    const legacyAccount = legacyFindAccount(ocrText);
    const legacyAmount = legacyExtractAmount(ocrText);

    if (!legacyAccount || !legacyAmount) {
        await sendMsg(groupId,
            '⚠️ لم أتمكن من استخراج الحساب أو المبلغ بدقة. تأكد من وضوح صورة الإيصال، ' +
            'أو سجّلها يدويًا: /اضف <اسم الحساب> <المبلغ>'
        );
        return;
    }

    const updated = creditAccount(legacyAccount, legacyAmount, null);
    await sendMsg(groupId,
        '✅ تم التسجيل (عبر OCR الاحتياطي — يُنصح بالمراجعة اليدوية)!\n' +
        '👤 ' + legacyAccount.name + '\n' +
        '💰 المبلغ: ' + legacyAmount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
        '📊 إجمالي اليوم: ' + updated.totals[legacyAccount.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
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
            console.log(`[https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$](https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$){encodeURIComponent(qr)}`);
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
                await sendMsg(groupId, 'البوت شغال ' +
                    (aiClient ? '(قراءة ذكية عبر OpenRouter AI)' : '(OCR تقليدي - يُفضّل ضبط OPENROUTER_API_KEY)') +
                    ' وجاهز!');
                continue;
            }
            if (text === '/توقف') {
                botActive = false;
                delete pendingByGroup[groupId];
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

            const confirmMatch = text.match(/^(?:تأكيد\s*)?([12])$/);
            if (confirmMatch && pendingByGroup[groupId]) {
                const pending = pendingByGroup[groupId];
                if (Date.now() - pending.ts > 30 * 60 * 1000) {
                    delete pendingByGroup[groupId];
                } else {
                    const idx = parseInt(confirmMatch[1], 10) - 1;
                    const chosen = pending.suggestions[idx];
                    if (chosen && pending.amountVal) {
                        const updated = creditAccount(chosen.acc, pending.amountVal, pending.txId);
                        await sendMsg(groupId,
                            '✅ تم تسجيل ' + pending.amountVal.toLocaleString('en-US', { minimumFractionDigits: 2 }) +
                            ' لحساب ' + chosen.acc.name + ' بعد التأكيد اليدوي.\n' +
                            '📊 إجمالي اليوم: ' + updated.totals[chosen.acc.number].toLocaleString('en-US', { minimumFractionDigits: 2 })
                        );
                        delete pendingByGroup[groupId];
                    }
                    continue;
                }
            }

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
                        delete pendingByGroup[groupId];
                    } else if (candidates.length > 1) {
                        await sendMsg(groupId, 'أكثر من حساب مطابق للاسم: ' + candidates.map(a => a.name).join('، ') + '\nاكتب الاسم كاملاً وبدقة لتفادي الالتباس.');
                    } else {
                        await sendMsg(groupId, 'تعذر إيجاد الحساب أو فهم المبلغ. الصيغة: /اضف <اسم الحساب كامل> <المبلغ>');
                    }
                } else {
                    await sendMsg(groupId, 'الصيغة الصحيحة: /اضف <اسم الحساب> <المبلغ>');
                }
                continue;
            }

            const imgMsg = msg.message.imageMessage;
            if (!imgMsg) continue;

            try {
                await handleReceiptImage(groupId, msg, imgMsg);
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
    res.write('بوت الواتساب يعمل بنجاح عبر OpenRouter!');
    res.end();
}).listen(PORT, () => {
    console.log(`Web Server is running on port ${PORT}`);
});
