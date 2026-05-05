// SillyTavern Side Skit · 角色小剧场
// 主回复一开始生成 -> 后台静默调一次 AI，让角色卡里的次要角色说点啥
// 默认：本地抽句子（0 消耗）；按钮 / 自动 -> 调 AI 生成

const MODULE = 'side_skit';

// ============ 默认设置 ============
const defaultSettings = Object.freeze({
    enabled: true,
    autoTriggerOnGenerate: true,   // 主回复开始时自动调一次 AI
    maxAITokens: 120,              // AI 即兴回复 token 上限
    maxBubbles: 6,                 // 面板最多保留几条
    showLocalWhileWaiting: true,   // AI 生成期间先用本地抽句填充
    customCharacters: '',          // 用户手动指定角色名（逗号分隔），空=自动从角色卡抽
});

function getSettings() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) return { ...defaultSettings };
    const ext = ctx.extensionSettings;
    if (!ext[MODULE]) {
        ext[MODULE] = structuredClone(defaultSettings);
    }
    // 补齐新增字段
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(ext[MODULE], k)) {
            ext[MODULE][k] = defaultSettings[k];
        }
    }
    return ext[MODULE];
}

function saveSettings() {
    try {
        window.SillyTavern?.getContext?.()?.saveSettingsDebounced?.();
    } catch (e) { /* 忽略 */ }
}

// ============ 状态 ============
const state = {
    characters: [],     // 当前提取的次要角色名列表
    bubbles: [],        // 小剧场气泡
    aiGenerating: false,
};

// ============ 角色提取 ============
// 从角色卡 description / personality / scenario 里抽出"其他角色名"
// 启发式：找 NameCase / 引号前后的人称 / 中文常见姓名格式
function extractCharacters() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) return [];

    const settings = getSettings();

    // 用户手动指定优先
    if (settings.customCharacters?.trim()) {
        return settings.customCharacters.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    }

    const charId = ctx.characterId;
    const char = (ctx.characters || [])[charId];
    const mainName = ctx.name2 || char?.name || 'Char';
    const userName = ctx.name1 || 'User';

    if (!char) return [];

    // 来源 1：角色卡静态字段
    const cardText = [
        char.description || '',
        char.personality || '',
        char.scenario || '',
        char.first_mes || '',
    ].join('\n');

    // 来源 2：最近聊天历史（最有效，因为对话里直接出现 @xxx 和 xxx："..."）
    const recentChat = (ctx.chat || []).slice(-30).map(m => m.mes || '').join('\n');

    const allText = cardText + '\n' + recentChat;

    // 高置信度模式：直接抓"@xxx" 和 "xxx：" 这种明显说话人标记
    const highConfidence = new Set();
    // @某某  或 @某某 后跟空格/标点
    (allText.match(/@([\u4e00-\u9fa5A-Za-z0-9]{1,8})/g) || []).forEach(m => {
        const name = m.slice(1).trim();
        if (name && name !== mainName && name !== userName) highConfidence.add(name);
    });
    // 行首：xxx："..."  或  xxx说："..."
    (allText.match(/(?:^|\n|。|！|？)\s*([\u4e00-\u9fa5]{2,4})[:：]/g) || []).forEach(m => {
        const name = m.replace(/[\s。！？\n:：]/g, '');
        if (name && name !== mainName && name !== userName) highConfidence.add(name);
    });

    const found = new Set(highConfidence);

    // 中文姓名（频率 ≥ 2 次）
    const chineseNames = allText.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    const cnFreq = {};
    chineseNames.forEach(n => { cnFreq[n] = (cnFreq[n] || 0) + 1; });
    const cnNonNames = new Set([
        '这个','那个','什么','怎么','为什么','可能','已经','一直','突然',
        '现在','时候','感觉','觉得','知道','看到','听到','说话','没有',
        '所以','但是','不过','然后','因为','如果','虽然','只是','还有',
        '一下','一点','一些','自己','他们','我们','你们','她们','它们',
        '其实','应该','或者','非常','十分','可是','或许','大概','也许',
        '这里','那里','哪里','里面','外面','上面','下面','旁边','后面',
        '一个','两个','几个','每个','所有','全部','一切','任何','某个',
        '今天','明天','昨天','早上','中午','晚上','下午','上午','以后','以前',
        '声音','眼睛','头发','手指','身体','脸色','表情','心里','脑海',
        '不会','不能','不要','不是','不过','不行','不用','不可','不会',
    ]);
    Object.entries(cnFreq).forEach(([n, freq]) => {
        if (freq < 2) return;
        if (n === mainName || n === userName) return;
        if (cnNonNames.has(n)) return;
        // 中文名通常不是纯重复字（"哈哈"、"好好"）
        if (/^(.)\1+$/.test(n)) return;
        found.add(n);
    });

    // 英文名（频率 ≥ 2 次，避开字体名/UI 词）
    const enNames = cardText.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\b/g) || [];
    const enFreq = {};
    enNames.forEach(n => { enFreq[n] = (enFreq[n] || 0) + 1; });
    const enNonNames = new Set([
        'The','And','But','You','She','He','They','When','Where','Why','How',
        'This','That','These','Those','There','Here','After','Before','During',
        'Cormorant','Garamond','Times','New','Roman','Arial','Helvetica','Verdana',
        'Georgia','Courier','Tahoma','Trebuchet','Calibri','Cambria','Consolas',
        'Unapproachable','OOC','POV',
    ]);
    Object.entries(enFreq).forEach(([n, freq]) => {
        if (freq < 2) return;  // 至少出现 2 次才算
        if (n === mainName || n === userName) return;
        // 任一单词是字体/UI 黑名单的整名都丢弃
        if (n.split(/\s+/).some(w => enNonNames.has(w))) return;
        found.add(n);
    });

    return Array.from(found).slice(0, 8);
}

