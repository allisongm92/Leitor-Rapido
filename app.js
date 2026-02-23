(function() {
    'use strict';

    // CONSTANTES
    const CONTEXT_RANGE = 18; // palavras antes/depois no contexto
    const JUMP_STEP = 30; // avanço/recuo nas zonas de toque
    const SAVE_INTERVAL = 50; // salvar a cada N palavras
    const AUDIO_FREQ = 700; // frequência do metrônomo (Hz)
    const AUDIO_DURATION = 0.012; // duração do beep (segundos)
    const AUDIO_GAIN = 0.012; // volume inicial

    const el = id => document.getElementById(id);
    const UI = {
        cont: el('word-container'), pre: el('txt-prefix'), orp: el('txt-orp'), suf: el('txt-suffix'),
        ctx: el('context-view'), scr: el('scrubber'), wpm: el('meta-wpm'), prog: el('meta-progress'),
        time: el('meta-time'), chap: el('current-chapter-title'), list: el('chapter-list'),
        gPct: el('global-pct'), gTime: el('global-time'), wSlide: el('wpm-slider'), wLarge: el('wpm-large-display')
    };

    const App = { data: [], ptr: 0, play: false, wpm: 350, timer: null, id: null, chaps: [], lock: null };
    const Cfg = { theme: 'dark', font: 'system-ui, sans-serif', size: '12vw', align: 'center', spacing: '4px', lineheight: '1.8', column: '500px', pLong: 1.5, pSent: 2.3, pComma: 1.5, audio: 0 };
    const CfgKeys = ['theme', 'font', 'size', 'align', 'spacing', 'lineheight', 'column', 'pLong', 'pSent', 'pComma', 'audio'];
    
    function showNotification(message, type = 'info') {
        const notification = el('notification');
        notification.textContent = message;
        notification.className = `notification ${type}`;
        // Força um reflow para a transição
        void notification.offsetWidth;
        notification.classList.add('show');
        setTimeout(() => notification.classList.remove('show'), 3000);
    }
    
    let aCtx;
    let activeModal = null; // para focus trap
    let focusableElements = []; // dentro do modal atual
    
    // --- PERSISTÊNCIA DO LIVRO (INDEXEDDB) ---
    const DB_NAME = 'LeitorRapidoDB';
    const STORE_NAME = 'livros';

    function initDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = e => {
                if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
                    e.target.result.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });
    }

    async function saveBookToDB() {
        if (!App.id || App.data.length === 0) return;
        try {
            const db = await initDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ 
                id: App.id, 
                data: App.data, 
                chaps: App.chaps 
            }, 'current_book');
        } catch(e) { 
            console.error('Erro ao salvar livro:', e); 
        }
    }

    async function loadBookFromDB() {
        try {
            const db = await initDB();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get('current_book');
            req.onsuccess = () => {
                const book = req.result;
                if (book && book.data && book.data.length > 0) {
                    App.id = book.id;
                    App.data = book.data;
                    App.chaps = book.chaps;
                    
                    App.ptr = Math.max(0, Math.min(parseInt(localStorage.getItem(App.id) || 0), App.data.length - 1));
                    
                    document.body.classList.add('has-file');
                    render(); 
                    updHud();
                    showNotification('Sessão anterior restaurada!', 'success');
                }
            };
        } catch(e) { 
            console.error('Erro ao restaurar o livro:', e); 
        }
    }

    // --- ÁUDIO ---
    function initAudio() {
        try { aCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
    }
    
    // tick agora é assíncrona e aguarda o contexto ser retomado
    async function tick() {
        if (Cfg.audio == 0 || !aCtx) return;
        if (aCtx.state === 'suspended') {
            try { await aCtx.resume(); } catch (e) { return; }
        }
        const o = aCtx.createOscillator(), g = aCtx.createGain();
        o.connect(g); g.connect(aCtx.destination);
        o.frequency.value = AUDIO_FREQ; o.type = 'sine';
        g.gain.setValueAtTime(AUDIO_GAIN, aCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, aCtx.currentTime + AUDIO_DURATION);
        o.start(aCtx.currentTime); o.stop(aCtx.currentTime + AUDIO_DURATION);
    }

    // --- WAKE LOCK ---
    async function lockReq() {
        try { if ('wakeLock' in navigator) App.lock = await navigator.wakeLock.request('screen'); } catch(e){}
        document.addEventListener('visibilitychange', () => { if (App.lock && document.visibilityState === 'visible') lockReq(); });
    }

    // --- CONFIGURAÇÕES ---
    function setTheme(v) {
        document.querySelectorAll('#cfg-theme-seg .segment-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.val === v);
            b.setAttribute('aria-pressed', b.dataset.val === v);
        });
        Cfg.theme = v; applySettings(true);
    }

    function setAlign(v) {
        document.querySelectorAll('#cfg-align .segment-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.val === v);
            b.setAttribute('aria-pressed', b.dataset.val === v);
        });
        Cfg.align = v; applySettings(true);
    }

    function loadSettings() {
        const stored = JSON.parse(localStorage.getItem('rsvp-cfg') || '{}');
        if (!stored.theme) stored.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        Object.assign(Cfg, stored);
        
        CfgKeys.forEach(k => { const inp = el(`cfg-${k}`); if (inp) inp.value = Cfg[k]; });
        App.wpm = Cfg.wpm || 350;
        UI.wpm.innerText = App.wpm + " WPM";
        UI.wSlide.value = App.wpm;
        UI.wLarge.innerText = App.wpm;
        setTheme(Cfg.theme || 'dark');
        setAlign(Cfg.align || 'center');
        applySettings(false);
    }

    function applySettings(save = true) {
        CfgKeys.forEach(k => { const inp = el(`cfg-${k}`); if (inp) Cfg[k] = inp.value; });
        ['pLong', 'pSent', 'pComma'].forEach(k => Cfg[k] = parseFloat(Cfg[k]));
        
        document.documentElement.setAttribute('data-theme', Cfg.theme);
        document.body.setAttribute('data-align', Cfg.align);
        const R = document.documentElement.style;
        R.setProperty('--font-family', Cfg.font);
        R.setProperty('--font-size', Cfg.size);
        R.setProperty('--word-spacing', Cfg.spacing);
        R.setProperty('--line-height', Cfg.lineheight);
        R.setProperty('--column-width', Cfg.column);
        R.setProperty('--letter-spacing', Cfg.align === 'center' ? '-1px' : '0px');
        
        if (save) localStorage.setItem('rsvp-cfg', JSON.stringify({ ...Cfg, wpm: App.wpm }));
        if (!App.play) render();
    }

    // --- MODAIS E FOCUS TRAP ---
    function setupFocusTrap(modalId) {
        const modal = el(modalId);
        if (!modal) return;
        focusableElements = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusableElements.length) focusableElements[0].focus();
        activeModal = modal;
    }

    function releaseFocusTrap() {
        activeModal = null;
    }

    function toggleModal(id) {
        const m = el(id);
        const opening = !m.classList.contains('open');
        if (opening && App.play) pause();
        if (id === 'chapters-modal' && opening) { renderList(); updateGStats(); }
        m.classList.toggle('open');
        
        if (opening) {
            setupFocusTrap(id);
        } else {
            releaseFocusTrap();
            if (id === 'settings-modal') el('btn-settings')?.focus();
            else if (id === 'chapters-modal') el('btn-chapters')?.focus();
            else if (id === 'wpm-modal') el('meta-wpm')?.focus();
        }
    }

    document.addEventListener('keydown', e => {
        if (!activeModal) return;
        
        if (e.key === 'Tab') {
            const focusable = Array.from(focusableElements);
            if (!focusable.length) return;
            
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            
            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
        
        if (e.key === 'Escape') {
            toggleModal(activeModal.id);
        }
    });

    // --- EVENT LISTENERS ---
    el('btn-chapters').addEventListener('click', () => toggleModal('chapters-modal'));
    el('btn-settings').addEventListener('click', () => toggleModal('settings-modal'));
    el('btn-close-wpm').addEventListener('click', () => toggleModal('wpm-modal'));
    el('btn-close-chapters').addEventListener('click', () => toggleModal('chapters-modal'));
    el('btn-close-settings').addEventListener('click', () => toggleModal('settings-modal'));
    el('meta-wpm').addEventListener('click', () => toggleModal('wpm-modal'));
    el('btn-open-file').addEventListener('click', () => el('file-input').click());

    document.querySelectorAll('.modal-overlay').forEach(o => {
        o.addEventListener('click', e => { if (e.target === o) toggleModal(o.id); });
    });

    document.querySelectorAll('#cfg-theme-seg .segment-btn').forEach(b => {
        b.addEventListener('click', () => setTheme(b.dataset.val));
    });

    document.querySelectorAll('#cfg-align .segment-btn').forEach(b => {
        b.addEventListener('click', () => setAlign(b.dataset.val));
    });

    UI.wSlide.addEventListener('input', (e) => {
        App.wpm = parseInt(e.target.value);
        UI.wLarge.innerText = App.wpm;
        UI.wpm.innerText = App.wpm + " WPM";
        localStorage.setItem('rsvp-cfg', JSON.stringify({ ...Cfg, wpm: App.wpm }));
        if (!App.play) updHud(false);
    });

    // --- CARREGAMENTO DE ARQUIVOS ---
    document.addEventListener('dragover', e => { e.preventDefault(); document.body.style.opacity = '0.7'; });
    document.addEventListener('dragleave', e => { e.preventDefault(); document.body.style.opacity = '1'; });
    document.addEventListener('drop', async e => {
        e.preventDefault();
        document.body.style.opacity = '1';
        if (e.dataTransfer.files.length) {
            await handleFileLoad(e.dataTransfer.files[0]);
        }
    });

async function handleFileLoad(file) {
        // SEGURANÇA: Para qualquer leitura em andamento e reseta o estado
        if (App.play) pause();
        App.ptr = 0;
        
        document.body.classList.add('has-file');
        UI.orp.innerText = "A carregar..."; UI.pre.innerText = ""; UI.suf.innerText = "";
        App.id = file.name + file.size;
        
        if (file.name.toLowerCase().endsWith('.txt')) {
            parseTxt(await file.text());
            showNotification(`Arquivo TXT carregado com sucesso`, 'success');
        } else {
            const r = new FileReader();
            r.onload = ev => {
                parseEpub(ev.target.result).then(() => {
                    if (App.data.length > 0) showNotification(`Livro carregado com sucesso!`, 'success');
                });
            };
            r.readAsArrayBuffer(file);
        }
    }
    
    el('file-input').addEventListener('change', async (e) => {
        if (!e.target.files[0]) return;
        const modal = document.getElementById('settings-modal');
        if (modal.classList.contains('open')) toggleModal('settings-modal');
        await handleFileLoad(e.target.files[0]);
    });

    function parseTxt(text) {
        App.data = []; App.chaps = [];
        const words = text.replace(/\n/g, ' ').split(' ').filter(w => w.length > 0);
        if (!words.length) { showNotification("Arquivo vazio ou formato inválido", "error"); UI.orp.innerText = "Arquivo vazio"; return; }
        App.data.push(...words);
        App.chaps.push({ title: "Documento Completo", idx: 0 });
        App.ptr = Math.max(0, Math.min(parseInt(localStorage.getItem(App.id) || 0), App.data.length - 1));
        saveBookToDB();
        render(); updHud();
    }

    async function parseEpub(buf) {
        const b = ePub(buf);
        await b.ready;
        App.data = []; App.chaps = [];
        if (!b.spine?.spineItems?.length) {
            showNotification("Arquivo inválido ou DRM protegido", "error"); document.body.classList.remove("has-file"); UI.orp.innerText = "Protegido";
            return;
        }
        
        let cC = 1;
        const totalChaps = b.spine.spineItems.length;
        
        for (let i of b.spine.spineItems) {
            UI.orp.innerText = `Carregando capítulo ${cC} de ${totalChaps}...`;
            await new Promise(resolve => setTimeout(resolve, 0));
            
            try {
                const d = await i.load(b.load.bind(b));
                if (!d) continue;
                const t = d.querySelector('h1,h2,title');
                App.chaps.push({ title: t ? t.textContent.replace(/\s+/g, ' ').trim().substring(0, 35) : `Seção ${cC}`, idx: App.data.length });
                
                const els = d.querySelectorAll('p,h1,h2,h3,li,blockquote');
                if (els.length) {
                    Array.from(els).forEach(e => {
                        const txt = e.textContent.replace(/\s+/g, ' ').trim();
                        if (txt) App.data.push(...txt.split(' ').filter(Boolean));
                    });
                } else {
                    App.data.push(...d.body.textContent.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean));
                }
                cC++;
            } catch(err) {
                console.debug('Erro capítulo', err);
            } finally {
                i.unload();
            }
        }
        if (!App.data.length) { showNotification("DRM Protegido ou Vazio", "error"); document.body.classList.remove("has-file"); UI.orp.innerText = "Protegido"; return; }
        App.ptr = Math.max(0, Math.min(parseInt(localStorage.getItem(App.id) || 0), App.data.length - 1));
        saveBookToDB();
        render(); updHud();
    }

    // --- LÓGICA DE LEITURA ---
    function getBounds() {
        if (!App.chaps.length) return { s: 0, e: Math.max(0, App.data.length - 1), c: 0 };
        let s = 0, e = App.data.length - 1, c = 0;
        for (let i = App.chaps.length - 1; i >= 0; i--) {
            if (App.ptr >= App.chaps[i].idx) { s = App.chaps[i].idx; c = i; break; }
        }
        if (c < App.chaps.length - 1) e = App.chaps[c + 1].idx - 1;
        return { s, e, c };
    }

    function updateGStats() {
        if (!App.data.length) return;
        const t = Math.ceil((App.data.length - App.ptr) / App.wpm);
        UI.gPct.innerText = `Geral ${((App.ptr / App.data.length) * 100).toFixed(1)}%`;
        const h = Math.floor(t / 60), m = t % 60;
        UI.gTime.innerText = `Faltam ${h > 0 ? h + 'h ' : ''}${m}m`;
    }

    function renderList() {
        const b = getBounds();
        UI.list.innerHTML = '';
        if (!App.chaps.length) {
            const li = document.createElement('li');
            li.className = 'chapter-item';
            li.style.cssText = 'justify-content:center;color:var(--guide);border:none;';
            li.textContent = 'Vazio';
            UI.list.appendChild(li);
            return;
        }
        App.chaps.forEach((c, i) => {
            const li = document.createElement('li');
            li.className = `chapter-item ${i === b.c ? 'active-chap' : ''}`;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', i === b.c);
            li.addEventListener('click', () => {
                App.ptr = c.idx;
                toggleModal('chapters-modal');
                render(); updHud(true); renderCtx();
                UI.ctx.classList.add('active');
                UI.cont.style.opacity = .05;
            });
            const span = document.createElement('span');
            span.textContent = c.title;
            li.appendChild(span);
            UI.list.appendChild(li);
        });
        setTimeout(() => UI.list.querySelector('.active-chap')?.scrollIntoView({ block: 'center' }), 50);
    }

    function jump(i) {
        if (i < 0 || i >= App.data.length) return;
        App.ptr = i;
        render(); updHud(false); renderCtx();
    }

