document.addEventListener('DOMContentLoaded', function() {


    // --- Utility Functions ---
    function $(sel, root) {
        return (root || document).querySelector(sel);
    }

    function $all(sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    }

    function on(el, type, handler) {
        if (el) el.addEventListener(type, handler);
    }

    function openModal(modal) {
        if (modal) modal.removeAttribute('hidden');
    }

    function closeModal(modal) {
        if (modal) modal.setAttribute('hidden', '');
    }

    // ---- Cache/SW and scrollbar width var ----
    (async () => {
        if ('serviceWorker' in navigator) {
            try {
                const regs = await navigator.serviceWorker.getRegistrations();
                for (const r of regs) await r.unregister();
            } catch (e) {}
        }
        try {
            const sw = window.innerWidth - document.documentElement.clientWidth;
            document.documentElement.style.setProperty('--sbw', sw + 'px');
        } catch (e) {}
    })();

    // ---- Elements ----
    const adminButton = $('#admin-button');
    const adminToolbar = $('#admin-toolbar');
    const changelogBar = $('#changelog-bar');
    const loginModal = $('#login-modal');
    const passwordModal = $('#password-modal');
    const tagsModal = $('#tags-modal');
    const tableModal = $('#table-modal');
    const exportModal = $('#export-modal');

    const DEFAULT_ADMIN_ID = 'admin';
    const DEFAULT_ADMIN_PASSWORD = '123123123';
    let isAdmin = false;
    let editMode = false;
    let lastRange = null;

    // ---- Dirty tracking & History ----
    const dirtySectionIdSet = new Set();
    let historyStack = [];
    let historyIndex = -1;

    function getMainContentRoot() {
        return $('.main-content') || document.body;
    }

    function markDirtyFromNode(node) {
        if (!node) return;
        const section = node.closest ? node.closest('.rule-section') : null;
        if (section && section.id) {
            const oldContent = (historyStack[historyIndex] && historyStack[historyIndex].html) || '';
            const currentContent = section.innerHTML;
            if (oldContent !== currentContent) {
                dirtySectionIdSet.add(section.id);
            }
        }
    }

    function updateUndoRedoButtons() {
        const undoBtn = $('#undo-action');
        const redoBtn = $('#redo-action');
        if (undoBtn) undoBtn.disabled = !(historyIndex > 0);
        if (redoBtn) redoBtn.disabled = !(historyIndex >= 0 && historyIndex < historyStack.length - 1);
    }

    function pushHistoryIfChanged(reason) {
        const root = getMainContentRoot();
        if (!root) return;
        const currentHtml = root.innerHTML;
        if (historyIndex >= 0 && historyStack[historyIndex] && historyStack[historyIndex].html === currentHtml) {
            return;
        }
        if (historyIndex < historyStack.length - 1) {
            historyStack = historyStack.slice(0, historyIndex + 1);
        }
        historyStack.push({
            html: currentHtml,
            scrollY: window.scrollY,
            reason: reason || '',
            ts: Date.now()
        });
        historyIndex = historyStack.length - 1;
        updateUndoRedoButtons();
    }

    function restoreHistoryAt(index) {
        const root = getMainContentRoot();
        if (!root || index < 0 || index >= historyStack.length) return;
        const state = historyStack[index];
        root.innerHTML = state.html;
        enableContentEditable(editMode);
        bindAccordionHeaders(root);
        refreshTOC();
        window.scrollTo({
            top: state.scrollY || 0
        });
        updateUndoRedoButtons();
    }

    function undoOnce() {
        if (historyIndex > 0) {
            historyIndex -= 1;
            restoreHistoryAt(historyIndex);
        }
    }

    function redoOnce() {
        if (historyIndex < historyStack.length - 1) {
            historyIndex += 1;
            restoreHistoryAt(historyIndex);
        }
    }

    let tags = [];
    try {
        tags = JSON.parse(localStorage.getItem('rule_tags') || '[]');
    } catch (e) {
        tags = [];
    }

    // ---- Modal close buttons ----
    $all('[data-close-modal]').forEach(function(btn) {
        on(btn, 'click', function() {
            closeModal(btn.closest('.modal'));
        });
    });

    // ---- Login flow ----
    on(adminButton, 'click', function() {
        const id = $('#login-id');
        if (id) id.value = '';
        const pw = $('#login-password');
        if (pw) pw.value = '';
        const err = $('#login-error');
        if (err) err.textContent = '';
        openModal(loginModal);
    });

    on($('#login-submit'), 'click', function() {
        const id = ($('#login-id') || {}).value || '';
        const pw = ($('#login-password') || {}).value || '';
        const storedHash = localStorage.getItem('admin_pw_hash');
        if (!storedHash) {
            if (id === DEFAULT_ADMIN_ID && pw === DEFAULT_ADMIN_PASSWORD) {
                afterAuth(true, true);
            } else {
                showLoginError('IDまたはパスワードが違います');
            }
            return;
        }
        hashString(pw).then(function(h) {
            afterAuth(h === storedHash, false);
        });
    });

    function showLoginError(msg) {
        const el = $('#login-error');
        if (el) el.textContent = msg;
    }

    function afterAuth(ok) {
        if (!ok) {
            showLoginError('IDまたはパスワードが違います');
            return;
        }
        isAdmin = true;
        editMode = false; // 初期状態は編集モードオフ
        if (adminToolbar) adminToolbar.hidden = false;
        closeModal(loginModal);
        enableContentEditable(false); // 編集モードは手動で有効化
        try {
            sessionStorage.setItem('admin_session', '1');
        } catch (e) {}
    }

    async function hashString(str) {
        const enc = new TextEncoder().encode(str);
        const digest = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(digest)).map(function(b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    on($('#password-save'), 'click', async function() {
        const p1 = ($('#new-password') || {}).value || '';
        const p2 = ($('#new-password-2') || {}).value || '';
        const err = $('#password-error');
        if (p1.length < 8) {
            if (err) err.textContent = '8文字以上のパスワードを入力してください';
            return;
        }
        if (p1 !== p2) {
            if (err) err.textContent = '確認用パスワードが一致しません';
            return;
        }
        const hash = await hashString(p1);
        localStorage.setItem('admin_pw_hash', hash);
        closeModal(passwordModal);
    });

    // Restore session
    try {
        const sp = new URLSearchParams(location.search);
        const forceOff = (sp.get('admin') || '').toLowerCase() === 'off';
        const was = sessionStorage.getItem('admin_session') === '1';
        if (forceOff) sessionStorage.removeItem('admin_session');
        if (!forceOff && was) {
            isAdmin = true;
            editMode = false; // デフォルトで編集モードをオフに
            if (adminToolbar) adminToolbar.hidden = false;
            enableContentEditable(false); // 初期状態は編集不可
        } else {
            if (adminToolbar) adminToolbar.hidden = true;
            enableContentEditable(false);
        }
    } catch (e) {}

    // ---- Editing mode ----
    function enableContentEditable(onState) {
        editMode = onState;
        $all('.rule-card, .accordion-content, .rule-section h2, .card, table, th, td, p, li, h3, h4').forEach(function(el) {
            el.setAttribute('contenteditable', onState ? 'true' : 'false');
        });
        // アコーディオンヘッダーは常にcontenteditable="false"に保つ
        $all('.accordion-header').forEach(function(el) {
            el.setAttribute('contenteditable', 'false');
        });
        document.body.classList.toggle('admin-editing', onState);
        if (onState) {
            pushHistoryIfChanged('enter-edit-mode');
            updateUndoRedoButtons();
        }
    }

    on($('#toggle-edit'), 'click', function() {
        enableContentEditable(true);
    });

    on($('#toggle-preview'), 'click', function() {
        enableContentEditable(false);
    });

    on($('#change-password'), 'click', function() {
        openModal(passwordModal);
    });

    on($('#logout-admin'), 'click', function() {
        try {
            sessionStorage.removeItem('admin_session');
        } catch (e) {}
        isAdmin = false;
        enableContentEditable(false);
        if (adminToolbar) adminToolbar.hidden = true;
        alert('Adminを終了しました');
    });

    // Toolbar formatting
    on(adminToolbar, 'click', function(e) {
        var btn = e.target && e.target.closest && e.target.closest('button[data-cmd]');
        if (!btn || !editMode) return;

        try {
            var sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
                lastRange = sel.getRangeAt(0).cloneRange();
            }

            if (lastRange) {
                sel.removeAllRanges();
                sel.addRange(lastRange);
            }

            var cmd = btn.getAttribute('data-cmd');
            var val = btn.getAttribute('data-value') || undefined;

            pushHistoryIfChanged('before-' + cmd);

            if (cmd === 'createLink') {
                var href = window.prompt('リンクURL');
                if (!href) return;
                document.execCommand('createLink', false, href);
            } else if (cmd === 'formatBlock') {
                document.execCommand('formatBlock', false, val);
            } else {
                document.execCommand(cmd, false, val);
            }

            var active = document.activeElement;
            if (active) {
                markDirtyFromNode(active);
                pushHistoryIfChanged('after-' + cmd);
            }
        } catch (e) {
            console.error('ツールバー操作中にエラーが発生しました:', e);
        }
    });

    on($('#color-picker'), 'input', function(e) {
        document.execCommand('foreColor', false, e.target.value);
    });

    // ---- Tags ----
    function saveTags() {
        localStorage.setItem('rule_tags', JSON.stringify(tags));
    }

    function hexWithAlpha(hex, alpha) {
        return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
    }

    function renderTags() {
        var list = $('#tags-list');
        if (!list) return;
        list.innerHTML = '';
        tags.forEach(function(t) {
            var chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.style.background = hexWithAlpha(t.color, 0.15);
            chip.style.border = '1px solid ' + t.color;
            chip.style.color = t.color;
            chip.textContent = t.name;
            chip.setAttribute('draggable', 'true');
            var rm = document.createElement('span');
            rm.className = 'remove';
            rm.textContent = '×';
            on(rm, 'click', function() {
                tags = tags.filter(function(x) {
                    return x.name !== t.name;
                });
                saveTags();
                renderTags();
            });
            chip.appendChild(rm);
            list.appendChild(chip);
        });
    }

    on($('#manage-tags'), 'click', function() {
        openModal(tagsModal);
        renderTags();
    });

    on($('#add-tag'), 'click', function() {
        var name = ($('#tag-name') || {}).value || '';
        var color = ($('#tag-color') || {}).value || '#ff9900';
        if (!name) return;
        if (tags.some(function(t) {
                return t.name === name;
            })) return;
        tags.push({
            name: name,
            color: color
        });
        saveTags();
        renderTags();
    });

    on($('#tags-list'), 'dragstart', function(e) {
        if (e.target && e.target.classList.contains('tag-chip')) {
            e.dataTransfer.setData('text/plain', e.target.textContent.replace('×', '').trim());
        }
    });

    on(document, 'dragover', function(e) {
        if (editMode) e.preventDefault();
    });

    on(document, 'drop', function(e) {
        if (!editMode) return;
        var name = e.dataTransfer.getData('text/plain');
        if (!name) return;
        var tag = tags.find(function(t) {
            return t.name === name;
        });
        if (!tag) return;
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        applyTag(el.closest('.rule-card, .accordion-header, .accordion-content, .rule-section'), tag);
    });

    function applyTag(target, t) {
        if (!target) return;
        var bar = target.querySelector('.tag-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'tag-bar';
            target.prepend(bar);
        }
        var chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.style.background = hexWithAlpha(t.color, 0.15);
        chip.style.border = '1px solid ' + t.color;
        chip.style.color = t.color;
        chip.textContent = t.name;
        bar.appendChild(chip);
    }

    // ---- Table insertion & ops ----
    on($('#insert-table'), 'click', function() {
        openModal(tableModal);
    });

    on($('#confirm-insert-table'), 'click', function() {
        closeModal(tableModal);
        var cols = Math.max(1, parseInt((($('#table-cols') || {}).value) || '3', 10));
        var rows = Math.max(1, parseInt((($('#table-rows') || {}).value) || '3', 10));
        var useHeader = (($('#table-header') || {}).checked) || false;
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var tbody = document.createElement('tbody');
        if (useHeader) {
            var tr = document.createElement('tr');
            for (var c = 0; c < cols; c++) {
                var th = document.createElement('th');
                th.textContent = '列' + (c + 1);
                tr.appendChild(th);
            }
            thead.appendChild(tr);
        }
        for (var r = 0; r < rows; r++) {
            var trb = document.createElement('tr');
            for (var cc = 0; cc < cols; cc++) {
                var td = document.createElement('td');
                td.textContent = 'セル';
                trb.appendChild(td);
            }
            tbody.appendChild(trb);
        }
        table.appendChild(thead);
        table.appendChild(tbody);
        var sel = window.getSelection();
        if (sel && sel.rangeCount) {
            sel.getRangeAt(0).insertNode(table);
        } else {
            ($('.main-content') || document.body).appendChild(table);
        }
    });

    function focusedCell() {
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        var n = sel.anchorNode;
        if (n && n.nodeType === 3) n = n.parentElement;
        return n && n.closest ? n.closest('td,th') : null;
    }

    on($('#tbl-add-row'), 'click', function() {
        var cell = focusedCell();
        if (!cell) return;
        var tr = cell.parentElement;
        var cols = tr.children.length;
        var newTr = document.createElement('tr');
        for (var i = 0; i < cols; i++) {
            var td = document.createElement('td');
            td.textContent = 'セル';
            newTr.appendChild(td);
        }
        tr.parentElement.appendChild(newTr);
        markDirtyFromNode(tr.closest('table'));
        pushHistoryIfChanged('tbl-add-row');
    });

    on($('#tbl-add-col'), 'click', function() {
        var cell = focusedCell();
        if (!cell) return;
        var table = cell.closest('table');
        if (!table) return;
        $all('tr', table).forEach(function(r) {
            var isHead = r.closest('thead');
            var el = document.createElement(isHead ? 'th' : 'td');
            el.textContent = isHead ? '列' : 'セル';
            r.appendChild(el);
        });
        markDirtyFromNode(table);
        pushHistoryIfChanged('tbl-add-col');
    });

    on($('#tbl-merge'), 'click', function() {
        var cell = focusedCell();
        if (!cell) return;
        var next = cell.nextElementSibling;
        if (!next) return;
        cell.colSpan = (cell.colSpan || 1) + (next.colSpan || 1);
        next.remove();
        markDirtyFromNode(cell.closest('table'));
        pushHistoryIfChanged('tbl-merge');
    });

    on($('#tbl-toggle-head'), 'click', function() {
        var cell = focusedCell();
        var table = cell ? cell.closest('table') : null;
        if (!table) return;
        var thead = table.querySelector('thead');
        if (thead) {
            var headRow = thead.querySelector('tr');
            var tbody = table.querySelector('tbody') || table.appendChild(document.createElement('tbody'));
            var newTr = document.createElement('tr');
            $all('th', headRow).forEach(function(th) {
                var td = document.createElement('td');
                td.innerHTML = th.innerHTML;
                newTr.appendChild(td);
            });
            tbody.prepend(newTr);
            thead.remove();
        } else {
            var tb = table.querySelector('tbody');
            if (!tb || !tb.firstElementChild) return;
            var first = tb.firstElementChild;
            var newThead = document.createElement('thead');
            var tr = document.createElement('tr');
            $all('td', first).forEach(function(td) {
                var th = document.createElement('th');
                th.innerHTML = td.innerHTML;
                tr.appendChild(th);
            });
            newThead.appendChild(tr);
            table.insertBefore(newThead, tb);
            first.remove();
        }
        markDirtyFromNode(table);
        pushHistoryIfChanged('tbl-toggle-head');
    });

    // ---- New section templates ----
    on($('#add-section'), 'click', function() {
        var menu = $('#section-templates');
        if (menu) menu.hidden = !menu.hidden;
    });

    on($('#section-templates'), 'click', function(e) {
        var btn = e.target && e.target.closest && e.target.closest('button[data-template]');
        if (!btn) return;
        addSectionByTemplate(btn.getAttribute('data-template'));
        var menu = $('#section-templates');
        if (menu) menu.hidden = true;
    });

    var sectionCounter = 0;

    function generateAnchorId(base) {
        sectionCounter += 1;
        return base + '-' + Date.now().toString(36) + '-' + sectionCounter;
    }

    function addSectionByTemplate(tpl) {
        var sec = document.createElement('section');
        sec.className = 'rule-section';
        sec.id = generateAnchorId('rule-section');
        var card = document.createElement('div');
        card.className = 'rule-card';
        if (tpl === 'heading-body') {
            card.innerHTML = '<h3>新しい見出し</h3><p>本文を編集してください。</p>';
        } else if (tpl === 'heading-table') {
            card.innerHTML = '<h3>新しい見出し</h3>';
            var tbl = document.createElement('table');
            var thead = document.createElement('thead');
            var tr = document.createElement('tr');
            ['列1', '列2', '列3'].forEach(function(t) {
                var th = document.createElement('th');
                th.textContent = t;
                tr.appendChild(th);
            });
            thead.appendChild(tr);
            var tbody = document.createElement('tbody');
            for (var i = 0; i < 3; i++) {
                var r = document.createElement('tr');
                for (var j = 0; j < 3; j++) {
                    var d = document.createElement('td');
                    d.textContent = 'セル';
                    r.appendChild(d);
                }
                tbody.appendChild(r);
            }
            tbl.appendChild(thead);
            tbl.appendChild(tbody);
            card.appendChild(tbl);
        } else if (tpl === 'faq') {
            card.innerHTML = '<h3>FAQ</h3><ul><li><b>Q:</b> 質問 <br/><b>A:</b> 回答</li></ul>';
        }
        sec.appendChild(card);
        ($('.main-content') || document.body).appendChild(sec);
        refreshTOC();
        enableContentEditable(true);
        pushChangelog([{
            date: formatDate(new Date()),
            title: '新しい項目を追加',
            anchor: '#' + sec.id
        }]);
        markDirtyFromNode(sec);
        pushHistoryIfChanged('add-section:' + (tpl || 'unknown'));
    }

    function refreshTOC() {
        var navUl = $('#table-of-contents ul');
        if (!navUl) return;
        navUl.innerHTML = '';
        $all('.rule-section').forEach(function(section) {
            var title = (section.querySelector('h2') || section.querySelector('h3'));
            title = title ? title.textContent : '項目';
            var id = section.id;
            var li = document.createElement('li');
            var a = document.createElement('a');
            a.textContent = title;
            a.href = '#' + id;
            li.appendChild(a);
            navUl.appendChild(li);
        });
    }

    // ---- Save & changelog ----
    on($('#save-changes'), 'click', function() {
        var items = [];
        if (dirtySectionIdSet.size > 0) {
            dirtySectionIdSet.forEach(function(id) {
                var sec = document.getElementById(id);
                if (!sec) return;
                var t = (sec.querySelector('h2') || sec.querySelector('h3'));
                var title = t ? t.textContent.trim() : '更新項目';
                items.push({
                    date: formatDate(new Date()),
                    title: title,
                    anchor: '#' + id
                });
            });
        }
        if (items.length === 0) {
            alert('変更はありません');
            return;
        }
        pushChangelog(items);
        try {
            localStorage.setItem('rule_last_saved_html', ($('.main-content') || document.body).innerHTML);
        } catch (e) {}
        dirtySectionIdSet.clear();
        alert('保存しました');
    });

    function pushChangelog(items) {
        const list = $('#changelog-list');
        if (!list) return;
        list.innerHTML = '';

        items.forEach(function(ch) {
            const btn = document.createElement('button');
            btn.className = 'change-pill';

            const dateSpan = document.createElement('span');
            dateSpan.className = 'date';
            dateSpan.textContent = `【${ch.date}】`;
            btn.appendChild(dateSpan);

            const titleSpan = document.createElement('span');
            titleSpan.textContent = ch.title;
            btn.appendChild(titleSpan);

            btn.setAttribute('data-anchor', ch.anchor);

            on(btn, 'click', function() {
                const anchor = this.getAttribute('data-anchor');
                if (anchor) {
                    const target = document.querySelector(anchor);
                    if (target) {
                        target.scrollIntoView({
                            behavior: 'smooth'
                        });
                    }
                }
            });

            list.appendChild(btn);
        });
    }

    function formatDate(d) {
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return mm + '/' + dd;
    }

    // ---- Export ----
    async function exportContent() {
        try {
            const mainContent = $('.main-content');
            const removeChangelog = $('#remove-changelog') && $('#remove-changelog').checked;
            let htmlOut = '';

            if (mainContent) {
                const temp = mainContent.cloneNode(true);
                if (removeChangelog) {
                    const changelog = temp.querySelector('#changelog-bar');
                    if (changelog) {
                        changelog.remove();
                    }
                }
                htmlOut = temp.innerHTML;
            }

            let cssText = '';
            let jsText = '';

            try {
                const linkEl = document.querySelector('link[rel="stylesheet"]');
                if (linkEl && linkEl.href) {
                    const response = await fetch(linkEl.href, {
                        cache: 'no-store'
                    });
                    cssText = await response.text();
                }
            } catch (e) {
                cssText = '/* CSSの取得に失敗しました */';
            }

            try {
                const scriptEl = document.querySelector('script[data-asset="app-script"]');
                if (scriptEl && scriptEl.src) {
                    const response = await fetch(scriptEl.src, {
                        cache: 'no-store'
                    });
                    jsText = await response.text();
                }
            } catch (e) {
                jsText = '/* JSの取得に失敗しました */';
            }

            return {
                html: htmlOut || '<!-- コンテンツなし -->',
                css: cssText || '/* CSSなし */',
                js: jsText || '/* JSなし */'
            };
        } catch (error) {
            console.error('エクスポートエラー:', error);
            return {
                html: '<!-- エラー: ' + error.message + ' -->',
                css: '/* エラー: ' + error.message + ' */',
                js: '/* エラー: ' + error.message + ' */'
            };
        }
    }

    async function handleExport() {
        try {
            const content = await exportContent();
            const taH = $('#export-html');
            const taC = $('#export-css');
            const taJ = $('#export-js');

            if (taH) taH.value = content.html;
            if (taC) taC.value = content.css;
            if (taJ) taJ.value = content.js;
        } catch (error) {
            console.error('エクスポート処理エラー:', error);
        }
    }

    on($('#export-code'), 'click', function() {
        openModal(exportModal);
        handleExport();
    });

    on($('#remove-changelog'), 'change', function() {
        handleExport();
    });

    // Tab functionality
    $all('.tab-btn').forEach(function(btn) {
        on(btn, 'click', function() {
            var tab = btn.getAttribute('data-tab');
            $all('.tab-btn').forEach(function(b) {
                b.classList.toggle('active', b === btn);
            });
            $all('.tab-panel').forEach(function(p) {
                p.classList.toggle('active', p.getAttribute('data-tab') === tab);
            });
        });
    });

    // Copy functionality
    $all('[data-copy-target]').forEach(function(btn) {
        on(btn, 'click', async function() {
            var target = btn.getAttribute('data-copy-target');
            var ta = document.querySelector(target);
            if (!ta) return;
            var copied = false;
            try {
                await navigator.clipboard.writeText(ta.value);
                copied = true;
            } catch (e) {
                try {
                    ta.focus();
                    ta.select();
                    copied = document.execCommand('copy');
                } catch (_) {}
            }
            if (copied) {
                var old = btn.textContent;
                btn.textContent = 'コピー済み';
                setTimeout(function() {
                    btn.textContent = old || 'コピー';
                }, 1200);
            }
        });
    });

    // Re-bind accordion headers after DOM swaps
    function bindAccordionHeaders(container) {
        var scope = container || document;
        $all('.accordion-header', scope).forEach(function(header) {
            header.removeEventListener('click', headerClickHandler);
            header.addEventListener('click', headerClickHandler);
        });
    }

    function headerClickHandler() {
        this.classList.toggle('active');
        var content = this.nextElementSibling;
        if (!content) return;
        if (content.style.maxHeight) {
            content.style.maxHeight = null;
            content.style.padding = '0 20px';
        } else {
            content.style.maxHeight = content.scrollHeight + 40 + 'px';
            content.style.padding = '20px';
        }
    }

    // Initialize accordion headers
    bindAccordionHeaders();

    // デバッグ用：アコーディオンヘッダーのクリックを確認
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('accordion-header')) {
            console.log('Accordion header clicked:', e.target);
            // 手動でアコーディオンを操作
            e.target.classList.toggle('active');
            const content = e.target.nextElementSibling;
            if (content && content.classList.contains('accordion-content')) {
                if (content.style.maxHeight) {
                    content.style.maxHeight = null;
                    content.style.padding = '0 20px';
                } else {
                    content.style.maxHeight = content.scrollHeight + 40 + 'px';
                    content.style.padding = '20px';
                }
            }
        }
    });

    // Track edits from contenteditable inputs
    var debouncedInputTimer = null;
    on(document, 'input', function(e) {
        var editable = e.target && e.target.closest && e.target.closest('[contenteditable="true"]');
        if (!editable) return;
        markDirtyFromNode(editable);
        if (debouncedInputTimer) clearTimeout(debouncedInputTimer);
        debouncedInputTimer = setTimeout(function() {
            pushHistoryIfChanged('typing');
        }, 500);
    });

    // Undo/Redo buttons
    on($('#undo-action'), 'click', function() {
        undoOnce();
    });
    on($('#redo-action'), 'click', function() {
        redoOnce();
    });

    // Keyboard shortcuts for undo/redo
    on(document, 'keydown', function(e) {
        if (!(e.ctrlKey || e.metaKey) || !editMode) return;

        var key = (e.key || '').toLowerCase();
        var target = e.target;
        var isEditable = target && (
            target.isContentEditable ||
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA'
        );

        if (isEditable && target.tagName !== 'DIV' && target.tagName !== 'SECTION') {
            return;
        }

        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undoOnce();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
            e.preventDefault();
            redoOnce();
        }
    });

    // Auto-save functionality
    setInterval(function() {
        if (editMode && dirtySectionIdSet.size > 0) {
            pushHistoryIfChanged('auto-save');
        }
    }, 30000);
});