// ============ 本地句子模板（0 消耗） ============
const LOCAL_TEMPLATES = [
    '{a} 偷偷瞥了 {b} 一眼，又赶紧移开视线。',
    '{a} 嘟囔着："这种事真的合理吗……"',
    '{a} 抱着胳膊靠在墙边，没说话。',
    '{a} 和 {b} 交换了一个意味深长的眼神。',
    '{a} 嘀咕："好像气氛有点……"',
    '远处传来 {a} 的脚步声，越来越近。',
    '{a} 打了个哈欠，"什么时候才能轮到我啊。"',
    '{a} 翻了个白眼，"真是的。"',
    '{a} 在角落里默默吃着零食。',
    '{a} 戳了戳 {b} 的肩膀，"喂，你看那边。"',
    '{a} 露出一个微妙的笑容。',
    '{a} 把手插进口袋，转过身去。',
    '{a} 小声对 {b} 说："等下要不要溜走？"',
    '{a} 哼了一声，没接话。',
    '{a} 整理了一下衣领，假装很从容。',
];

function localSkit() {
    const chars = state.characters;
    if (chars.length === 0) {
        return {
            speaker: '旁白',
            text: '（这个角色卡里没找到其他角色，可以在设置里手动添加）',
            isLocal: true,
        };
    }

    const a = chars[Math.floor(Math.random() * chars.length)];
    let b = chars[Math.floor(Math.random() * chars.length)];
    let tries = 0;
    while (b === a && chars.length > 1 && tries < 5) {
        b = chars[Math.floor(Math.random() * chars.length)];
        tries++;
    }

    const tpl = LOCAL_TEMPLATES[Math.floor(Math.random() * LOCAL_TEMPLATES.length)];
    const text = tpl.replace(/{a}/g, a).replace(/{b}/g, b);

    return {
        speaker: a,
        text,
        isLocal: true,
        timestamp: Date.now(),
    };
}