function render() {
        if (App.ptr >= App.data.length) return pause();
        let r = App.data[App.ptr];
        if (!r || !r.trim()) r = "—";
        
        if (Cfg.align === 'edge') {
            UI.pre.innerText = ""; UI.suf.innerText = ""; UI.orp.innerText = r;
        } else {
            // LÓGICA CORRIGIDA: Ignora pontuação inicial para o cálculo do centro
            const match = r.match(/^[\W_]*/); // Captura pontuação no início (ex: "(", "¿", "-")
            const prefixLen = match ? match[0].length : 0;
            
            // Remove pontuação para calcular o tamanho real da palavra
            const cleanWord = r.replace(/[.,?!:;"'()\[\]{}]/g, ""); 
            const cLen = cleanWord.length;
            
            let cIdx = Math.floor(cLen / 2);
            if (cLen > 3 && cLen < 20) cIdx = Math.max(0, cIdx - 1);
            
            // O índice absoluto é o deslocamento da pontuação + o centro da palavra limpa
            const absoluteIdx = prefixLen + cIdx;

            UI.pre.innerText = r.slice(0, absoluteIdx);
            UI.orp.innerText = r[absoluteIdx] || "";
            UI.suf.innerText = r.slice(absoluteIdx + 1);
        }
    }

    function renderCtx() {
        if (!App.data.length) return;
        const b = getBounds();
        const start = Math.max(b.s, App.ptr - CONTEXT_RANGE);
        const end = Math.min(b.e + 1, App.ptr + CONTEXT_RANGE);
        UI.ctx.innerHTML = '';
        for (let i = start; i < end; i++) {
            if (!App.data[i] || !App.data[i].trim()) continue;
            const span = document.createElement('span');
            span.className = `context-word ${i === App.ptr ? 'context-highlight' : ''}`;
            span.textContent = App.data[i];
            span.addEventListener('click', () => jump(i));
            UI.ctx.appendChild(span);
            UI.ctx.appendChild(document.createTextNode(' '));
        }
    }

async function advance() {
        if (App.ptr >= App.data.length) { pause(); return; }
        render(); 
        await tick(); 
        
        // SEGURANÇA: Verifica se os dados ainda existem após a pausa assíncrona do tick()
        // Isso impede o crash se o usuário trocou de arquivo durante o "bip"
        if (!App.data || App.data.length === 0) return pause();
        
        const w = App.data[App.ptr];
        let ms = 60000 / App.wpm;
        if (!w || !w.trim()) ms *= 3;
        else if (w.length < 4) ms *= 0.8;
        else if (w.length > 8) ms *= Cfg.pLong;
        ms *= /[.?!]/.test(w) ? Cfg.pSent : /,/.test(w) ? Cfg.pComma : 1;
        
        App.ptr++;
        
        if (App.ptr % SAVE_INTERVAL === 0) localStorage.setItem(App.id, App.ptr);
        
        if (App.ptr >= App.data.length) { pause(); return; }
        App.timer = setTimeout(advance, ms);
    }

    function toggle() {
        if (!App.data.length) { toggleModal('settings-modal'); return; }
        App.play ? pause() : play();
    }

    async function play() {
        if (App.play) return;
        App.play = true;
        if (!aCtx) initAudio();
        await lockReq();
        document.body.classList.add('is-reading');
        UI.ctx.classList.remove('active');
        UI.cont.style.opacity = 1;
        advance();
    }

    function pause() {
        App.play = false;
        clearTimeout(App.timer);
        if (App.lock) App.lock.release().then(() => App.lock = null);
        document.body.classList.remove('is-reading');
        if (App.id) localStorage.setItem(App.id, App.ptr);
        
        updHud(true);
        renderCtx();
        UI.ctx.classList.add('active');
        UI.cont.style.opacity = .05;
    }

    function move(dir) {
        if (!App.data.length) return;
        pause();
        const b = getBounds();
        App.ptr = dir < 0 ? Math.max(b.s, App.ptr - JUMP_STEP) : Math.min(b.e, App.ptr + JUMP_STEP);
        render(); updHud(); renderCtx();
    }

    const rewind = () => move(-1);
    const forward = () => move(1);

    el('zone-left').addEventListener('click', rewind);
    el('zone-center').addEventListener('click', toggle);
    el('zone-right').addEventListener('click', forward);

    function updHud(fc = true) {
        if (!App.data.length) return;
        requestAnimationFrame(() => {
            const b = getBounds();
            UI.scr.min = b.s;
            UI.scr.max = b.e;
            UI.scr.value = App.ptr;
            UI.prog.innerText = `${(((App.ptr - b.s) / Math.max(1, (b.e - b.s))) * 100).toFixed(0)}%`;
            UI.time.innerText = `${Math.ceil((b.e - App.ptr) / App.wpm)}m`;
            if (fc && App.chaps[b.c]) UI.chap.innerText = App.chaps[b.c].title;
        });
    }

    UI.scr.addEventListener('input', e => {
        if (App.play) pause();
        App.ptr = parseInt(e.target.value);
        render(); renderCtx(); updHud(false);
    });

    document.addEventListener('keydown', e => {
        if (document.querySelector('.modal-overlay.open')) return;
        if (e.code === 'Space') { e.preventDefault(); toggle(); }
        else if (e.code === 'ArrowLeft') rewind();
        else if (e.code === 'ArrowRight') forward();
    });

    window.addEventListener('beforeunload', () => {
        if (App.id && App.data.length > 0) {
            localStorage.setItem(App.id, App.ptr);
        }
    });

    CfgKeys.forEach(k => {
        const i = el(`cfg-${k}`);
        if (i && !['theme','align'].includes(k)) i.addEventListener('change', () => applySettings());
    });

    // --- INICIALIZAÇÃO ---
    loadSettings();
    loadBookFromDB();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.debug('SW:', err));
    }

})();
