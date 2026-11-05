// ==UserScript==
// @name         NovelGrok - Viết tiểu thuyết bằng Grok AI
// @namespace    https://grok.novel.local
// @version      1.0.0
// @description  Viết tiểu thuyết mới / tiếp nối bằng Grok API (xAI). Tham khảo UI MCAI + TM Translator. Hỗ trợ outline AI, học văn phong, export TXT/EPUB2. Chạy trên Firefox + Tampermonkey.
// @author       Grok-assisted
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'novelgrok_data_v1';
    const DEFAULT_SETTINGS = {
        apiKey: '',
        model: 'grok-4',
        temperature: 0.85,
        maxTokens: 4096,
        fontFamily: 'Georgia, serif',
        fontSize: 16,
        theme: 'sepia',
        chapterMinWords: 500,
        chapterMaxWords: 2500,
        chapterRegex: '^(Chương|Chap|Chapter)\\s*[\\d]+',
        systemStyle: 'Viết văn xuôi tiểu thuyết tiếng Việt, văn phong tự nhiên, giàu cảm xúc, mô tả chi tiết, đối thoại sống động.'
    };

    let state = loadState();
    let currentNovel = null;
    let ui = null;

    // ========== THEMES (4 màu kiểu app đọc sách) ==========
    const THEMES = {
        white: { bg: '#ffffff', text: '#1a1a1a', panel: '#f5f5f5', accent: '#2563eb', border: '#e5e7eb' },
        sepia: { bg: '#f4ecd8', text: '#5b4636', panel: '#ebe1c9', accent: '#8b5a2b', border: '#d4c4a8' },
        night: { bg: '#1a1a1a', text: '#e0e0e0', panel: '#2d2d2d', accent: '#60a5fa', border: '#404040' },
        green: { bg: '#c7edcc', text: '#2c3e2d', panel: '#b8e0be', accent: '#2e7d32', border: '#a0cda6' }
    };

    function loadState() {
        const raw = GM_getValue(STORAGE_KEY, null);
        if (!raw) return { settings: { ...DEFAULT_SETTINGS }, novels: {}, styles: {} };
        try { return JSON.parse(raw); } catch { return { settings: { ...DEFAULT_SETTINGS }, novels: {}, styles: {} }; }
    }
    function saveState() { GM_setValue(STORAGE_KEY, JSON.stringify(state)); }

    // ========== API Grok ==========
    async function callGrok(messages, opts = {}) {
        const s = state.settings;
        if (!s.apiKey) throw new Error('Chưa nhập API Key xAI');
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.x.ai/v1/chat/completions',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${s.apiKey}`
                },
                data: JSON.stringify({
                    model: opts.model || s.model,
                    messages,
                    temperature: opts.temperature ?? s.temperature,
                    max_tokens: opts.maxTokens || s.maxTokens,
                    stream: false
                }),
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
                        else resolve(data.choices[0].message.content);
                    } catch (e) { reject(e); }
                },
                onerror: (e) => reject(new Error('Lỗi mạng / API'))
            });
        });
    }

    // ========== UTILS ==========
    function countWords(text) {
        return (text || '').trim().split(/\s+/).filter(Boolean).length;
    }

    function splitChapters(text, regexStr, minW, maxW) {
        const re = new RegExp(regexStr, 'gmi');
        const lines = text.split(/\r?\n/);
        let chapters = [];
        let current = { title: 'Phần mở đầu', content: [] };
        let found = false;

        for (const line of lines) {
            if (re.test(line.trim())) {
                if (current.content.length) chapters.push({ ...current, content: current.content.join('\n') });
                current = { title: line.trim(), content: [] };
                found = true;
            } else {
                current.content.push(line);
            }
        }
        if (current.content.length) chapters.push({ ...current, content: current.content.join('\n') });

        if (!found && chapters.length <= 1) {
            chapters = [];
            const words = text.split(/\s+/);
            let buf = [];
            let idx = 1;
            for (const w of words) {
                buf.push(w);
                if (buf.length >= maxW) {
                    chapters.push({ title: `Chương ${idx++}`, content: buf.join(' ') });
                    buf = [];
                }
            }
            if (buf.length >= minW) chapters.push({ title: `Chương ${idx}`, content: buf.join(' ') });
        }
        return chapters;
    }

    async function parseEpub(file) {
        const zip = await JSZip.loadAsync(file);
        let text = '';
        const files = Object.keys(zip.files).filter(f => /\.(xhtml|html|htm)$/i.test(f));
        for (const f of files.sort()) {
            const content = await zip.files[f].async('string');
            const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            text += plain + '\n\n';
        }
        return text;
    }

    // ========== UI ==========
    function applyTheme() {
        const t = THEMES[state.settings.theme] || THEMES.sepia;
        document.documentElement.style.setProperty('--ng-bg', t.bg);
        document.documentElement.style.setProperty('--ng-text', t.text);
        document.documentElement.style.setProperty('--ng-panel', t.panel);
        document.documentElement.style.setProperty('--ng-accent', t.accent);
        document.documentElement.style.setProperty('--ng-border', t.border);
        document.documentElement.style.setProperty('--ng-font', state.settings.fontFamily);
        document.documentElement.style.setProperty('--ng-size', state.settings.fontSize + 'px');
    }

    function createUI() {
        if (document.getElementById('novelgrok-root')) return;
        GM_addStyle(`
            #novelgrok-root { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: system-ui, sans-serif; }
            #ng-toggle { background: var(--ng-accent); color: #fff; border: none; border-radius: 50%; width: 56px; height: 56px; font-size: 24px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.3); }
            #ng-panel { display: none; position: fixed; top: 40px; right: 20px; width: min(920px, 96vw); height: min(85vh, 900px); background: var(--ng-panel); color: var(--ng-text); border: 1px solid var(--ng-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.25); flex-direction: column; overflow: hidden; }
            #ng-panel.open { display: flex; }
            #ng-header { padding: 12px 16px; background: var(--ng-accent); color: #fff; display: flex; justify-content: space-between; align-items: center; }
            #ng-tabs { display: flex; gap: 4px; padding: 8px; background: var(--ng-bg); border-bottom: 1px solid var(--ng-border); flex-wrap: wrap; }
            .ng-tab { padding: 6px 12px; border-radius: 6px; cursor: pointer; border: none; background: transparent; color: var(--ng-text); }
            .ng-tab.active { background: var(--ng-accent); color: #fff; }
            #ng-body { flex: 1; overflow: auto; padding: 16px; font-family: var(--ng-font); font-size: var(--ng-size); background: var(--ng-bg); }
            .ng-section { display: none; }
            .ng-section.active { display: block; }
            .ng-row { margin-bottom: 12px; }
            .ng-row label { display: block; font-weight: 600; margin-bottom: 4px; }
            .ng-row input, .ng-row textarea, .ng-row select { width: 100%; padding: 8px; border-radius: 6px; border: 1px solid var(--ng-border); background: var(--ng-panel); color: var(--ng-text); font-family: inherit; font-size: inherit; box-sizing: border-box; }
            .ng-row textarea { min-height: 120px; resize: vertical; }
            .ng-btn { padding: 8px 14px; border: none; border-radius: 6px; background: var(--ng-accent); color: #fff; cursor: pointer; margin-right: 6px; margin-bottom: 6px; }
            .ng-btn.secondary { background: transparent; border: 1px solid var(--ng-border); color: var(--ng-text); }
            .ng-btn:disabled { opacity: .5; cursor: not-allowed; }
            .ng-chapter-list { max-height: 200px; overflow: auto; border: 1px solid var(--ng-border); border-radius: 6px; padding: 8px; }
            .ng-log { font-size: 13px; color: #666; margin-top: 8px; white-space: pre-wrap; }
            #ng-editor { min-height: 280px; }
        `);

        const root = document.createElement('div');
        root.id = 'novelgrok-root';
        root.innerHTML = `
            <button id="ng-toggle" title="NovelGrok">📖</button>
            <div id="ng-panel">
                <div id="ng-header">
                    <strong>NovelGrok · Grok AI</strong>
                    <button id="ng-close" class="ng-btn secondary" style="padding:4px 10px">✕</button>
                </div>
                <div id="ng-tabs">
                    <button class="ng-tab active" data-tab="new">1. Viết mới</button>
                    <button class="ng-tab" data-tab="continue">2. Viết tiếp</button>
                    <button class="ng-tab" data-tab="style">3. Học văn phong</button>
                    <button class="ng-tab" data-tab="settings">4. Cài đặt</button>
                    <button class="ng-tab" data-tab="export">5. Xuất file</button>
                </div>
                <div id="ng-body">
                    <!-- NEW -->
                    <div class="ng-section active" id="sec-new">
                        <div class="ng-row"><label>Tên tiểu thuyết</label><input id="new-title" placeholder="Tên truyện..."></div>
                        <div class="ng-row"><label>Văn án (hướng cốt truyện – AI sẽ bám sát)</label><textarea id="new-synopsis" placeholder="Tóm tắt cốt truyện, nhân vật, kết thúc mong muốn..."></textarea></div>
                        <div class="ng-row"><label>Phong cách hành văn (tùy chỉnh)</label><textarea id="new-style" placeholder="Để trống = dùng mặc định + style đã học"></textarea></div>
                        <div class="ng-row">
                            <button class="ng-btn" id="btn-gen-outline">✨ AI tạo Outline chi tiết từng chương</button>
                            <button class="ng-btn secondary" id="btn-add-chapter">+ Thêm chương thủ công</button>
                        </div>
                        <div class="ng-row"><label>Outline các chương (có thể chỉnh)</label><div id="outline-list" class="ng-chapter-list"></div></div>
                        <div class="ng-row">
                            <button class="ng-btn" id="btn-write-chapter">▶ Viết chương hiện tại</button>
                            <select id="chapter-select"></select>
                        </div>
                        <div class="ng-row"><label>Nội dung chương (xem & chỉnh sửa)</label><textarea id="ng-editor"></textarea></div>
                        <div class="ng-row">
                            <button class="ng-btn" id="btn-save-chapter">💾 Lưu chương</button>
                            <button class="ng-btn secondary" id="btn-save-novel">Lưu toàn bộ tiểu thuyết</button>
                        </div>
                        <div class="ng-log" id="new-log"></div>
                    </div>

                    <!-- CONTINUE -->
                    <div class="ng-section" id="sec-continue">
                        <div class="ng-row"><label>Upload file (.txt / .epub)</label><input type="file" id="cont-file" accept=".txt,.epub,text/plain,application/epub+zip"></div>
                        <div class="ng-row"><label>Regex chia chương (hoặc để trống dùng số từ)</label><input id="cont-regex" value="${DEFAULT_SETTINGS.chapterRegex}"></div>
                        <div class="ng-row" style="display:flex;gap:12px">
                            <div style="flex:1"><label>Min từ</label><input type="number" id="cont-min" value="500"></div>
                            <div style="flex:1"><label>Max từ</label><input type="number" id="cont-max" value="2500"></div>
                        </div>
                        <div class="ng-row">
                            <button class="ng-btn" id="btn-analyze">🔍 Phân tích & tạo outline tiếp theo</button>
                        </div>
                        <div class="ng-row"><label>Outline chương đã có + đề xuất tiếp</label><div id="cont-outline" class="ng-chapter-list"></div></div>
                        <div class="ng-row"><label>Văn án bổ sung (nếu có)</label><textarea id="cont-synopsis"></textarea></div>
                        <div class="ng-row">
                            <button class="ng-btn" id="btn-cont-write">▶ Viết chương tiếp</button>
                            <select id="cont-chapter-select"></select>
                        </div>
                        <div class="ng-row"><textarea id="cont-editor" style="min-height:260px"></textarea></div>
                        <div class="ng-row"><button class="ng-btn" id="btn-cont-save">💾 Lưu</button></div>
                        <div class="ng-log" id="cont-log"></div>
                    </div>

                    <!-- STYLE -->
                    <div class="ng-section" id="sec-style">
                        <div class="ng-row"><label>Upload mẫu văn phong (.txt)</label><input type="file" id="style-file" accept=".txt,text/plain"></div>
                        <div class="ng-row"><button class="ng-btn" id="btn-learn-style">🧠 AI phân tích & lưu văn phong</button></div>
                        <div class="ng-row"><label>Văn phong đã học (có thể chỉnh)</label><textarea id="style-result" style="min-height:200px"></textarea></div>
                        <div class="ng-row"><button class="ng-btn" id="btn-save-style">Lưu văn phong</button></div>
                        <div class="ng-log" id="style-log"></div>
                    </div>

                    <!-- SETTINGS -->
                    <div class="ng-section" id="sec-settings">
                        <div class="ng-row"><label>xAI API Key</label><input type="password" id="set-apikey" placeholder="xai-..."></div>
                        <div class="ng-row"><label>Model</label>
                            <select id="set-model">
                                <option value="grok-4">grok-4</option>
                                <option value="grok-3">grok-3</option>
                                <option value="grok-2">grok-2</option>
                            </select>
                        </div>
                        <div class="ng-row"><label>Temperature (0–1)</label><input type="number" id="set-temp" step="0.05" min="0" max="1" value="0.85"></div>
                        <div class="ng-row"><label>Max tokens</label><input type="number" id="set-maxtokens" value="4096"></div>
                        <div class="ng-row"><label>Font chữ</label><input id="set-font" value="Georgia, serif"></div>
                        <div class="ng-row"><label>Cỡ chữ (px)</label><input type="number" id="set-size" value="16"></div>
                        <div class="ng-row"><label>Theme màu nền/chữ (4 màu app đọc sách)</label>
                            <select id="set-theme">
                                <option value="white">Trắng (White)</option>
                                <option value="sepia">Sepia (vàng giấy)</option>
                                <option value="night">Đêm (Night)</option>
                                <option value="green">Xanh lá (Green)</option>
                            </select>
                        </div>
                        <div class="ng-row"><label>System prompt mặc định</label><textarea id="set-system"></textarea></div>
                        <div class="ng-row"><button class="ng-btn" id="btn-save-settings">💾 Lưu cài đặt</button></div>
                    </div>

                    <!-- EXPORT -->
                    <div class="ng-section" id="sec-export">
                        <div class="ng-row"><label>Chọn tiểu thuyết đã lưu</label><select id="export-novel"></select></div>
                        <div class="ng-row">
                            <button class="ng-btn" id="btn-export-txt">Xuất TXT</button>
                            <button class="ng-btn" id="btn-export-epub">Xuất EPUB2</button>
                        </div>
                        <div class="ng-log" id="export-log"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        ui = root;
        applyTheme();
        bindEvents();
        refreshNovelSelects();
        loadSettingsToForm();
    }

    function bindEvents() {
        document.getElementById('ng-toggle').onclick = () => document.getElementById('ng-panel').classList.toggle('open');
        document.getElementById('ng-close').onclick = () => document.getElementById('ng-panel').classList.remove('open');

        document.querySelectorAll('.ng-tab').forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.ng-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.ng-section').forEach(s => s.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('sec-' + tab.dataset.tab).classList.add('active');
            };
        });

        // NEW novel
        document.getElementById('btn-gen-outline').onclick = genOutline;
        document.getElementById('btn-add-chapter').onclick = () => addManualChapter();
        document.getElementById('btn-write-chapter').onclick = writeCurrentChapter;
        document.getElementById('btn-save-chapter').onclick = saveCurrentChapter;
        document.getElementById('btn-save-novel').onclick = saveNovel;

        // CONTINUE
        document.getElementById('btn-analyze').onclick = analyzeContinue;
        document.getElementById('btn-cont-write').onclick = writeContinueChapter;
        document.getElementById('btn-cont-save').onclick = saveContinue;

        // STYLE
        document.getElementById('btn-learn-style').onclick = learnStyle;
        document.getElementById('btn-save-style').onclick = () => {
            state.styles.default = document.getElementById('style-result').value;
            saveState();
            log('style-log', 'Đã lưu văn phong.');
        };

        // SETTINGS
        document.getElementById('btn-save-settings').onclick = saveSettings;

        // EXPORT
        document.getElementById('btn-export-txt').onclick = () => exportNovel('txt');
        document.getElementById('btn-export-epub').onclick = () => exportNovel('epub');
    }

    function log(id, msg) {
        const el = document.getElementById(id);
        if (el) el.textContent = (el.textContent ? el.textContent + '\n' : '') + msg;
    }

    function loadSettingsToForm() {
        const s = state.settings;
        document.getElementById('set-apikey').value = s.apiKey || '';
        document.getElementById('set-model').value = s.model || 'grok-4';
        document.getElementById('set-temp').value = s.temperature;
        document.getElementById('set-maxtokens').value = s.maxTokens;
        document.getElementById('set-font').value = s.fontFamily;
        document.getElementById('set-size').value = s.fontSize;
        document.getElementById('set-theme').value = s.theme;
        document.getElementById('set-system').value = s.systemStyle;
        document.getElementById('new-style').value = state.styles.default || '';
    }

    function saveSettings() {
        state.settings.apiKey = document.getElementById('set-apikey').value.trim();
        state.settings.model = document.getElementById('set-model').value;
        state.settings.temperature = parseFloat(document.getElementById('set-temp').value) || 0.85;
        state.settings.maxTokens = parseInt(document.getElementById('set-maxtokens').value) || 4096;
        state.settings.fontFamily = document.getElementById('set-font').value;
        state.settings.fontSize = parseInt(document.getElementById('set-size').value) || 16;
        state.settings.theme = document.getElementById('set-theme').value;
        state.settings.systemStyle = document.getElementById('set-system').value;
        saveState();
        applyTheme();
        alert('Đã lưu cài đặt');
    }

    // ========== NEW NOVEL LOGIC ==========
    let newOutline = [];
    let currentChapIdx = 0;

    async function genOutline() {
        const title = document.getElementById('new-title').value.trim();
        const syn = document.getElementById('new-synopsis').value.trim();
        const style = document.getElementById('new-style').value.trim() || state.styles.default || state.settings.systemStyle;
        if (!title || !syn) return alert('Cần tên + văn án');

        log('new-log', 'Đang tạo outline...');
        const prompt = `Bạn là biên kịch tiểu thuyết chuyên nghiệp. Dựa trên văn án sau, tạo outline chi tiết từng chương (khoảng 8-15 chương). Mỗi chương gồm: tiêu đề ngắn + 3-6 bullet điểm sự kiện chính, xung đột, cảm xúc.
Văn án: ${syn}
Phong cách: ${style}
Trả về đúng format:
Chương 1: [Tên]
- ...
- ...
Chương 2: ...`;

        try {
            const res = await callGrok([
                { role: 'system', content: state.settings.systemStyle },
                { role: 'user', content: prompt }
            ]);
            newOutline = parseOutlineText(res);
            renderOutline();
            log('new-log', 'Đã tạo outline. Có thể chỉnh sửa trong danh sách.');
        } catch (e) {
            log('new-log', 'Lỗi: ' + e.message);
        }
    }

    function parseOutlineText(text) {
        const parts = text.split(/(?=Chương\s*\d+)/i);
        return parts.filter(p => p.trim()).map((p, i) => {
            const lines = p.trim().split('\n');
            return { title: lines[0].trim(), outline: lines.slice(1).join('\n').trim(), content: '' };
        });
    }

    function renderOutline() {
        const box = document.getElementById('outline-list');
        const sel = document.getElementById('chapter-select');
        box.innerHTML = '';
        sel.innerHTML = '';
        newOutline.forEach((ch, i) => {
            const div = document.createElement('div');
            div.style.marginBottom = '8px';
            div.innerHTML = `<strong>${ch.title}</strong><br><textarea data-idx="${i}" style="width:100%;min-height:60px">${ch.outline}</textarea>`;
            box.appendChild(div);
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = ch.title;
            sel.appendChild(opt);
        });
        box.querySelectorAll('textarea').forEach(ta => {
            ta.onchange = () => { newOutline[+ta.dataset.idx].outline = ta.value; };
        });
    }

    function addManualChapter() {
        newOutline.push({ title: `Chương ${newOutline.length + 1}`, outline: '', content: '' });
        renderOutline();
    }

    async function writeCurrentChapter() {
        const idx = +document.getElementById('chapter-select').value;
        currentChapIdx = idx;
        const ch = newOutline[idx];
        if (!ch) return;
        const title = document.getElementById('new-title').value;
        const syn = document.getElementById('new-synopsis').value;
        const style = document.getElementById('new-style').value || state.styles.default || state.settings.systemStyle;

        const prev = newOutline.slice(0, idx).map(c => c.content).join('\n\n').slice(-3000);

        log('new-log', `Đang viết ${ch.title}...`);
        const prompt = `Viết đầy đủ nội dung chương tiểu thuyết theo outline sau. Bám sát văn án, không lệch cốt truyện. Viết liền mạch, không tóm tắt.
Tên truyện: ${title}
Văn án: ${syn}
Phong cách: ${style}
Outline chương này:
${ch.title}
${ch.outline}
${prev ? 'Nội dung trước (để nối tiếp):\n' + prev : ''}
Chỉ trả về nội dung chương, không giải thích.`;

        try {
            const content = await callGrok([
                { role: 'system', content: style },
                { role: 'user', content: prompt }
            ], { maxTokens: 6000 });
            ch.content = content;
            document.getElementById('ng-editor').value = content;
            log('new-log', 'Xong. Hãy đọc & chỉnh sửa rồi Lưu.');
        } catch (e) {
            log('new-log', 'Lỗi: ' + e.message);
        }
    }

    function saveCurrentChapter() {
        const idx = currentChapIdx;
        if (newOutline[idx]) {
            newOutline[idx].content = document.getElementById('ng-editor').value;
            log('new-log', 'Đã lưu nội dung chương vào bộ nhớ tạm.');
        }
    }

    function saveNovel() {
        const title = document.getElementById('new-title').value.trim() || 'Untitled';
        state.novels[title] = {
            title,
            synopsis: document.getElementById('new-synopsis').value,
            chapters: newOutline,
            updated: Date.now()
        };
        saveState();
        refreshNovelSelects();
        log('new-log', 'Đã lưu tiểu thuyết: ' + title);
    }

    // ========== CONTINUE ==========
    let contData = { chapters: [], nextOutline: [] };

    async function analyzeContinue() {
        const file = document.getElementById('cont-file').files[0];
        if (!file) return alert('Chọn file');
        log('cont-log', 'Đang đọc file...');

        let text = '';
        if (file.name.toLowerCase().endsWith('.epub')) {
            text = await parseEpub(file);
        } else {
            text = await file.text();
        }

        const regex = document.getElementById('cont-regex').value || state.settings.chapterRegex;
        const minW = +document.getElementById('cont-min').value || 500;
        const maxW = +document.getElementById('cont-max').value || 2500;
        contData.chapters = splitChapters(text, regex, minW, maxW);

        log('cont-log', `Tìm thấy ${contData.chapters.length} chương. Đang phân tích outline...`);

        const sample = contData.chapters.slice(-3).map(c => c.title + '\n' + c.content.slice(0, 800)).join('\n\n---\n\n');
        const syn = document.getElementById('cont-synopsis').value;

        const prompt = `Phân tích các chương gần nhất và đề xuất outline chi tiết cho 3-5 chương tiếp theo. Giữ mạch truyện.
${syn ? 'Văn án: ' + syn : ''}
Nội dung gần đây:
${sample}
Trả về format:
Chương tiếp 1: [Tên]
- ...
Chương tiếp 2: ...`;

        try {
            const res = await callGrok([
                { role: 'system', content: state.settings.systemStyle },
                { role: 'user', content: prompt }
            ]);
            contData.nextOutline = parseOutlineText(res);
            renderContOutline();
            log('cont-log', 'Đã phân tích xong. Có thể chỉnh outline rồi viết.');
        } catch (e) {
            log('cont-log', 'Lỗi: ' + e.message);
        }
    }

    function renderContOutline() {
        const box = document.getElementById('cont-outline');
        const sel = document.getElementById('cont-chapter-select');
        box.innerHTML = '<strong>Chương đã có:</strong><br>' + contData.chapters.map(c => c.title).join('<br>');
        box.innerHTML += '<hr><strong>Outline đề xuất tiếp:</strong>';
        contData.nextOutline.forEach((ch, i) => {
            const div = document.createElement('div');
            div.innerHTML = `<strong>${ch.title}</strong><textarea data-idx="${i}" style="width:100%;min-height:50px">${ch.outline}</textarea>`;
            box.appendChild(div);
        });
        box.querySelectorAll('textarea').forEach(ta => {
            ta.onchange = () => contData.nextOutline[+ta.dataset.idx].outline = ta.value;
        });
        sel.innerHTML = '';
        contData.nextOutline.forEach((ch, i) => {
            const o = document.createElement('option');
            o.value = i; o.textContent = ch.title;
            sel.appendChild(o);
        });
    }

    async function writeContinueChapter() {
        const idx = +document.getElementById('cont-chapter-select').value;
        const ch = contData.nextOutline[idx];
        if (!ch) return;
        const prev = contData.chapters.slice(-2).map(c => c.content).join('\n\n').slice(-2500);
        const style = state.styles.default || state.settings.systemStyle;
        const syn = document.getElementById('cont-synopsis').value;

        log('cont-log', 'Đang viết...');
        const prompt = `Viết tiếp chương tiểu thuyết. Bám sát nội dung trước và outline.
Văn án: ${syn || '(không có)'}
Phong cách: ${style}
Nội dung trước:
${prev}
Outline chương này:
${ch.title}
${ch.outline}
Chỉ trả về nội dung chương.`;

        try {
            const content = await callGrok([
                { role: 'system', content: style },
                { role: 'user', content: prompt }
            ], { maxTokens: 6000 });
            ch.content = content;
            document.getElementById('cont-editor').value = content;
            log('cont-log', 'Xong.');
        } catch (e) {
            log('cont-log', 'Lỗi: ' + e.message);
        }
    }

    function saveContinue() {
        const title = 'Tiếp_' + Date.now();
        const allChapters = [...contData.chapters, ...contData.nextOutline.filter(c => c.content)];
        state.novels[title] = { title, chapters: allChapters, updated: Date.now() };
        saveState();
        refreshNovelSelects();
        log('cont-log', 'Đã lưu.');
    }

    // ========== STYLE LEARN ==========
    async function learnStyle() {
        const file = document.getElementById('style-file').files[0];
        if (!file) return alert('Chọn file mẫu');
        const text = (await file.text()).slice(0, 12000);
        log('style-log', 'Đang phân tích...');

        const prompt = `Phân tích văn phong, cách hành văn, giọng điệu, cấu trúc câu, từ vựng đặc trưng của đoạn văn sau. Viết thành hướng dẫn ngắn gọn (200-400 từ) để AI khác có thể bắt chước phong cách này khi viết tiểu thuyết.
Mẫu:
${text}`;

        try {
            const res = await callGrok([
                { role: 'system', content: 'Bạn là nhà phê bình văn học, chuyên phân tích phong cách.' },
                { role: 'user', content: prompt }
            ]);
            document.getElementById('style-result').value = res;
            state.styles.default = res;
            saveState();
            log('style-log', 'Đã học xong văn phong.');
        } catch (e) {
            log('style-log', 'Lỗi: ' + e.message);
        }
    }

    // ========== EXPORT ==========
    function refreshNovelSelects() {
        const sel = document.getElementById('export-novel');
        if (!sel) return;
        sel.innerHTML = '';
        Object.keys(state.novels).forEach(k => {
            const o = document.createElement('option');
            o.value = k; o.textContent = k;
            sel.appendChild(o);
        });
    }

    function exportNovel(type) {
        const key = document.getElementById('export-novel').value;
        const novel = state.novels[key];
        if (!novel) return alert('Chưa chọn truyện');

        if (type === 'txt') {
            let txt = novel.title + '\n\n';
            (novel.chapters || []).forEach(ch => {
                txt += ch.title + '\n\n' + (ch.content || '') + '\n\n';
            });
            const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = novel.title + '.txt';
            a.click();
            log('export-log', 'Đã tải TXT');
        } else {
            // EPUB2 đơn giản
            const zip = new JSZip();
            zip.file('mimetype', 'application/epub+zip');
            zip.folder('META-INF').file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
            let spine = '', manifest = '', toc = '';
            (novel.chapters || []).forEach((ch, i) => {
                const id = 'chap' + (i + 1);
                const fname = id + '.xhtml';
                const body = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${ch.title}</title></head>
<body><h1>${ch.title}</h1><p>${(ch.content || '').replace(/\n/g, '</p><p>')}</p></body></html>`;
                zip.folder('OEBPS').file(fname, body);
                manifest += `<item id="${id}" href="${fname}" media-type="application/xhtml+xml"/>\n`;
                spine += `<itemref idref="${id}"/>\n`;
                toc += `<navPoint id="nav${i}" playOrder="${i+1}"><navLabel><text>${ch.title}</text></navLabel><content src="${fname}"/></navPoint>\n`;
            });
            zip.folder('OEBPS').file('content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${novel.title}</dc:title><dc:language>vi</dc:language><dc:identifier id="BookId">novelgrok-${Date.now()}</dc:identifier>
</metadata>
<manifest>${manifest}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
<spine toc="ncx">${spine}</spine></package>`);
            zip.folder('OEBPS').file('toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="novelgrok"/></head>
<docTitle><text>${novel.title}</text></docTitle><navMap>${toc}</navMap></ncx>`);
            zip.generateAsync({ type: 'blob' }).then(blob => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = novel.title + '.epub';
                a.click();
                log('export-log', 'Đã tải EPUB2');
            });
        }
    }

    // Init
    createUI();
})();