// ============ AI 即兴（消耗 token） ============
async function aiSkit() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) {
        addBubble({ speaker: '系统', text: '⚠️ ST 上下文不可用', isLocal: true });
        return;
    }
    if (!ctx.generateRaw && !ctx.generateQuietPrompt) {
        addBubble({ speaker: '系统', text: '⚠️ 当前 ST 版本不支持后台生成', isLocal: true });
        return;
    }

    const settings = getSettings();
    const chars = state.characters;
    if (chars.length === 0) {
        addBubble(localSkit());
        return;
    }

    state.aiGenerating = true;
    renderPanel();

    // 等待时先放一条本地抽句撑场
    if (settings.showLocalWhileWaiting) {
        addBubble({ ...localSkit(), placeholder: true });
    }

    const charList = chars.join('、');
    const charName = ctx.name2 || '主角';

    // 取最近一两句聊天作为氛围参考（不取太多防污染）
    const recentMsgs = (ctx.chat || []).slice(-2)
        .map(m => (m.mes || '').slice(0, 200))
        .filter(Boolean)
        .join('\n');

    const systemPrompt = `你是一个小剧场生成器。你的任务是为用户的角色扮演生成一段简短的"番外小剧场"。
当前主角是 ${charName}，次要角色有：${charList}。
${recentMsgs ? `当前剧情氛围参考：\n${recentMsgs}\n` : ''}
要求：
1. 从次要角色中选 1-2 个（不要选主角 ${charName}）
2. 让他们说一两句话或做一个小动作，要有日常感、可以是吐槽/闲聊/小八卦
3. 长度控制在 30-80 字之内，简短有趣
4. 直接输出小剧场内容，不要任何前缀、解释、OOC 标记、思考过程
5. 格式：角色名："对话内容"  或  角色名 动作描写。`;

    const userPrompt = `请生成一段小剧场，从 ${charList} 中选 1-2 人。直接输出，不要解释。`;

    let result = null;
    let lastError = null;

    // 优先用 generateRaw（绕开预设污染），不行就退回 quietPrompt
    const tryRaw = async () => {
        if (!ctx.generateRaw) return null;
        return await ctx.generateRaw({
            prompt: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            systemPrompt: systemPrompt,
            responseLength: settings.maxAITokens,
        });
    };

    const tryQuiet = async () => {
        if (!ctx.generateQuietPrompt) return null;
        const fullPrompt = `[小剧场任务] ${systemPrompt}\n\n${userPrompt}`;
        return await ctx.generateQuietPrompt({
            quietPrompt: fullPrompt,
            quietToLoud: false,
            skipWIAN: true,  // 跳过 WI 注入避免污染
            quietImage: null,
            quietName: 'SideSkit',
            responseLength: settings.maxAITokens,
        });
    };

    // 重试逻辑
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            result = await tryRaw();
            if (result && typeof result === 'string' && result.trim().length > 5) break;

            result = await tryQuiet();
            if (result && typeof result === 'string' && result.trim().length > 5) break;
        } catch (e) {
            lastError = e;
            console.warn(`[SideSkit] 第 ${attempt + 1} 次尝试失败:`, e);
        }
    }

    // 移除占位
    state.bubbles = state.bubbles.filter(b => !b.placeholder);

    if (result && typeof result === 'string' && result.trim().length > 5) {
        let cleaned = result.trim();

        // 清洗常见污染
        cleaned = cleaned
            .replace(/^\[?OOC[^\]]*\]?\s*/gi, '')
            .replace(/^<think>[\s\S]*?<\/think>\s*/gi, '')
            .replace(/^<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
            .replace(/^```[\s\S]*?```\s*/g, '')
            .replace(/^（小剧场[^）]*）\s*/g, '')
            .replace(/^\[小剧场[^\]]*\]\s*/g, '')
            .trim();

        // 取第一段，避免过长
        const firstPart = cleaned.split(/\n\n+/)[0];
        if (firstPart.length > 10) cleaned = firstPart;

        // 识别说话人
        const speakerMatch = cleaned.match(/^([\u4e00-\u9fa5A-Za-z]{1,8})[:：]/);
        const speaker = speakerMatch ? speakerMatch[1] :
                        (chars.find(c => cleaned.includes(c)) || chars[0] || '旁白');

        addBubble({
            speaker,
            text: cleaned,
            isLocal: false,
            timestamp: Date.now(),
        });
    } else {
        const errMsg = lastError ? `生成失败：${lastError.message || lastError}` : '（AI 空回了，再试试？也可能是预设冲突，可以暂时关掉自动）';
        addBubble({ speaker: '系统', text: errMsg, isLocal: true });
    }

    state.aiGenerating = false;
    renderPanel();
}

function addBubble(bubble) {
    const settings = getSettings();
    state.bubbles.unshift(bubble);
    if (state.bubbles.length > settings.maxBubbles) {
        state.bubbles = state.bubbles.slice(0, settings.maxBubbles);
    }
    renderPanel();
}

// ============ UI ============
function injectPanel() {
    if (document.getElementById('side-skit-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'side-skit-panel';
    panel.className = 'ss-panel ss-collapsed';
    panel.innerHTML = `
        <div class="ss-header">
            <span class="ss-title">🎭 角色小剧场</span>
            <div class="ss-controls">
                <button id="ss-refresh-chars" class="ss-btn-icon" title="重新提取角色">👥</button>
                <button id="ss-local" class="ss-btn-icon" title="本地抽一句（免费）">🎲</button>
                <button id="ss-ai" class="ss-btn-icon" title="让 AI 即兴一段（消耗 token）">✨</button>
                <button id="ss-settings" class="ss-btn-icon" title="设置">⚙</button>
                <button id="ss-collapse" class="ss-btn-icon" title="折叠/展开">▸</button>
            </div>
        </div>
        <div class="ss-body">
            <div class="ss-chars" id="ss-chars-list"></div>
            <div class="ss-bubbles" id="ss-bubbles"></div>
            <div class="ss-settings-panel" id="ss-settings-panel" style="display:none">
                <label class="ss-setting">
                    <input type="checkbox" id="ss-auto-trigger">
                    <span>主回复开始时自动调 AI</span>
                </label>
                <label class="ss-setting">
                    <input type="checkbox" id="ss-show-local-wait">
                    <span>AI 生成时先垫一句本地</span>
                </label>
                <label class="ss-setting">
                    <span>AI 回复 token 上限</span>
                    <input type="number" id="ss-max-tokens" min="30" max="500" step="10">
                </label>
                <label class="ss-setting">
                    <span>气泡最多保留</span>
                    <input type="number" id="ss-max-bubbles" min="1" max="20">
                </label>
                <label class="ss-setting ss-setting-block">
                    <span>手动指定角色（逗号分隔，留空自动）</span>
                    <textarea id="ss-custom-chars" rows="2" placeholder="例如：苏星河，丁春秋，木婉清"></textarea>
                </label>
                <button id="ss-save" class="ss-btn">保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // 事件
    panel.querySelector('#ss-collapse').addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('ss-collapsed');
    });
    panel.querySelector('.ss-header').addEventListener('dblclick', () => {
        panel.classList.toggle('ss-collapsed');
    });
    panel.querySelector('#ss-refresh-chars').addEventListener('click', (e) => {
        e.stopPropagation();
        state.characters = extractCharacters();
        renderPanel();
        toast(`提取到 ${state.characters.length} 个次要角色`);
    });
    panel.querySelector('#ss-local').addEventListener('click', (e) => {
        e.stopPropagation();
        addBubble(localSkit());
    });
    panel.querySelector('#ss-ai').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (state.aiGenerating) {
            toast('正在生成中，等等～');
            return;
        }
        await aiSkit();
    });
    panel.querySelector('#ss-settings').addEventListener('click', (e) => {
        e.stopPropagation();
        const sp = panel.querySelector('#ss-settings-panel');
        const open = sp.style.display === 'none';
        sp.style.display = open ? 'block' : 'none';
        if (open) loadSettingsToUI();
    });
    panel.querySelector('#ss-save').addEventListener('click', (e) => {
        e.stopPropagation();
        saveSettingsFromUI();
        panel.querySelector('#ss-settings-panel').style.display = 'none';
        toast('已保存');
    });

    makeDraggable(panel);

    // 初始位置：避开诊断面板
    panel.style.right = '10px';
    panel.style.top = '500px';
}

function loadSettingsToUI() {
    const s = getSettings();
    document.getElementById('ss-auto-trigger').checked = s.autoTriggerOnGenerate;
    document.getElementById('ss-show-local-wait').checked = s.showLocalWhileWaiting;
    document.getElementById('ss-max-tokens').value = s.maxAITokens;
    document.getElementById('ss-max-bubbles').value = s.maxBubbles;
    document.getElementById('ss-custom-chars').value = s.customCharacters || '';
}

function saveSettingsFromUI() {
    const s = getSettings();
    s.autoTriggerOnGenerate = document.getElementById('ss-auto-trigger').checked;
    s.showLocalWhileWaiting = document.getElementById('ss-show-local-wait').checked;
    s.maxAITokens = parseInt(document.getElementById('ss-max-tokens').value, 10) || 120;
    s.maxBubbles = parseInt(document.getElementById('ss-max-bubbles').value, 10) || 6;
    s.customCharacters = document.getElementById('ss-custom-chars').value;
    saveSettings();
    state.characters = extractCharacters();
    renderPanel();
}

function makeDraggable(el) {
    const header = el.querySelector('.ss-header');
    let offX = 0, offY = 0, dragging = false;

    const isInteractive = (target) => {
        return target.tagName === 'BUTTON' || target.tagName === 'INPUT' ||
               target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' ||
               target.closest('button');
    };

    header.addEventListener('mousedown', (e) => {
        if (isInteractive(e.target)) return;
        dragging = true;
        offX = e.clientX - el.offsetLeft;
        offY = e.clientY - el.offsetTop;
        e.preventDefault();
    });
    // touchstart 必须 passive:false 才能 preventDefault，否则浏览器吃掉滚动
    header.addEventListener('touchstart', (e) => {
        if (isInteractive(e.target)) return;
        const t = e.touches[0];
        dragging = true;
        offX = t.clientX - el.offsetLeft;
        offY = t.clientY - el.offsetTop;
        e.preventDefault();
    }, { passive: false });

    const onMove = (clientX, clientY) => {
        if (!dragging) return;
        // 限制不要拖出屏幕
        const maxX = window.innerWidth - 40;
        const maxY = window.innerHeight - 40;
        const newX = Math.max(0, Math.min(maxX, clientX - offX));
        const newY = Math.max(0, Math.min(maxY, clientY - offY));
        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };

    document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });

    document.addEventListener('mouseup', () => { dragging = false; });
    document.addEventListener('touchend', () => { dragging = false; });
    document.addEventListener('touchcancel', () => { dragging = false; });
}

function renderPanel() {
    const panel = document.getElementById('side-skit-panel');
    if (!panel) return;

    // 角色列表
    const charsEl = panel.querySelector('#ss-chars-list');
    if (state.characters.length === 0) {
        charsEl.innerHTML = '<span class="ss-empty-chars">没有提取到角色，点 👥 重试或在 ⚙ 设置里手动指定</span>';
    } else {
        charsEl.innerHTML = state.characters.map(c => `<span class="ss-char-tag">${escapeHtml(c)}</span>`).join('');
    }

    // 气泡
    const bubblesEl = panel.querySelector('#ss-bubbles');
    if (state.bubbles.length === 0 && !state.aiGenerating) {
        bubblesEl.innerHTML = '<div class="ss-empty">点 🎲 抽一句 / ✨ 让 AI 即兴 / 或者发个消息触发自动生成 ♡</div>';
    } else {
        const items = state.bubbles.map(b => `
            <div class="ss-bubble ${b.isLocal ? 'ss-bubble-local' : 'ss-bubble-ai'} ${b.placeholder ? 'ss-bubble-placeholder' : ''}">
                <div class="ss-bubble-head">
                    <span class="ss-speaker">${escapeHtml(b.speaker)}</span>
                    <span class="ss-source">${b.isLocal ? (b.placeholder ? '占位' : '本地') : 'AI'}</span>
                </div>
                <div class="ss-bubble-text">${escapeHtml(b.text)}</div>
            </div>
        `).join('');
        const loading = state.aiGenerating ? '<div class="ss-loading">✨ AI 正在即兴中...</div>' : '';
        bubblesEl.innerHTML = loading + items;
    }
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'ss-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
}

// ============ 事件钩子 ============
function attachEvents() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) return;
    const { eventSource, event_types } = ctx;
    if (!eventSource || !event_types) {
        console.warn('[SideSkit] eventSource 不可用，事件功能停用');
        return;
    }

    // 切换角色 / 切换聊天 -> 重新提取
    const refresh = () => {
        state.characters = extractCharacters();
        renderPanel();
    };
    eventSource.on(event_types.CHAT_CHANGED, refresh);
    eventSource.on(event_types.CHARACTER_EDITED, refresh);
    if (event_types.APP_READY) eventSource.on(event_types.APP_READY, refresh);

    // 主回复开始 -> 触发小剧场
    eventSource.on(event_types.GENERATION_STARTED, async (type, options, dryRun) => {
        const settings = getSettings();
        if (!settings.enabled || !settings.autoTriggerOnGenerate) return;
        if (dryRun) return;
        // 跳过 quiet 类型避免循环（小剧场自己发的请求 type 会是 quiet）
        if (type === 'quiet') return;
        if (state.aiGenerating) return;
        // 不阻塞主回复，异步跑
        setTimeout(() => aiSkit(), 100);
    });
}

// ============ 启动 ============
jQuery(async () => {
    try {
        injectPanel();
        // 等 ST 初始化完
        const tryInit = () => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) {
                setTimeout(tryInit, 500);
                return;
            }
            getSettings();
            state.characters = extractCharacters();
            attachEvents();
            renderPanel();
            console.log('[SideSkit] 已加载 🎭');
        };
        tryInit();
    } catch (e) {
        console.error('[SideSkit] 启动失败:', e);
    }
});

